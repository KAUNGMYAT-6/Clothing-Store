const express = require('express');
const pool = require('../db/pool');
const { requireAdmin } = require('../middleware/auth');
const { upload, uploadToCloudinary, deleteFromCloudinary } = require('../lib/upload');
const { SIZE_SUGGESTIONS, readVariant, sameVariant, insertVariant } = require('../lib/variants');

const router = express.Router();

// Everything in this file is admin-only
router.use(requireAdmin);

// Pending count for the sidebar badge, on every admin page
router.use(async (req, res, next) => {
  try {
    const [[row]] = await pool.query(
      "SELECT COUNT(*) AS n FROM orders WHERE status = 'pending'"
    );
    res.locals.pendingCount = row.n;
  } catch (err) {
    res.locals.pendingCount = 0;
  }
  next();
});

// ============================================================
// Dashboard
// ============================================================
router.get('/', async (req, res) => {
  try {
    const [[stats]] = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM orders WHERE status = 'paid')      AS paid_orders,
        (SELECT COUNT(*) FROM orders WHERE status = 'pending')   AS pending_orders,
        (SELECT COALESCE(SUM(total), 0) FROM orders WHERE status NOT IN ('pending', 'cancelled')) AS revenue,
        (SELECT COUNT(*) FROM products WHERE is_active = TRUE)   AS active_products,
        (SELECT COUNT(*) FROM product_variants WHERE stock_quantity = 0) AS out_of_stock
    `);

    const [recent] = await pool.query(`
      SELECT id, email, status, total, created_at
      FROM orders
      ORDER BY created_at DESC
      LIMIT 6
    `);

    // DATE_FORMAT hands the day back as plain text ('2026-11-12').
    // A DATE column would arrive as a JavaScript Date, and converting
    // that with toISOString() shifts it into UTC — in Singapore (UTC+8)
    // that moved every sale onto the previous day's bar.
    const [rows] = await pool.query(`
      SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS day,
             COALESCE(SUM(total), 0) AS revenue
      FROM orders
      WHERE status NOT IN ('pending', 'cancelled')
        AND created_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
      GROUP BY day
    `);

    const byDay = {};
    rows.forEach(r => { byDay[r.day] = Number(r.revenue); });

    // The seven days themselves also come from the database, so "today"
    // means the same thing in both queries
    const [days] = await pool.query(`
      SELECT DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL n DAY), '%Y-%m-%d') AS day,
             DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL n DAY), '%a')       AS label
      FROM (SELECT 6 AS n UNION SELECT 5 UNION SELECT 4 UNION SELECT 3
            UNION SELECT 2 UNION SELECT 1 UNION SELECT 0) AS offsets
      ORDER BY n DESC
    `);

    // GROUP BY only returns days that have orders, so fill the gaps
    const chart = days.map(d => ({
      label: d.label,
      revenue: byDay[d.day] || 0
    }));

    const [lowStock] = await pool.query(`
      SELECT v.id, v.size, v.color, v.stock_quantity,
             p.id AS product_id, p.name
      FROM product_variants v
      JOIN products p ON p.id = v.product_id
      WHERE p.is_active = TRUE AND v.stock_quantity <= 3
      ORDER BY v.stock_quantity ASC, p.name
      LIMIT 6
    `);

    res.render('admin/dashboard', {
      title: 'Dashboard',
      active: 'dashboard',
      today: new Date().toLocaleDateString('en-SG', {
        weekday: 'long', day: 'numeric', month: 'long'
      }),
      stats, recent, chart, lowStock
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('errors/500', { title: 'Something went wrong' });
  }
});

// ============================================================
// Orders
// ============================================================
router.get('/orders', async (req, res) => {
  try {
    const { status } = req.query;

    const conditions = [];
    const params = [];
    if (status) {
      conditions.push('o.status = ?');
      params.push(status);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [orders] = await pool.query(`
      SELECT o.*, COUNT(oi.id) AS item_count
      FROM orders o
      LEFT JOIN order_items oi ON oi.order_id = o.id
      ${where}
      GROUP BY o.id
      ORDER BY o.created_at DESC
    `, params);

    res.render('admin/orders', {
      title: 'Orders',
      active: 'orders',
      orders,
      filters: { status }
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('errors/500', { title: 'Something went wrong' });
  }
});

router.get('/orders/:id', async (req, res) => {
  try {
    const [[order]] = await pool.query('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    if (!order) {
      return res.status(404).render('errors/404', { title: 'Order not found' });
    }

    const [items] = await pool.query(
      'SELECT * FROM order_items WHERE order_id = ?',
      [order.id]
    );

    res.render('admin/order-detail', {
      title: `Order #${order.id}`,
      active: 'orders',
      order, items
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('errors/500', { title: 'Something went wrong' });
  }
});

router.post('/orders/:id/status', async (req, res) => {
  const allowed = ['pending', 'paid', 'shipped', 'delivered', 'cancelled'];
  const { status } = req.body;

  try {
    // Whitelist: never pass user input straight into an UPDATE
    if (!allowed.includes(status)) {
      req.flash('error', 'That is not a valid order status.');
      return res.redirect(`/admin/orders/${req.params.id}`);
    }

    await pool.query('UPDATE orders SET status = ? WHERE id = ?', [status, req.params.id]);
    req.flash('success', `Order #${req.params.id} marked as ${status}.`);
    res.redirect(`/admin/orders/${req.params.id}`);
  } catch (err) {
    console.error(err);
    req.flash('error', 'Could not update the order status.');
    res.redirect(`/admin/orders/${req.params.id}`);
  }
});

// ============================================================
// Products
// ============================================================
router.get('/products', async (req, res) => {
  try {
    const [products] = await pool.query(`
      SELECT p.*, c.name AS category,
             COUNT(DISTINCT v.id) AS variant_count,
             COALESCE(SUM(v.stock_quantity), 0) AS total_stock
      FROM products p
      JOIN categories c ON c.id = p.category_id
      LEFT JOIN product_variants v ON v.product_id = p.id
      GROUP BY p.id
      ORDER BY p.created_at DESC
    `);

    res.render('admin/products', {
      title: 'Products',
      active: 'products',
      products
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('errors/500', { title: 'Something went wrong' });
  }
});

// ============================================================
// New product
// ============================================================

// Colours already used in the shop, offered as suggestions so the
// same colour gets the same spelling everywhere
async function colourSuggestions() {
  const [rows] = await pool.query(
    'SELECT DISTINCT color FROM product_variants ORDER BY color LIMIT 60'
  );
  return rows.map(r => r.color);
}

async function renderNewProduct(res, { status = 200, product = null, error = null, rows = [] }) {
  const [categories] = await pool.query('SELECT id, name FROM categories ORDER BY name');

  // Always offer at least three rows to fill in
  const variantRows = rows.slice();
  while (variantRows.length < 3) variantRows.push({ color: '', size: '', stock: '' });

  res.status(status).render('admin/product-form', {
    title: 'New product',
    active: 'products',
    product,
    categories,
    error,
    variantRows,
    sizeSuggestions: SIZE_SUGGESTIONS,
    colourSuggestions: await colourSuggestions()
  });
}

// ------------------------------------------------------------
// Read the size/colour/stock rows from the new-product form.
// Each row arrives as three repeated fields; one row arrives as
// plain strings and several as arrays, so [].concat() evens that out.
// Completely empty rows are skipped.
// ------------------------------------------------------------
function readVariantRows(body) {
  const colours = [].concat(body.variant_color ?? []);
  const sizes   = [].concat(body.variant_size ?? []);
  const stocks  = [].concat(body.variant_stock ?? []);
  const count = Math.max(colours.length, sizes.length, stocks.length);

  const rows = [];       // exactly what was typed, to refill the form
  const variants = [];   // cleaned and checked, to save

  for (let i = 0; i < count; i++) {
    const raw = { color: colours[i] || '', size: sizes[i] || '', stock: stocks[i] || '' };
    rows.push(raw);

    const blank = !raw.color.trim() && !raw.size.trim() && (raw.stock.trim() === '' || raw.stock.trim() === '0');
    if (blank) continue;

    const { values, error } = readVariant(raw);
    if (error) return { rows, variants, error: `Row ${i + 1}: ${error}` };

    if (variants.some(v => sameVariant(v, values))) {
      return { rows, variants, error: `${values.color} · ${values.size} is listed twice.` };
    }
    variants.push(values);
  }

  return { rows, variants, error: null };
}

router.get('/products/new', async (req, res) => {
  try {
    await renderNewProduct(res, {});
  } catch (err) {
    console.error(err);
    res.status(500).render('errors/500', { title: 'Something went wrong' });
  }
});

router.post('/products', upload.single('image'), async (req, res) => {
  const { name, slug, description, price, category_id, department } = req.body;

  // Check everything BEFORE uploading an image or borrowing a connection
  const { rows, variants, error: variantError } = readVariantRows(req.body);

  if (!name || !slug || !price || !category_id) {
    return renderNewProduct(res, {
      status: 400, product: req.body, rows,
      error: 'Name, slug, price and category are all required.'
    });
  }
  if (variantError) {
    return renderNewProduct(res, { status: 400, product: req.body, rows, error: variantError });
  }

  const connection = await pool.getConnection();
  try {
    // Upload before the transaction: a slow network call shouldn't hold
    // a database lock open
    let imageUrl = null;
    let cloudinaryId = null;
    if (req.file) {
      const result = await uploadToCloudinary(req.file.buffer);
      imageUrl = result.secure_url;
      cloudinaryId = result.public_id;
    }

    // Product, image and every variant go in together or not at all
    await connection.beginTransaction();

    const [result] = await connection.query(`
      INSERT INTO products (name, slug, description, price, category_id, department)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [name, slug, description || null, price, category_id, department || 'unisex']);

    const productId = result.insertId;

    // The first image is always the main one
    if (imageUrl) {
      await connection.query(`
        INSERT INTO product_images
          (product_id, image_url, cloudinary_id, alt_text, sort_order, is_primary)
        VALUES (?, ?, ?, ?, 0, TRUE)
      `, [productId, imageUrl, cloudinaryId, name]);
    }

    for (const v of variants) {
      await insertVariant(connection, productId, v);
    }

    await connection.commit();

    const totalStock = variants.reduce((sum, v) => sum + v.stock, 0);
    req.flash('success', variants.length
      ? `"${name}" created with ${variants.length} variant${variants.length === 1 ? '' : 's'} (${totalStock} in stock).`
      : `"${name}" created. Add sizes and colours so it can be bought.`);
    res.redirect(`/admin/products/${productId}/edit`);
  } catch (err) {
    await connection.rollback();
    console.error(err);
    await renderNewProduct(res, {
      status: 400, product: req.body, rows,
      error: err.code === 'ER_DUP_ENTRY'
        ? 'That slug is already in use. Try a different one.'
        : 'Could not create the product. Check the details and try again.'
    });
  } finally {
    connection.release();
  }
});

router.get('/products/:id/edit', async (req, res) => {
  try {
    const [[product]] = await pool.query('SELECT * FROM products WHERE id = ?', [req.params.id]);
    if (!product) {
      return res.status(404).render('errors/404', { title: 'Product not found' });
    }

    const [categories] = await pool.query('SELECT id, name FROM categories ORDER BY name');
    // FIELD() puts letter sizes in wearing order (XS before S before M).
    // Sizes not in the list get 0 and go last, then sort normally.
    const [variants] = await pool.query(`
      SELECT * FROM product_variants
      WHERE product_id = ?
      ORDER BY color, FIELD(size, 'XXL', 'XL', 'L', 'M', 'S', 'XS') DESC, size
    `, [product.id]);
    const [images] = await pool.query(
      `SELECT * FROM product_images
       WHERE product_id = ?
       ORDER BY is_primary DESC, sort_order ASC, id ASC`,
      [product.id]
    );
    const [reviews] = await pool.query(`
      SELECT r.id, r.rating, r.body, r.created_at, u.name AS author
      FROM reviews r
      JOIN users u ON u.id = r.user_id
      WHERE r.product_id = ?
      ORDER BY r.created_at DESC
    `, [product.id]);

    res.render('admin/product-edit', {
      title: `Edit ${product.name}`,
      active: 'products',
      product, categories, variants, images, reviews, error: null,
      sizeSuggestions: SIZE_SUGGESTIONS,
      colourSuggestions: await colourSuggestions()
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('errors/500', { title: 'Something went wrong' });
  }
});

router.post('/products/:id', async (req, res) => {
  const { name, slug, description, price, category_id, department, is_active } = req.body;

  try {
    await pool.query(`
      UPDATE products
      SET name = ?, slug = ?, description = ?, price = ?,
          category_id = ?, department = ?, is_active = ?
      WHERE id = ?
    `, [
      name, slug, description || null, price, category_id,
      department || 'unisex', is_active === 'on' ? 1 : 0,
      req.params.id
    ]);

    req.flash('success', 'Product saved.');
    res.redirect(`/admin/products/${req.params.id}/edit`);
  } catch (err) {
    console.error(err);
    req.flash('error', err.code === 'ER_DUP_ENTRY'
      ? 'That slug is already used by another product.'
      : 'Could not save the product.');
    res.redirect(`/admin/products/${req.params.id}/edit`);
  }
});

// ============================================================
// Variants
// ============================================================
router.post('/products/:id/variants', async (req, res) => {
  const productId = Number(req.params.id);
  const back = `/admin/products/${productId}/edit`;

  try {
    const [[product]] = await pool.query('SELECT id FROM products WHERE id = ?', [productId]);
    if (!product) return res.status(404).render('errors/404', { title: 'Product not found' });

    const { values, error } = readVariant({
      color: req.body.color, size: req.body.size, stock: req.body.stock_quantity
    });
    if (error) {
      req.flash('warning', error);
      return res.redirect(back);
    }

    // Each problem gets its own message. The old version said "that
    // size and colour exists, or that SKU is taken", so you couldn't
    // tell which one to fix.
    const [[existing]] = await pool.query(`
      SELECT color, size FROM product_variants
      WHERE product_id = ? AND LOWER(color) = LOWER(?) AND LOWER(size) = LOWER(?)
    `, [productId, values.color, values.size]);
    if (existing) {
      req.flash('warning',
        `${existing.color} · ${existing.size} is already on this product. Change its stock in the table instead.`);
      return res.redirect(back);
    }

    // SKU is optional now. Blank means "make one for me".
    const typedSku = String(req.body.sku || '').trim();
    if (typedSku.length > 64) {
      req.flash('warning', 'SKU can be at most 64 characters.');
      return res.redirect(back);
    }
    if (typedSku) {
      const [[owner]] = await pool.query(`
        SELECT p.name FROM product_variants v
        JOIN products p ON p.id = v.product_id
        WHERE v.sku = ?
      `, [typedSku]);
      if (owner) {
        req.flash('warning',
          `SKU "${typedSku}" is already used by ${owner.name}. Leave SKU blank and one will be made for you.`);
        return res.redirect(back);
      }
    }

    const sku = await insertVariant(pool, productId, values, typedSku);

    req.flash('success', `Added ${values.color} · ${values.size} with ${values.stock} in stock (SKU ${sku}).`);
    res.redirect(back);
  } catch (err) {
    console.error(err);
    req.flash('error', err.code === 'ER_DATA_TOO_LONG'
      ? 'One of those values is too long for the database.'
      : 'Could not add the variant.');
    res.redirect(back);
  }
});

router.post('/products/:id/variants/:variantId/stock', async (req, res) => {
  const stock = parseInt(req.body.stock_quantity, 10);

  try {
    if (!Number.isInteger(stock) || stock < 0) {
      req.flash('warning', 'Stock must be zero or more.');
      return res.redirect(`/admin/products/${req.params.id}/edit`);
    }

    // AND product_id guards against a tampered variant id
    await pool.query(
      'UPDATE product_variants SET stock_quantity = ? WHERE id = ? AND product_id = ?',
      [stock, req.params.variantId, req.params.id]
    );

    req.flash('success', 'Stock updated.');
    res.redirect(`/admin/products/${req.params.id}/edit`);
  } catch (err) {
    console.error(err);
    req.flash('error', 'Could not update stock.');
    res.redirect(`/admin/products/${req.params.id}/edit`);
  }
});

router.post('/products/:id/variants/:variantId/delete', async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM product_variants WHERE id = ? AND product_id = ?',
      [req.params.variantId, req.params.id]
    );
    req.flash('info', 'Variant deleted.');
    res.redirect(`/admin/products/${req.params.id}/edit`);
  } catch (err) {
    console.error(err);
    req.flash('error', 'Could not delete that variant.');
    res.redirect(`/admin/products/${req.params.id}/edit`);
  }
});

// ============================================================
// Images
// ============================================================
router.post('/products/:id/images', upload.single('image'), async (req, res) => {
  const { alt_text, sort_order, is_primary, image_url } = req.body;
  const productId = req.params.id;

  const connection = await pool.getConnection();
  try {
    let finalUrl = null;
    let cloudinaryId = null;

    if (req.file) {
      // Buffer goes straight to Cloudinary — nothing written to disk,
      // because hosting platforms wipe the filesystem on restart
      const result = await uploadToCloudinary(req.file.buffer);
      finalUrl = result.secure_url;
      cloudinaryId = result.public_id;
    } else if (image_url) {
      finalUrl = image_url;
    } else {
      req.flash('warning', 'Choose a file to upload, or paste an image URL.');
      return res.redirect(`/admin/products/${productId}/edit`);
    }

    await connection.beginTransaction();

    // The first image for a product becomes the main one automatically —
    // nobody should have to remember a checkbox for the obvious case
    const [[existing]] = await connection.query(
      'SELECT COUNT(*) AS n FROM product_images WHERE product_id = ?',
      [productId]
    );
    const makePrimary = is_primary === 'on' || existing.n === 0;

    // Only one image can be primary, so clear the others first
    if (makePrimary) {
      await connection.query(
        'UPDATE product_images SET is_primary = FALSE WHERE product_id = ?',
        [productId]
      );
    }

    await connection.query(`
      INSERT INTO product_images
        (product_id, image_url, cloudinary_id, alt_text, sort_order, is_primary)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [
      productId, finalUrl, cloudinaryId, alt_text || null,
      parseInt(sort_order, 10) || 0, makePrimary ? 1 : 0
    ]);

    await connection.commit();
    req.flash('success', 'Image added.');
    res.redirect(`/admin/products/${productId}/edit`);
  } catch (err) {
    await connection.rollback();
    console.error(err);
    req.flash('error', err.message || 'Could not add the image.');
    res.redirect(`/admin/products/${productId}/edit`);
  } finally {
    connection.release();
  }
});

router.post('/products/:id/images/:imageId/primary', async (req, res) => {
  const productId = req.params.id;

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query(
      'UPDATE product_images SET is_primary = FALSE WHERE product_id = ?',
      [productId]
    );
    await connection.query(
      'UPDATE product_images SET is_primary = TRUE WHERE id = ? AND product_id = ?',
      [req.params.imageId, productId]
    );
    await connection.commit();

    req.flash('success', 'Main image updated.');
    res.redirect(`/admin/products/${productId}/edit`);
  } catch (err) {
    await connection.rollback();
    console.error(err);
    req.flash('error', 'Could not set the main image.');
    res.redirect(`/admin/products/${productId}/edit`);
  } finally {
    connection.release();
  }
});

router.post('/products/:id/images/:imageId/delete', async (req, res) => {
  try {
    const [[img]] = await pool.query(
      'SELECT cloudinary_id, is_primary FROM product_images WHERE id = ? AND product_id = ?',
      [req.params.imageId, req.params.id]
    );

    await pool.query(
      'DELETE FROM product_images WHERE id = ? AND product_id = ?',
      [req.params.imageId, req.params.id]
    );

    // If the main image was deleted, promote whatever's left
    if (img && img.is_primary) {
      await pool.query(`
        UPDATE product_images SET is_primary = TRUE
        WHERE product_id = ?
        ORDER BY sort_order ASC, id ASC
        LIMIT 1
      `, [req.params.id]);
    }

    // Remove the file from Cloudinary too, but don't fail the request if
    // that call errors — the database row is already gone
    if (img && img.cloudinary_id) {
      try {
        await deleteFromCloudinary(img.cloudinary_id);
      } catch (cloudErr) {
        console.error('Cloudinary delete failed:', cloudErr);
      }
    }

    req.flash('info', 'Image deleted.');
    res.redirect(`/admin/products/${req.params.id}/edit`);
  } catch (err) {
    console.error(err);
    req.flash('error', 'Could not delete that image.');
    res.redirect(`/admin/products/${req.params.id}/edit`);
  }
});

// ============================================================
// Review moderation
// ============================================================
router.post('/reviews/:id/delete', async (req, res) => {
  try {
    await pool.query('DELETE FROM reviews WHERE id = ?', [req.params.id]);
    req.flash('info', 'Review removed.');
    res.redirect(req.get('Referer') || '/admin/products');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Could not remove that review.');
    res.redirect(req.get('Referer') || '/admin/products');
  }
});

module.exports = router;