const express = require('express');
const pool = require('../db/pool');
const { requireAdmin } = require('../middleware/auth');

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
        (SELECT COALESCE(SUM(total), 0) FROM orders WHERE status != 'pending') AS revenue,
        (SELECT COUNT(*) FROM products WHERE is_active = TRUE)   AS active_products,
        (SELECT COUNT(*) FROM product_variants WHERE stock_quantity = 0) AS out_of_stock
    `);

    const [recent] = await pool.query(`
      SELECT id, email, status, total, created_at
      FROM orders
      ORDER BY created_at DESC
      LIMIT 6
    `);

    // Revenue per day, last 7 days
    const [rows] = await pool.query(`
      SELECT DATE(created_at) AS day, COALESCE(SUM(total), 0) AS revenue
      FROM orders
      WHERE status != 'pending'
        AND created_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
      GROUP BY DATE(created_at)
    `);

    // Days with no orders don't come back from GROUP BY, so fill the gaps
    const byDay = {};
    rows.forEach(r => {
      const key = new Date(r.day).toISOString().slice(0, 10);
      byDay[key] = Number(r.revenue);
    });

    const chart = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      chart.push({
        label: d.toLocaleDateString('en-SG', { weekday: 'short' }),
        revenue: byDay[key] || 0
      });
    }

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

router.get('/products/new', async (req, res) => {
  try {
    const [categories] = await pool.query('SELECT id, name FROM categories ORDER BY name');
    res.render('admin/product-form', {
      title: 'New product',
      active: 'products',
      product: null,
      categories,
      error: null
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('errors/500', { title: 'Something went wrong' });
  }
});

router.post('/products', async (req, res) => {
  const { name, slug, description, price, category_id, department } = req.body;

  try {
    if (!name || !slug || !price || !category_id) {
      const [categories] = await pool.query('SELECT id, name FROM categories ORDER BY name');
      return res.status(400).render('admin/product-form', {
        title: 'New product',
        active: 'products',
        product: req.body,
        categories,
        error: 'Name, slug, price and category are all required.'
      });
    }

    const [result] = await pool.query(`
      INSERT INTO products (name, slug, description, price, category_id, department)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [name, slug, description || null, price, category_id, department || 'unisex']);

    req.flash('success', `"${name}" created. Add sizes and colours below so it can be bought.`);
    res.redirect(`/admin/products/${result.insertId}/edit`);
  } catch (err) {
    console.error(err);
    const [categories] = await pool.query('SELECT id, name FROM categories ORDER BY name');
    res.status(400).render('admin/product-form', {
      title: 'New product',
      active: 'products',
      product: req.body,
      categories,
      error: err.code === 'ER_DUP_ENTRY'
        ? 'That slug is already in use. Try a different one.'
        : 'Could not create the product.'
    });
  }
});

router.get('/products/:id/edit', async (req, res) => {
  try {
    const [[product]] = await pool.query('SELECT * FROM products WHERE id = ?', [req.params.id]);
    if (!product) {
      return res.status(404).render('errors/404', { title: 'Product not found' });
    }

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
      active: 'products',
      product, categories, variants, images, error: null
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
  const { size, color, sku, stock_quantity } = req.body;
  const productId = req.params.id;

  try {
    if (!size || !color || !sku) {
      req.flash('warning', 'Size, colour and SKU are all required.');
      return res.redirect(`/admin/products/${productId}/edit`);
    }

    await pool.query(`
      INSERT INTO product_variants (product_id, size, color, sku, stock_quantity)
      VALUES (?, ?, ?, ?, ?)
    `, [productId, size, color, sku, parseInt(stock_quantity, 10) || 0]);

    req.flash('success', `Added ${color} · ${size}.`);
    res.redirect(`/admin/products/${productId}/edit`);
  } catch (err) {
    console.error(err);
    req.flash('error', err.code === 'ER_DUP_ENTRY'
      ? 'That size and colour already exists for this product, or that SKU is taken.'
      : 'Could not add the variant.');
    res.redirect(`/admin/products/${productId}/edit`);
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
router.post('/products/:id/images', async (req, res) => {
  const { image_url, alt_text, sort_order, is_primary } = req.body;
  const productId = req.params.id;

  const connection = await pool.getConnection();
  try {
    if (!image_url) {
      req.flash('warning', 'An image URL is required.');
      return res.redirect(`/admin/products/${productId}/edit`);
    }

    await connection.beginTransaction();

    // Only one image can be primary, so clear the others first.
    // Both steps must happen together, hence the transaction.
    if (is_primary === 'on') {
      await connection.query(
        'UPDATE product_images SET is_primary = FALSE WHERE product_id = ?',
        [productId]
      );
    }

    await connection.query(`
      INSERT INTO product_images (product_id, image_url, alt_text, sort_order, is_primary)
      VALUES (?, ?, ?, ?, ?)
    `, [
      productId, image_url, alt_text || null,
      parseInt(sort_order, 10) || 0, is_primary === 'on' ? 1 : 0
    ]);

    await connection.commit();
    req.flash('success', 'Image added.');
    res.redirect(`/admin/products/${productId}/edit`);
  } catch (err) {
    await connection.rollback();
    console.error(err);
    req.flash('error', 'Could not add the image.');
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
    await pool.query(
      'DELETE FROM product_images WHERE id = ? AND product_id = ?',
      [req.params.imageId, req.params.id]
    );
    req.flash('info', 'Image deleted.');
    res.redirect(`/admin/products/${req.params.id}/edit`);
  } catch (err) {
    console.error(err);
    req.flash('error', 'Could not delete that image.');
    res.redirect(`/admin/products/${req.params.id}/edit`);
  }
});

module.exports = router;