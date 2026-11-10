const express = require('express');
const Stripe = require('stripe');
const pool = require('../db/pool');
const { getOrCreateCart, getCartItems } = require('../lib/cart');
const { requireLogin } = require('../middleware/auth');
const { SHIPPING_FEE, CURRENCY } = require('../lib/config');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const router = express.Router();

// --- Checkout page (login required) ---
router.get('/checkout', requireLogin, async (req, res) => {
  try {
    const cart = await getOrCreateCart(req);
    const items = await getCartItems(cart.id);

    if (items.length === 0) {
      req.flash('info', 'Your cart is empty.');
      return res.redirect('/cart');
    }

    const unavailable = items.filter(i => i.stock_quantity < i.quantity);
    if (unavailable.length) {
      req.flash('warning',
        `${unavailable[0].name} doesn't have enough stock any more. Please update your cart.`);
      return res.redirect('/cart');
    }

    const subtotal = items.reduce(
      (sum, i) => sum + Number(i.current_price) * i.quantity, 0
    );

    res.render('checkout/index', {
      title: 'Checkout',
      items,
      subtotal,
      shippingFee: SHIPPING_FEE,
      total: subtotal + SHIPPING_FEE,
      error: null
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('errors/500', { title: 'Something went wrong' });
  }
});

// --- Create the order and hand off to Stripe (login required) ---
router.post('/checkout/session', requireLogin, async (req, res) => {
  const { email, shipping_name, shipping_address } = req.body;

  const connection = await pool.getConnection();
  try {
    if (!email || !shipping_name || !shipping_address) {
      req.flash('warning', 'Please fill in your email and shipping address.');
      return res.redirect('/checkout');
    }

    const cart = await getOrCreateCart(req);
    const items = await getCartItems(cart.id);
    if (items.length === 0) {
      req.flash('info', 'Your cart is empty.');
      return res.redirect('/cart');
    }

    // Last stock check before taking any money
    const unavailable = items.filter(i => i.stock_quantity < i.quantity);
    if (unavailable.length) {
      req.flash('warning',
        `${unavailable[0].name} doesn't have enough stock any more. Please update your cart.`);
      return res.redirect('/cart');
    }

    // Prices come from the database, never from the browser
    const subtotal = items.reduce(
      (sum, i) => sum + Number(i.current_price) * i.quantity, 0
    );
    const total = subtotal + SHIPPING_FEE;

    await connection.beginTransaction();

    const [orderResult] = await connection.query(`
      INSERT INTO orders
        (user_id, email, status, subtotal, shipping_fee, total,
         shipping_name, shipping_address)
      VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)
    `, [
      req.session.user.id,
      email, subtotal, SHIPPING_FEE, total,
      shipping_name, shipping_address
    ]);

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
    req.flash('error', 'We could not start checkout. No payment was taken — please try again.');
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