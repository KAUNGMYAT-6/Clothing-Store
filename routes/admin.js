const express = require('express');
const pool = require('../db/pool');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

// Every route in this file requires admin
router.use(requireAdmin);

// --- Dashboard ---
router.get('/', async (req, res) => {
  try {
    const [[stats]] = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM orders WHERE status = 'paid')      AS paid_orders,
        (SELECT COUNT(*) FROM orders WHERE status = 'pending')   AS pending_orders,
        (SELECT COALESCE(SUM(total), 0) FROM orders WHERE status != 'pending') AS revenue,
        (SELECT COUNT(*) FROM products WHERE is_active = TRUE)   AS active_products,
        (SELECT COUNT(*) FROM product_variants WHERE stock_quantity = 0) AS out_of_stock
    `);

    const [recent] = await pool.query(`
      SELECT id, email, status, total, created_at
      FROM orders ORDER BY created_at DESC LIMIT 5
    `);

    res.render('admin/dashboard', { title: 'Admin', stats, recent });
  } catch (err) {
    console.error(err);
    res.status(500).send('Could not load dashboard');
  }
});

// --- Orders list ---
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

    res.render('admin/orders', { title: 'Orders', orders, filters: { status } });
  } catch (err) {
    console.error(err);
    res.status(500).send('Could not load orders');
  }
});

// --- Order detail ---
router.get('/orders/:id', async (req, res) => {
  try {
    const [[order]] = await pool.query('SELECT * FROM orders WHERE id = ?', [req.params.id]);
    if (!order) return res.status(404).send('Order not found');

    const [items] = await pool.query(
      'SELECT * FROM order_items WHERE order_id = ?', [order.id]
    );

    res.render('admin/order-detail', { title: `Order #${order.id}`, order, items });
  } catch (err) {
    console.error(err);
    res.status(500).send('Could not load order');
  }
});

// --- Update status ---
router.post('/orders/:id/status', async (req, res) => {
  const allowed = ['pending', 'paid', 'shipped', 'delivered', 'cancelled'];
  const { status } = req.body;

  try {
    if (!allowed.includes(status)) return res.redirect(`/admin/orders/${req.params.id}`);

    await pool.query('UPDATE orders SET status = ? WHERE id = ?', [status, req.params.id]);
    res.redirect(`/admin/orders/${req.params.id}`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Could not update order');
  }
});

module.exports = router;