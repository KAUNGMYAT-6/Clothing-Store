const express = require('express');
const pool = require('./db/pool');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const path = require('path');

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', async (req, res) => {
  try {
    const [products] = await pool.query(`
      SELECT p.id, p.name, p.slug, p.price,
             c.name AS category,
             i.image_url, i.alt_text
      FROM products p
      JOIN categories c ON c.id = p.category_id
      LEFT JOIN product_images i
        ON i.product_id = p.id AND i.is_primary = TRUE
      WHERE p.is_active = TRUE
      ORDER BY p.created_at DESC
    `);
    res.render('products/index', { title: 'Products', products });
  } catch (err) {
    console.error(err);
    res.status(500).send('Database error');
  }
});

app.get('/test-db', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT p.id, p.name, p.price, c.name AS category
      FROM products p
      JOIN categories c ON c.id = p.category_id
      WHERE p.is_active = TRUE
    `);
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).send('Database error');
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});