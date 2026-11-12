const express = require('express');
const Stripe = require('stripe');
const pool = require('../db/pool');
const { sendOrderConfirmation } = require('../lib/mailer');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const router = express.Router();

router.post('/webhook/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers['stripe-signature'],
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('Webhook signature failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;

      try {
        await fulfilOrder(session);
      } catch (err) {
        console.error('Fulfilment failed:', err);
        return res.status(500).send('Fulfilment error');
      }
    }

    res.json({ received: true });
  }
);

async function fulfilOrder(session) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // Lock the order row so two webhooks can't process it at once
    const [orders] = await connection.query(
      'SELECT * FROM orders WHERE stripe_session_id = ? FOR UPDATE',
      [session.id]
    );
    const order = orders[0];

    if (!order) {
      await connection.commit();
      console.error('No order for session', session.id);
      return;
    }

    // Already handled: Stripe may send the same event more than once
    if (order.status !== 'pending') {
      await connection.commit();
      return;
    }

    const [items] = await connection.query(
      'SELECT * FROM order_items WHERE order_id = ?',
      [order.id]
    );

    // Decrement stock, failing if someone else bought it first
    for (const item of items) {
      if (!item.variant_id) continue;

      const [result] = await connection.query(`
        UPDATE product_variants
        SET stock_quantity = stock_quantity - ?
        WHERE id = ? AND stock_quantity >= ?
      `, [item.quantity, item.variant_id, item.quantity]);

      if (result.affectedRows === 0) {
        throw new Error(
          `Insufficient stock for variant ${item.variant_id} on order ${order.id}`
        );
      }
    }

    await connection.query(
      "UPDATE orders SET status = 'paid' WHERE id = ?",
      [order.id]
    );

    // Empty the cart that produced this order
    if (order.user_id) {
      await connection.query(
        'DELETE FROM carts WHERE user_id = ?',
        [order.user_id]
      );
    }

    await connection.commit();
    console.log(`Order ${order.id} marked paid`);

    // Send after committing: a mail failure must not roll back a paid order,
    // and its own try/catch stops a dead mail service returning 500 to Stripe
    try {
      // Resend reports most failures in the response instead of throwing,
      // so without this check a rejected email still logged "sent"
      const result = await sendOrderConfirmation(order, items);
      if (result && result.error) throw new Error(result.error.message);
      console.log(`Confirmation email sent for order ${order.id}`);
    } catch (mailErr) {
      console.error(`Email failed for order ${order.id}:`, mailErr);
    }
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

module.exports = router;