const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    // Newest four products that are actually buyable
    const [featured] = await pool.query(`
      SELECT p.id, p.name, p.slug, p.price,
             c.name AS category,
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
      WHERE p.is_active = TRUE
      GROUP BY p.id, p.name, p.slug, p.price, c.name, i.image_url, i.alt_text
      HAVING total_stock > 0
      ORDER BY p.created_at DESC
      LIMIT 4
    `);

    const [categories] = await pool.query(`
      SELECT c.id, c.name, c.slug, COUNT(p.id) AS product_count
      FROM categories c
      LEFT JOIN products p ON p.category_id = c.id AND p.is_active = TRUE
      GROUP BY c.id, c.name, c.slug
      ORDER BY c.name
    `);

    res.render('home', { title: 'Home', featured, categories });
  } catch (err) {
    console.error(err);
    res.status(500).render('errors/500', { title: 'Something went wrong' });
  }
});

// ============================================================
// Privacy policy and terms
// ------------------------------------------------------------
// Google requires both, on the site's own domain, before an app
// using "Sign in with Google" can be published for everyone.
// When the wording changes, update LEGAL_UPDATED too.
// ============================================================
const LEGAL_UPDATED = '14 November 2026';

function legalPage(view, title) {
  return (req, res) => {
    res.render(`legal/${view}`, {
      title,
      updated: LEGAL_UPDATED,
      supportEmail: process.env.SUPPORT_EMAIL || null,
      siteUrl: process.env.BASE_URL || ''
    });
  };
}

router.get('/privacy', legalPage('privacy', 'Privacy policy'));
router.get('/terms', legalPage('terms', 'Terms of use'));

module.exports = router;