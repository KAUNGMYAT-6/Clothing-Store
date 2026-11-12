const express = require('express');
const Stripe = require('stripe');
const pool = require('../db/pool');
const { getOrCreateCart, getCartItems } = require('../lib/cart');
const { requireLogin } = require('../middleware/auth');
const { SHIPPING_FEE, CURRENCY } = require('../lib/config');
const {
  MAX_ADDRESSES, readAddressForm, formatAddress, listAddresses, getAddress,
  countAddresses, createAddress
} = require('../lib/addresses');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const router = express.Router();

// ============================================================
// Load the cart and check it can be bought.
// ------------------------------------------------------------
// Used by the page and by the submit, so both apply the same
// rules. Returns null after redirecting if the cart isn't ready.
// ============================================================
async function loadCheckoutCart(req, res) {
  const cart = await getOrCreateCart(req);
  const items = await getCartItems(cart.id);

  if (items.length === 0) {
    req.flash('info', 'Your cart is empty.');
    res.redirect('/cart');
    return null;
  }

  const unavailable = items.filter(i => i.stock_quantity < i.quantity);
  if (unavailable.length) {
    req.flash('warning',
      `${unavailable[0].name} doesn't have enough stock any more. Please update your cart.`);
    res.redirect('/cart');
    return null;
  }

  // Prices come from the database, never from the browser
  const subtotal = items.reduce(
    (sum, i) => sum + Number(i.current_price) * i.quantity, 0
  );

  return { items, subtotal, total: subtotal + SHIPPING_FEE };
}

// ============================================================
// Draw the checkout page.
// ------------------------------------------------------------
// Also used when the submitted form has a problem, so the page
// comes back with what they typed instead of an empty form.
// ============================================================
async function renderCheckout(req, res, checkout, form = {}) {
  const user = req.session.user;
  const addresses = await listAddresses(user.id);

  // Saved addresses are listed default-first, so the default is
  // pre-selected. With none saved, the new-address form is the only option.
  const selected = form.selected || (addresses.length ? String(addresses[0].id) : 'new');

  res.status(form.error ? 400 : 200).render('checkout/index', {
    title: 'Checkout',
    items: checkout.items,
    subtotal: checkout.subtotal,
    shippingFee: SHIPPING_FEE,
    total: checkout.total,
    addresses,
    selected,
    formatAddress,
    canSaveAddress: addresses.length < MAX_ADDRESSES,
    email: form.email !== undefined ? form.email : user.email,
    values: form.values || { recipient_name: user.name },
    saveAddress: form.saveAddress !== undefined ? form.saveAddress : true,
    error: form.error || null
  });
}

// --- Checkout page (login required) ---
router.get('/checkout', requireLogin, async (req, res) => {
  try {
    const checkout = await loadCheckoutCart(req, res);
    if (!checkout) return;

    await renderCheckout(req, res, checkout);
  } catch (err) {
    console.error(err);
    res.status(500).render('errors/500', { title: 'Something went wrong' });
  }
});

// --- Create the order and hand off to Stripe (login required) ---
router.post('/checkout/session', requireLogin, async (req, res) => {
  const userId = req.session.user.id;
  const email = String(req.body.email || '').trim().toLowerCase();
  const choice = String(req.body.address_id || 'new');
  const saveAddress = req.body.save_address === 'on';

  let checkout;
  try {
    checkout = await loadCheckoutCart(req, res);
    if (!checkout) return;
  } catch (err) {
    console.error(err);
    return res.status(500).render('errors/500', { title: 'Something went wrong' });
  }

  // ----- Work out where it's going, before touching the database -----
  let shippingName;
  let shippingAddress;
  let addressToSave = null;

  try {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return await renderCheckout(req, res, checkout, {
        email, selected: choice, saveAddress,
        values: readAddressForm(req.body).values,
        error: "That email address doesn't look right."
      });
    }

    if (choice !== 'new') {
      // A saved address. The id came from the browser, so look it up
      // scoped to this user — someone else's address id finds nothing.
      const addressId = Number(choice);
      const address = Number.isInteger(addressId) && await getAddress(userId, addressId);
      if (!address) {
        return await renderCheckout(req, res, checkout, {
          email, error: 'Please choose a delivery address.'
        });
      }
      shippingName = address.recipient_name;
      shippingAddress = formatAddress(address);
    } else {
      const { values, error } = readAddressForm(req.body);
      if (error) {
        return await renderCheckout(req, res, checkout, {
          email, selected: 'new', values, saveAddress, error
        });
      }
      shippingName = values.recipient_name;
      shippingAddress = formatAddress(values);
      if (saveAddress) addressToSave = values;
    }
  } catch (err) {
    console.error(err);
    return res.status(500).render('errors/500', { title: 'Something went wrong' });
  }

  // ----- Write the order, then hand off to Stripe -----
  const { items, subtotal, total } = checkout;
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [orderResult] = await connection.query(`
      INSERT INTO orders
        (user_id, email, status, subtotal, shipping_fee, total,
         shipping_name, shipping_address)
      VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)
    `, [userId, email, subtotal, SHIPPING_FEE, total, shippingName, shippingAddress]);

    const orderId = orderResult.insertId;

    for (const item of items) {
      await connection.query(`
        INSERT INTO order_items
          (order_id, variant_id, product_name, size, color, unit_price, quantity)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [
        orderId, item.variant_id, item.name,
        item.size, item.color, item.current_price, item.quantity
      ]);
    }

    // Save the new address in the same transaction as the order.
    // Over the limit, skip quietly — the order matters more.
    if (addressToSave && await countAddresses(connection, userId) < MAX_ADDRESSES) {
      await createAddress(connection, userId, addressToSave);
    }

    await connection.commit();

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: email,
      line_items: [
        ...items.map(item => ({
          price_data: {
            currency: CURRENCY,
            product_data: { name: `${item.name} (${item.color}, ${item.size})` },
            unit_amount: Math.round(Number(item.current_price) * 100)
          },
          quantity: item.quantity
        })),
        {
          price_data: {
            currency: CURRENCY,
            product_data: { name: 'Delivery' },
            unit_amount: Math.round(SHIPPING_FEE * 100)
          },
          quantity: 1
        }
      ],
      metadata: { order_id: String(orderId) },
      success_url: `${process.env.BASE_URL}/order/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.BASE_URL}/checkout`
    });

    await pool.query(
      'UPDATE orders SET stripe_session_id = ? WHERE id = ?',
      [session.id, orderId]
    );

    res.redirect(303, session.url);
  } catch (err) {
    await connection.rollback();
    console.error(err);
    req.flash('error', 'We could not start checkout. No payment was taken. Please try again.');
    res.redirect('/checkout');
  } finally {
    connection.release();
  }
});

// --- Success page (no login gate: the session_id is the key) ---
router.get('/order/success', async (req, res) => {
  const { session_id } = req.query;

  try {
    if (!session_id) return res.redirect('/');

    const [orders] = await pool.query(
      'SELECT * FROM orders WHERE stripe_session_id = ?',
      [session_id]
    );
    const order = orders[0];

    if (!order) return res.redirect('/');

    const [items] = await pool.query(
      'SELECT * FROM order_items WHERE order_id = ?',
      [order.id]
    );

    res.render('checkout/success', {
      title: 'Order confirmed',
      order,
      items
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('errors/500', { title: 'Something went wrong' });
  }
});

module.exports = router;
