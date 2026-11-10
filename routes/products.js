const express = require('express');
const pool = require('../db/pool');
const { requireLogin } = require('../middleware/auth');
const { hasPurchased, getReviews, getRatingSummary } = require('../lib/reviews');

const router = express.Router();

const PER_PAGE = 12;   // 4 across x 3 rows on desktop

// Whitelist of sort options. A sort column can't be a ? placeholder
// (placeholders are for values), so it has to be interpolated — which makes
// it an injection risk unless only known strings can ever reach the query.
const SORTS = {
  newest:     { label: 'Newest first',       sql: 'p.created_at DESC' },
  price_asc:  { label: 'Price: low to high', sql: 'p.price ASC' },
  price_desc: { label: 'Price: high to low', sql: 'p.price DESC' },
  name:       { label: 'Name: A to Z',       sql: 'p.name ASC' }
};

// ============================================================
// Shop listing
// ============================================================
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
    // so interpolating them is safe.
    // The image join prefers the primary image but falls back to the first,
    // so a product still shows a picture if nobody ticked "Main".
    const [products] = await pool.query(`
      SELECT p.id, p.name, p.slug, p.price,
             c.name AS category, p.department,
             i.image_url, i.alt_text,
             (SELECT COALESCE(AVG(rating), 0) FROM reviews WHERE product_id = p.id) AS avg_rating,
             (SELECT COUNT(*) FROM reviews WHERE product_id = p.id) AS review_count,
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

// ============================================================
// Product detail
// ============================================================
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

    const reviews = await getReviews(product.id);
    const rating = await getRatingSummary(product.id);

    // Can the person looking at this page write a review?
    let canReview = false;
    let myReview = null;

    if (req.session.user) {
      myReview = reviews.find(r => r.user_id === req.session.user.id) || null;
      canReview = await hasPurchased(req.session.user.id, product.id);
    }

    res.render('products/show', {
      title: product.name,
      product, variants, images,
      reviews, rating, canReview, myReview,
      query: req.query
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('errors/500', { title: 'Something went wrong' });
  }
});

// ============================================================
// Reviews
// ============================================================
router.post('/products/:slug/reviews', requireLogin, async (req, res) => {
  const rating = parseInt(req.body.rating, 10);
  const body = (req.body.body || '').trim();
  const slug = req.params.slug;

  try {
    const [[product]] = await pool.query(
      'SELECT id FROM products WHERE slug = ?', [slug]
    );
    if (!product) {
      return res.status(404).render('errors/404', { title: 'Product not found' });
    }

    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      req.flash('warning', 'Please choose a rating from 1 to 5 stars.');
      return res.redirect(`/products/${slug}#reviews`);
    }

    if (body.length > 2000) {
      req.flash('warning', 'Please keep your review under 2000 characters.');
      return res.redirect(`/products/${slug}#reviews`);
    }

    // Checked server-side, not just hidden in the UI: a hidden form is
    // not access control
    const purchased = await hasPurchased(req.session.user.id, product.id);
    if (!purchased) {
      req.flash('error', 'Only customers who bought this piece can review it.');
      return res.redirect(`/products/${slug}#reviews`);
    }

    // The unique key on (user_id, product_id) turns a second review into
    // an edit of the first
    await pool.query(`
      INSERT INTO reviews (product_id, user_id, rating, body)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE rating = VALUES(rating), body = VALUES(body)
    `, [product.id, req.session.user.id, rating, body || null]);

    req.flash('success', 'Thanks — your review is live.');
    res.redirect(`/products/${slug}#reviews`);
  } catch (err) {
    console.error(err);
    req.flash('error', 'We could not save your review. Please try again.');
    res.redirect(`/products/${slug}#reviews`);
  }
});

router.post('/products/:slug/reviews/delete', requireLogin, async (req, res) => {
  const slug = req.params.slug;

  try {
    const [[product]] = await pool.query(
      'SELECT id FROM products WHERE slug = ?', [slug]
    );
    if (!product) return res.redirect('/shop');

    // AND user_id scopes the delete to their own review
    await pool.query(
      'DELETE FROM reviews WHERE product_id = ? AND user_id = ?',
      [product.id, req.session.user.id]
    );

    req.flash('info', 'Your review has been removed.');
    res.redirect(`/products/${slug}#reviews`);
  } catch (err) {
    console.error(err);
    req.flash('error', 'Could not remove your review.');
    res.redirect(`/products/${slug}#reviews`);
  }
});

module.exports = router;