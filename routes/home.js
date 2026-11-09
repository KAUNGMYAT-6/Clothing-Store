const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    // Newest four products with stock
    const [featured] = await pool.query(`
      SELECT p.id, p.name, p.slug, p.price,
             c.name AS category,
             i.image_url, i.alt_text,
             COALESCE(SUM(v.stock_quantity), 0) AS total_stock
      FROM products p
      JOIN categories c ON c.id = p.category_id
      LEFT JOIN product_images i ON i.product_id = p.id AND i.is_primary = TRUE
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

module.exports = router;