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

// --- Products list ---
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

    res.render('admin/products', { title: 'Products', products });
  } catch (err) {
    console.error(err);
    res.status(500).send('Could not load products');
  }
});

// --- New product form ---
router.get('/products/new', async (req, res) => {
  try {
    const [categories] = await pool.query('SELECT id, name FROM categories ORDER BY name');
    res.render('admin/product-form', {
      title: 'New product',
      product: null,
      categories,
      error: null
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Could not load form');
  }
});

// --- Create product ---
router.post('/products', async (req, res) => {
  const { name, slug, description, price, category_id, department } = req.body;

  try {
    if (!name || !slug || !price || !category_id) {
      const [categories] = await pool.query('SELECT id, name FROM categories ORDER BY name');
      return res.status(400).render('admin/product-form', {
        title: 'New product',
        product: req.body,
        categories,
        error: 'Name, slug, price and category are required.'
      });
    }

    const [result] = await pool.query(`
      INSERT INTO products (name, slug, description, price, category_id, department)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [name, slug, description || null, price, category_id, department || 'unisex']);

    res.redirect(`/admin/products/${result.insertId}/edit`);
  } catch (err) {
    console.error(err);
    const [categories] = await pool.query('SELECT id, name FROM categories ORDER BY name');
    res.status(400).render('admin/product-form', {
      title: 'New product',
      product: req.body,
      categories,
      error: err.code === 'ER_DUP_ENTRY'
        ? 'That slug is already in use.'
        : 'Could not create product.'
    });
  }
});

// --- Edit product form ---
router.get('/products/:id/edit', async (req, res) => {
  try {
    const [[product]] = await pool.query('SELECT * FROM products WHERE id = ?', [req.params.id]);
    if (!product) return res.status(404).send('Product not found');

    const [categories] = await pool.query('SELECT id, name FROM categories ORDER BY name');
    const [variants] = await pool.query(
      'SELECT * FROM product_variants WHERE product_id = ? ORDER BY color, size',
      [product.id]
    );
    const [images] = await pool.query(
      'SELECT * FROM product_images WHERE product_id = ? ORDER BY sort_order',
      [product.id]
    );

    res.render('admin/product-edit', {
      title: `Edit ${product.name}`,
      product, categories, variants, images, error: null
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Could not load product');
  }
});

// --- Update product ---
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

    res.redirect(`/admin/products/${req.params.id}/edit`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Could not update product');
  }
});

// --- Variants ---
router.post('/products/:id/variants', async (req, res) => {
  const { size, color, sku, stock_quantity } = req.body;
  const productId = req.params.id;

  try {
    if (!size || !color || !sku) {
      return res.redirect(`/admin/products/${productId}/edit?error=variant`);
    }

    await pool.query(`
      INSERT INTO product_variants (product_id, size, color, sku, stock_quantity)
      VALUES (?, ?, ?, ?, ?)
    `, [productId, size, color, sku, parseInt(stock_quantity, 10) || 0]);

    res.redirect(`/admin/products/${productId}/edit`);
  } catch (err) {
    console.error(err);
    const reason = err.code === 'ER_DUP_ENTRY' ? 'duplicate' : 'variant';
    res.redirect(`/admin/products/${productId}/edit?error=${reason}`);
  }
});

router.post('/products/:id/variants/:variantId/stock', async (req, res) => {
  const stock = parseInt(req.body.stock_quantity, 10);

  try {
    if (Number.isInteger(stock) && stock >= 0) {
      await pool.query(
        'UPDATE product_variants SET stock_quantity = ? WHERE id = ? AND product_id = ?',
        [stock, req.params.variantId, req.params.id]
      );
    }
    res.redirect(`/admin/products/${req.params.id}/edit`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Could not update stock');
  }
});

router.post('/products/:id/variants/:variantId/delete', async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM product_variants WHERE id = ? AND product_id = ?',
      [req.params.variantId, req.params.id]
    );
    res.redirect(`/admin/products/${req.params.id}/edit`);
  } catch (err) {
    console.error(err);
    res.redirect(`/admin/products/${req.params.id}/edit?error=variant_in_use`);
  }
});

// --- Images ---
router.post('/products/:id/images', async (req, res) => {
  const { image_url, alt_text, sort_order, is_primary } = req.body;
  const productId = req.params.id;

  const connection = await pool.getConnection();
  try {
    if (!image_url) return res.redirect(`/admin/products/${productId}/edit`);

    await connection.beginTransaction();

    // Only one image can be primary, so clear the others first
    if (is_primary === 'on') {
      await connection.query(
        'UPDATE product_images SET is_primary = FALSE WHERE product_id = ?',
        [productId]
      );
    }

    await connection.query(`
      INSERT INTO product_images (product_id, image_url, alt_text, sort_order, is_primary)
      VALUES (?, ?, ?, ?, ?)
    `, [productId, image_url, alt_text || null,
        parseInt(sort_order, 10) || 0, is_primary === 'on' ? 1 : 0]);

    await connection.commit();
    res.redirect(`/admin/products/${productId}/edit`);
  } catch (err) {
    await connection.rollback();
    console.error(err);
    res.status(500).send('Could not add image');
  } finally {
    connection.release();
  }
});

router.post('/products/:id/images/:imageId/delete', async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM product_images WHERE id = ? AND product_id = ?',
      [req.params.imageId, req.params.id]
    );
    res.redirect(`/admin/products/${req.params.id}/edit`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Could not delete image');
  }
});

module.exports = router;