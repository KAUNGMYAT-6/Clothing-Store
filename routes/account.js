const express = require('express');
const pool = require('../db/pool');
const { requireLogin } = require('../middleware/auth');
const bcrypt = require('bcrypt');
const { upload, uploadToCloudinary, deleteFromCloudinary } = require('../lib/upload');
const {
  MAX_ADDRESSES, readAddressForm, formatAddress, listAddresses, getAddress,
  countAddresses, setDefault, createAddress, updateAddress, deleteAddress
} = require('../lib/addresses');

const router = express.Router();

// Every route below needs a logged-in user
router.use(requireLogin);

const ORDERS_PER_PAGE = 10;

// How an order's status reads to a customer
const STATUS_LABELS = {
  pending:   'Awaiting payment',
  paid:      'Paid',
  shipped:   'On its way',
  delivered: 'Delivered',
  cancelled: 'Cancelled'
};

// The normal happy path, in order. Used to draw the progress line.
const STATUS_FLOW = ['paid', 'shipped', 'delivered'];

router.get('/', (req, res) => res.redirect('/account/orders'));

// ============================================================
// ORDER HISTORY
// ============================================================
router.get('/orders', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const offset = (page - 1) * ORDERS_PER_PAGE;

    const [[{ total }]] = await pool.query(
      'SELECT COUNT(*) AS total FROM orders WHERE user_id = ?',
      [req.session.user.id]
    );

    const [orders] = await pool.query(`
      SELECT
        o.id,
        o.status,
        o.total,
        o.created_at,
        (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_count,
        (SELECT SUM(oi.quantity) FROM order_items oi WHERE oi.order_id = o.id) AS unit_count,
        -- First image of the first item, for the thumbnail.
        -- Returns NULL harmlessly if the product has since been removed.
        (SELECT pi.image_url
           FROM order_items oi
           JOIN product_variants pv ON pv.id = oi.variant_id
           JOIN product_images   pi ON pi.product_id = pv.product_id
          WHERE oi.order_id = o.id
          ORDER BY pi.is_primary DESC, pi.sort_order ASC, pi.id ASC
          LIMIT 1) AS thumb
      FROM orders o
      WHERE o.user_id = ?
      ORDER BY o.created_at DESC
      LIMIT ? OFFSET ?
    `, [req.session.user.id, ORDERS_PER_PAGE, offset]);

    res.render('account/orders', {
      title: 'My orders',
      active: 'orders',
      orders,
      statusLabels: STATUS_LABELS,
      pagination: {
        currentPage: page,
        totalPages: Math.max(1, Math.ceil(total / ORDERS_PER_PAGE)),
        total
      }
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// ONE ORDER
// ============================================================
router.get('/orders/:id', async (req, res, next) => {
  try {
    const orderId = parseInt(req.params.id, 10);
    if (!Number.isInteger(orderId)) {
      return res.status(404).render('errors/404', { title: 'Order not found' });
    }

    // AND user_id = ? is the whole security story here.
    // Without it, changing the number in the URL would show
    // somebody else's order — that's an IDOR vulnerability.
    const [[order]] = await pool.query(
      'SELECT * FROM orders WHERE id = ? AND user_id = ?',
      [orderId, req.session.user.id]
    );

    if (!order) {
      return res.status(404).render('errors/404', { title: 'Order not found' });
    }

    const [items] = await pool.query(`
      SELECT
        oi.*,
        p.slug AS product_slug,
        (SELECT pi.image_url
           FROM product_images pi
          WHERE pi.product_id = p.id
          ORDER BY pi.is_primary DESC, pi.sort_order ASC, pi.id ASC
          LIMIT 1) AS image_url
      FROM order_items oi
      LEFT JOIN product_variants pv ON pv.id = oi.variant_id
      LEFT JOIN products         p  ON p.id  = pv.product_id
      WHERE oi.order_id = ?
      ORDER BY oi.id
    `, [orderId]);

    res.render('account/order-detail', {
      title: `Order #${order.id}`,
      active: 'orders',
      order,
      items,
      statusLabels: STATUS_LABELS,
      statusFlow: STATUS_FLOW
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// SETTINGS PAGE
// ============================================================
router.get('/settings', async (req, res, next) => {
  try {
    const [[account]] = await pool.query(
      `SELECT id, name, email, profile_photo_url, password_hash, created_at
         FROM users WHERE id = ?`,
      [req.session.user.id]
    );

    res.render('account/settings', {
      title: 'Settings',
      active: 'settings',
      account,
      // Google sign-ups have no password yet — they get "set a
      // password" instead of "change password"
      hasPassword: Boolean(account.password_hash)
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// NAME AND EMAIL
// ============================================================
router.post('/settings/profile', async (req, res, next) => {
  try {
    const name = (req.body.name || '').trim();
    const email = (req.body.email || '').trim().toLowerCase();

    if (name.length < 2 || name.length > 100) {
      req.flash('error', 'Your name needs to be between 2 and 100 characters.');
      return res.redirect('/account/settings');
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      req.flash('error', "That doesn't look like an email address.");
      return res.redirect('/account/settings');
    }

    // Someone else using it? "AND id != ?" so saving without
    // changing your email doesn't collide with yourself
    const [[taken]] = await pool.query(
      'SELECT id FROM users WHERE email = ? AND id != ?',
      [email, req.session.user.id]
    );
    if (taken) {
      req.flash('error', 'That email is already registered to another account.');
      return res.redirect('/account/settings');
    }

    await pool.query(
      'UPDATE users SET name = ?, email = ? WHERE id = ?',
      [name, email, req.session.user.id]
    );

    // The session holds its own copy, so it has to be updated too
    req.session.user.name = name;
    req.session.user.email = email;

    // save() before redirect, or the next page can render from a
    // session that hasn't been written yet
    req.session.save(() => {
      req.flash('success', 'Details updated.');
      res.redirect('/account/settings');
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// PASSWORD
// ============================================================
router.post('/settings/password', async (req, res, next) => {
  try {
    const { current_password, new_password, confirm_password } = req.body;

    const [[account]] = await pool.query(
      'SELECT password_hash FROM users WHERE id = ?',
      [req.session.user.id]
    );

    // Only ask for the current password if they actually have one
    if (account.password_hash) {
      const ok = await bcrypt.compare(current_password || '', account.password_hash);
      if (!ok) {
        req.flash('error', 'Your current password is incorrect.');
        return res.redirect('/account/settings');
      }
    }

    if (!new_password || new_password.length < 8) {
      req.flash('error', 'Your new password must be at least 8 characters.');
      return res.redirect('/account/settings');
    }

    if (new_password !== confirm_password) {
      req.flash('error', 'The two new passwords do not match.');
      return res.redirect('/account/settings');
    }

    const hash = await bcrypt.hash(new_password, 12);
    await pool.query('UPDATE users SET password_hash = ? WHERE id = ?',
      [hash, req.session.user.id]);

    req.flash('success', account.password_hash ? 'Password changed.' : 'Password set.');
    res.redirect('/account/settings');
  } catch (err) {
    next(err);
  }
});

// ============================================================
// PROFILE PHOTO
// ============================================================
router.post('/settings/photo', upload.single('photo'), async (req, res, next) => {
  try {
    if (!req.file) {
      req.flash('error', 'Choose an image first.');
      return res.redirect('/account/settings');
    }

    const [[account]] = await pool.query(
      'SELECT profile_photo_id FROM users WHERE id = ?',
      [req.session.user.id]
    );

    const result = await uploadToCloudinary(req.file.buffer, {
      folder: 'denise/avatars',
      transformation: [{ width: 400, height: 400, crop: 'fill', gravity: 'face' }]
    });

    await pool.query(
      'UPDATE users SET profile_photo_url = ?, profile_photo_id = ? WHERE id = ?',
      [result.secure_url, result.public_id, req.session.user.id]
    );

    // Bin the old one so Cloudinary doesn't fill with orphans.
    // After the database update, so a failure here can't lose the new photo.
    if (account.profile_photo_id) {
      try {
        await deleteFromCloudinary(account.profile_photo_id);
      } catch (e) {
        console.error('Could not delete old avatar:', e.message);
      }
    }

    req.session.user.profile_photo_url = result.secure_url;
    req.session.save(() => {
      req.flash('success', 'Photo updated.');
      res.redirect('/account/settings');
    });
  } catch (err) {
    next(err);
  }
});

router.post('/settings/photo/delete', async (req, res, next) => {
  try {
    const [[account]] = await pool.query(
      'SELECT profile_photo_id FROM users WHERE id = ?',
      [req.session.user.id]
    );

    await pool.query(
      'UPDATE users SET profile_photo_url = NULL, profile_photo_id = NULL WHERE id = ?',
      [req.session.user.id]
    );

    if (account.profile_photo_id) {
      try { await deleteFromCloudinary(account.profile_photo_id); }
      catch (e) { console.error('Could not delete avatar:', e.message); }
    }

    req.session.user.profile_photo_url = null;
    req.session.save(() => {
      req.flash('success', 'Photo removed.');
      res.redirect('/account/settings');
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// DELETE ACCOUNT
// ------------------------------------------------------------
// The user row goes. What happens to everything pointing at it
// was decided in the schema:
//   addresses  CASCADE   — go with them
//   reviews    CASCADE   — they carry the author's name
//   orders     SET NULL  — financial records, must survive
// ============================================================
router.post('/delete', async (req, res, next) => {
  try {
    const [[account]] = await pool.query(
      'SELECT password_hash, profile_photo_id FROM users WHERE id = ?',
      [req.session.user.id]
    );

    if (account.password_hash) {
      const ok = await bcrypt.compare(req.body.password || '', account.password_hash);
      if (!ok) {
        req.flash('error', 'Password incorrect. Your account has not been deleted.');
        return res.redirect('/account/settings');
      }
    } else if ((req.body.confirm || '').trim() !== 'DELETE') {
      req.flash('error', 'Type DELETE to confirm.');
      return res.redirect('/account/settings');
    }

    await pool.query('DELETE FROM users WHERE id = ?', [req.session.user.id]);

    if (account.profile_photo_id) {
      try { await deleteFromCloudinary(account.profile_photo_id); }
      catch (e) { console.error('Could not delete avatar:', e.message); }
    }

    req.session.destroy(() => res.redirect('/?deleted=1'));
  } catch (err) {
    next(err);
  }
});

// ============================================================
// ADDRESS BOOK
// ============================================================

// Turns "/addresses/12/edit" into 12, or null for anything that
// isn't a plain whole number
function addressIdFrom(req) {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function renderAddressForm(res, { status = 200, address = null, values = {}, error = null }) {
  res.status(status).render('account/address-form', {
    title: address ? 'Edit address' : 'New address',
    active: 'addresses',
    address,
    values,
    error
  });
}

router.get('/addresses', async (req, res, next) => {
  try {
    const addresses = await listAddresses(req.session.user.id);
    res.render('account/addresses', {
      title: 'Addresses',
      active: 'addresses',
      addresses,
      max: MAX_ADDRESSES,
      formatAddress
    });
  } catch (err) {
    next(err);
  }
});

router.get('/addresses/new', async (req, res, next) => {
  try {
    if (await countAddresses(pool, req.session.user.id) >= MAX_ADDRESSES) {
      req.flash('warning', `You can save up to ${MAX_ADDRESSES} addresses. Delete one to add another.`);
      return res.redirect('/account/addresses');
    }
    // Most people are adding their own address, so start with their name
    renderAddressForm(res, { values: { recipient_name: req.session.user.name } });
  } catch (err) {
    next(err);
  }
});

router.post('/addresses', async (req, res, next) => {
  try {
    const userId = req.session.user.id;

    if (await countAddresses(pool, userId) >= MAX_ADDRESSES) {
      req.flash('warning', `You can save up to ${MAX_ADDRESSES} addresses. Delete one to add another.`);
      return res.redirect('/account/addresses');
    }

    const { values, error } = readAddressForm(req.body);
    if (error) return renderAddressForm(res, { status: 400, values, error });

    await createAddress(pool, userId, values, req.body.is_default === 'on');

    req.flash('success', 'Address saved.');
    res.redirect('/account/addresses');
  } catch (err) {
    next(err);
  }
});

router.get('/addresses/:id/edit', async (req, res, next) => {
  try {
    const id = addressIdFrom(req);
    const address = id && await getAddress(req.session.user.id, id);
    if (!address) return res.status(404).render('errors/404', { title: 'Address not found' });

    renderAddressForm(res, { address, values: address });
  } catch (err) {
    next(err);
  }
});

router.post('/addresses/:id', async (req, res, next) => {
  try {
    const userId = req.session.user.id;
    const id = addressIdFrom(req);
    const address = id && await getAddress(userId, id);
    if (!address) return res.status(404).render('errors/404', { title: 'Address not found' });

    const { values, error } = readAddressForm(req.body);
    if (error) return renderAddressForm(res, { status: 400, address, values, error });

    await updateAddress(userId, id, values);
    if (req.body.is_default === 'on') await setDefault(pool, userId, id);

    req.flash('success', 'Address updated.');
    res.redirect('/account/addresses');
  } catch (err) {
    next(err);
  }
});

router.post('/addresses/:id/default', async (req, res, next) => {
  try {
    const userId = req.session.user.id;
    const id = addressIdFrom(req);
    const address = id && await getAddress(userId, id);
    if (!address) return res.status(404).render('errors/404', { title: 'Address not found' });

    await setDefault(pool, userId, id);

    req.flash('success', 'Default address changed.');
    res.redirect('/account/addresses');
  } catch (err) {
    next(err);
  }
});

router.post('/addresses/:id/delete', async (req, res, next) => {
  try {
    const id = addressIdFrom(req);
    const deleted = id && await deleteAddress(req.session.user.id, id);
    if (!deleted) return res.status(404).render('errors/404', { title: 'Address not found' });

    req.flash('success', 'Address deleted.');
    res.redirect('/account/addresses');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
