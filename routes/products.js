const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

const PER_PAGE = 12;   // 4 across × 3 rows on desktop

// Whitelist of sort options. User input never goes into ORDER BY directly —
// it isn't a value, so it can't be a ? placeholder, which makes it an
// injection risk if interpolated.
const SORTS = {
  newest:     { label: 'Newest first',       sql: 'p.created_at DESC' },
  price_asc:  { label: 'Price: low to high', sql: 'p.price ASC' },
  price_desc: { label: 'Price: high to low', sql: 'p.price DESC' },
  name:       { label: 'Name: A to Z',       sql: 'p.name ASC' }
};

router.get('/shop', async (req, res) => {
  try {
    const { q, category, department } = req.query;

    const sort = SORTS[req.query.sort] ? req.query.sort : 'newest';
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);

    const conditions = ['p.is_active = TRUE'];
    const params = [];

    if (q) {
      conditions.push('(p.name LIKE ? OR p.description LIKE ?)');
      params.push(`%${q}%`, `%${q}%`);
    }
    if (category) {
      conditions.push('p.category_id = ?');
      params.push(category);
    }
    if (department) {
      conditions.push('p.department = ?');
      params.push(department);
    }

    const where = conditions.join(' AND ');

    // Total first, so we know how many pages there are
    const [[countRow]] = await pool.query(`
      SELECT COUNT(DISTINCT p.id) AS total
      FROM products p
      JOIN categories c ON c.id = p.category_id
      WHERE ${where}
    `, params);

    const total = Number(countRow.total);
    const totalPages = Math.max(Math.ceil(total / PER_PAGE), 1);
    const currentPage = Math.min(page, totalPages);
    const offset = (currentPage - 1) * PER_PAGE;

    // PER_PAGE and offset are integers we computed, never raw user input,
    // so interpolating them is safe
    const [products] = await pool.query(`
      SELECT p.id, p.name, p.slug, p.price,
             c.name AS category, p.department,
             i.image_url, i.alt_text,
             COALESCE(SUM(v.stock_quantity), 0) AS total_stock
      FROM products p
      JOIN categories c ON c.id = p.category_id
      LEFT JOIN product_images i ON i.id = (
        SELECT id FROM product_images
        WHERE product_id = p.id
        ORDER BY is_primary DESC, sort_order ASC, id ASC
        LIMIT 1
      )
      LEFT JOIN product_variants v ON v.product_id = p.id
      WHERE ${where}
      GROUP BY p.id, p.name, p.slug, p.price, c.name, p.department,
               i.image_url, i.alt_text
      ORDER BY ${SORTS[sort].sql}
      LIMIT ${PER_PAGE} OFFSET ${offset}
    `, params);

    const [categories] = await pool.query(
      'SELECT id, name FROM categories ORDER BY name'
    );

    // Every filter except page, so page links keep the current filters
    const baseParams = new URLSearchParams();
    if (q) baseParams.set('q', q);
    if (category) baseParams.set('category', category);
    if (department) baseParams.set('department', department);
    if (sort !== 'newest') baseParams.set('sort', sort);

    res.render('products/index', {
      title: 'Shop',
      products,
      categories,
      filters: { q, category, department, sort },
      sorts: SORTS,
      pagination: {
        total,
        totalPages,
        currentPage,
        perPage: PER_PAGE,
        from: total === 0 ? 0 : offset + 1,
        to: Math.min(offset + PER_PAGE, total),
        baseQuery: baseParams.toString()
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('errors/500', { title: 'Something went wrong' });
  }
});

// Product detail page
router.get('/products/:slug', async (req, res) => {
  try {
    const [[product]] = await pool.query(`
      SELECT p.*, c.name AS category
      FROM products p
      JOIN categories c ON c.id = p.category_id
      WHERE p.slug = ? AND p.is_active = TRUE
    `, [req.params.slug]);

    if (!product) {
      return res.status(404).render('errors/404', { title: 'Product not found' });
    }

    const [variants] = await pool.query(
      'SELECT * FROM product_variants WHERE product_id = ? ORDER BY color, size',
      [product.id]
    );

    const [images] = await pool.query(
      `SELECT * FROM product_images
       WHERE product_id = ?
       ORDER BY is_primary DESC, sort_order ASC, id ASC`,
      [product.id]
    );

    res.render('products/show', {
      title: product.name,
      product,
      variants,
      images,
      query: req.query
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('errors/500', { title: 'Something went wrong' });
  }
});

module.exports = router;