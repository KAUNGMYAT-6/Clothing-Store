const express = require('express');
const pool = require('../db/pool');
const { requireLogin } = require('../middleware/auth');
const { hasPurchased, getReviews, getRatingSummary } = require('../lib/reviews');

const router = express.Router();

const PER_PAGE = 12;

// ============================================================
// SORT WHITELIST
// ------------------------------------------------------------
// ORDER BY cannot be parameterised — you can't write
// "ORDER BY ?" and pass a column name, because ? is only ever
// a VALUE. So the only safe way to let users sort is to look
// their choice up in a fixed table. Anything not in this object
// falls back to 'newest'. That's the whole SQL-injection defence
// for sorting.
// ============================================================
const SORTS = {
  newest:     { label: 'Newest first',        sql: 'p.created_at DESC' },
  price_asc:  { label: 'Price: low to high',  sql: 'p.price ASC' },
  price_desc: { label: 'Price: high to low',  sql: 'p.price DESC' },
  name_asc:   { label: 'Name: A–Z',           sql: 'p.name ASC' },
  rating:     { label: 'Best rated',          sql: 'avg_rating DESC, review_count DESC' }
};

// ============================================================
// PRODUCT LISTING  —  GET /shop
// ============================================================
router.get('/shop', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    const category = req.query.category || '';
    const department = req.query.department || '';
    const sort = SORTS[req.query.sort] ? req.query.sort : 'newest';
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);

    // Build the WHERE clause piece by piece. Every user value goes
    // into params as a ?, never into the string itself.
    const where = ['p.is_active = TRUE'];
    const params = [];

    if (q) {
      // Escape LIKE's own wildcards first, or someone searching
      // "50%" or "a_b" would match far more than they meant
      const safe = q.replace(/[\\%_]/g, '\\$&');

      // Match only at the START of a word. Plain '%hi%' matches
      // mid-word, so "hi" would return every "Shirt" in the shop.
      //   "hi%"    start of the field
      //   "% hi%"  after a space
      //   "%-hi%"  after a hyphen
      const patterns = [`${safe}%`, `% ${safe}%`, `%-${safe}%`];

      where.push(`(
        p.name        LIKE ? OR p.name        LIKE ? OR p.name        LIKE ? OR
        p.description LIKE ? OR p.description LIKE ? OR p.description LIKE ? OR
        c.name        LIKE ?
      )`);
      params.push(...patterns, ...patterns, `${safe}%`);
    }

    if (category) {
      where.push('p.category_id = ?');
      params.push(category);
    }

    if (department) {
      where.push('p.department = ?');
      params.push(department);
    }

    const whereSql = where.join(' AND ');

    // --- how many match, for the pager ---
    const [[{ total }]] = await pool.query(`
      SELECT COUNT(*) AS total
      FROM products p
      JOIN categories c ON c.id = p.category_id
      WHERE ${whereSql}
    `, params);

    const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
    const currentPage = Math.min(page, totalPages);
    const offset = (currentPage - 1) * PER_PAGE;

    // --- the page itself ---
    const [products] = await pool.query(`
      SELECT
        p.id, p.name, p.slug, p.price, p.department, p.created_at,
        c.name AS category,

        -- Stock across every size/colour of this product
        (SELECT COALESCE(SUM(v.stock_quantity), 0)
           FROM product_variants v
          WHERE v.product_id = p.id) AS total_stock,

        -- The main image: primary first, then sort order, then oldest.
        -- A plain JOIN on is_primary = TRUE would show nothing for a
        -- product whose images exist but none is flagged primary.
        (SELECT pi.image_url
           FROM product_images pi
          WHERE pi.product_id = p.id
          ORDER BY pi.is_primary DESC, pi.sort_order ASC, pi.id ASC
          LIMIT 1) AS image_url,

        (SELECT pi.alt_text
           FROM product_images pi
          WHERE pi.product_id = p.id
          ORDER BY pi.is_primary DESC, pi.sort_order ASC, pi.id ASC
          LIMIT 1) AS alt_text,

        (SELECT ROUND(AVG(r.rating), 2)
           FROM reviews r WHERE r.product_id = p.id) AS avg_rating,

        (SELECT COUNT(*)
           FROM reviews r WHERE r.product_id = p.id) AS review_count

      FROM products p
      JOIN categories c ON c.id = p.category_id
      WHERE ${whereSql}
      ORDER BY ${SORTS[sort].sql}
      LIMIT ? OFFSET ?
    `, [...params, PER_PAGE, offset]);

    const [categories] = await pool.query(
      'SELECT id, name FROM categories ORDER BY name'
    );

    // Keep the current filters in every pagination link, minus the
    // page number itself. URLSearchParams handles the escaping.
    const baseParams = new URLSearchParams();
    if (q) baseParams.set('q', q);
    if (category) baseParams.set('category', category);
    if (department) baseParams.set('department', department);
    if (sort !== 'newest') baseParams.set('sort', sort);

    res.render('products/index', {
      title: 'Shop',
      products,
      categories,
      sorts: SORTS,
      filters: { q, category, department, sort },
      pagination: {
        total,
        totalPages,
        currentPage,
        from: total === 0 ? 0 : offset + 1,
        to: Math.min(offset + PER_PAGE, total),
        baseQuery: baseParams.toString()
      }
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// SINGLE PRODUCT  —  GET /products/:slug
// ============================================================
router.get('/products/:slug', async (req, res, next) => {
  try {
    const [[product]] = await pool.query(`
      SELECT p.*, c.name AS category
      FROM products p
      JOIN categories c ON c.id = p.category_id
      WHERE p.slug = ? AND p.is_active = TRUE
    `, [req.params.slug]);

    if (!product) return res.status(404).render('errors/404', { title: 'Not found' });

    const [images] = await pool.query(`
      SELECT image_url, alt_text
      FROM product_images
      WHERE product_id = ?
      ORDER BY is_primary DESC, sort_order ASC, id ASC
    `, [product.id]);

    const [variants] = await pool.query(`
      SELECT id, size, color, stock_quantity
      FROM product_variants
      WHERE product_id = ?
      ORDER BY color, FIELD(size, 'XS','S','M','L','XL','XXL'), size
    `, [product.id]);

    const rating = await getRatingSummary(product.id);
    const reviews = await getReviews(product.id);

    // Only a logged-in buyer of this product can review it
    let canReview = false;
    let myReview = null;

    if (req.session.user) {
      canReview = await hasPurchased(req.session.user.id, product.id);

      const [[existing]] = await pool.query(
        'SELECT * FROM reviews WHERE product_id = ? AND user_id = ?',
        [product.id, req.session.user.id]
      );
      myReview = existing || null;
    }

    res.render('products/show', {
      title: product.name,
      product,
      images,
      variants,
      rating,
      reviews,
      canReview,
      myReview
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// POST A REVIEW  —  POST /products/:slug/reviews
// ============================================================
router.post('/products/:slug/reviews', requireLogin, async (req, res, next) => {
  try {
    const rating = parseInt(req.body.rating, 10);
    const body = (req.body.body || '').trim().slice(0, 2000);

    const [[product]] = await pool.query(
      'SELECT id FROM products WHERE slug = ? AND is_active = TRUE',
      [req.params.slug]
    );
    if (!product) return res.status(404).render('errors/404', { title: 'Not found' });

    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      req.flash('error', 'Please choose a rating between 1 and 5 stars.');
      return res.redirect(`/products/${req.params.slug}#reviews`);
    }

    // Checked again on the server. The form is only hidden in the
    // browser, and anything in the browser can be bypassed.
    const bought = await hasPurchased(req.session.user.id, product.id);
    if (!bought) {
      req.flash('error', 'Only customers who bought this piece can review it.');
      return res.redirect(`/products/${req.params.slug}#reviews`);
    }

    // Needs UNIQUE KEY (product_id, user_id) on reviews.
    // One review per person per product — posting again edits it.
    await pool.query(`
      INSERT INTO reviews (product_id, user_id, rating, body)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        rating = VALUES(rating),
        body   = VALUES(body)
    `, [product.id, req.session.user.id, rating, body || null]);

    req.flash('success', 'Thanks — your review is up.');
    res.redirect(`/products/${req.params.slug}#reviews`);
  } catch (err) {
    next(err);
  }
});

// ============================================================
// DELETE MY REVIEW  —  POST /products/:slug/reviews/delete
// ============================================================
router.post('/products/:slug/reviews/delete', requireLogin, async (req, res, next) => {
  try {
    const [[product]] = await pool.query(
      'SELECT id FROM products WHERE slug = ?',
      [req.params.slug]
    );
    if (!product) return res.status(404).render('errors/404', { title: 'Not found' });

    // AND user_id = ? means you can only ever delete your own,
    // no matter what you put in the form
    await pool.query(
      'DELETE FROM reviews WHERE product_id = ? AND user_id = ?',
      [product.id, req.session.user.id]
    );

    req.flash('success', 'Your review has been removed.');
    res.redirect(`/products/${req.params.slug}#reviews`);
  } catch (err) {
    next(err);
  }
});

module.exports = router;