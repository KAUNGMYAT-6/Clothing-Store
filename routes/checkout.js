const express = require('express');
const Stripe = require('stripe');
const pool = require('../db/pool');
const { getOrCreateCart, getCartItems } = require('../lib/cart');
const { SHIPPING_FEE, CURRENCY } = require('../lib/config');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const router = express.Router();

router.get('/checkout', async (req, res) => {
  try {
    if (!req.session.user && !req.session.guestToken) {
      return res.redirect('/cart');
    }

    const cart = await getOrCreateCart(req);
    const items = await getCartItems(cart.id);

    if (items.length === 0) return res.redirect('/cart');

    // Anything out of stock blocks checkout
    const unavailable = items.filter(i => i.stock_quantity < i.quantity);
    if (unavailable.length) {
      return res.redirect('/cart?error=stock');
    }

    const subtotal = items.reduce(
      (sum, i) => sum + Number(i.current_price) * i.quantity,
      0
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
    res.status(500).send('Could not load checkout');
  }
});

router.post('/checkout/session', async (req, res) => {
  const { email, shipping_name, shipping_address } = req.body;

  const connection = await pool.getConnection();
  try {
    if (!email || !shipping_name || !shipping_address) {
      return res.redirect('/checkout');
    }

    const cart = await getOrCreateCart(req);
    const items = await getCartItems(cart.id);
    if (items.length === 0) return res.redirect('/cart');

    // Re-check stock at the last moment before taking payment
    const unavailable = items.filter(i => i.stock_quantity < i.quantity);
    if (unavailable.length) return res.redirect('/cart?error=stock');

    // Prices come from the database, never from the browser
    const subtotal = items.reduce(
      (sum, i) => sum + Number(i.current_price) * i.quantity,
      0
    );
    const total = subtotal + SHIPPING_FEE;

    await connection.beginTransaction();

    const [orderResult] = await connection.query(`
      INSERT INTO orders
        (user_id, email, status, subtotal, shipping_fee, total,
         shipping_name, shipping_address)
      VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)
    `, [
      req.session.user ? req.session.user.id : null,
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

    // Hand off to Stripe's hosted checkout page
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
            product_data: { name: 'Shipping' },
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
    res.status(500).send('Could not start checkout');
  } finally {
    connection.release();
  }
});

module.exports = router;