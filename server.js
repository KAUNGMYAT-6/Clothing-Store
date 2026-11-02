const express = require('express');
const pool = require('./db/pool');
const bcrypt = require('bcrypt');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const path = require('path');

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

app.get('/', async (req, res) => {
  try {
    const { q, category, department } = req.query;

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

    const [products] = await pool.query(`
      SELECT p.id, p.name, p.slug, p.price,
             c.name AS category,
             i.image_url, i.alt_text
      FROM products p
      JOIN categories c ON c.id = p.category_id
      LEFT JOIN product_images i
        ON i.product_id = p.id AND i.is_primary = TRUE
      WHERE ${conditions.join(' AND ')}
      ORDER BY p.created_at DESC
    `, params);

    const [categories] = await pool.query('SELECT id, name FROM categories ORDER BY name');

    res.render('products/index', {
      title: 'Products',
      products,
      categories,
      filters: { q, category, department }
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Database error');
  }
});


app.get('/register', (req, res) => {
  res.render('auth/register', { title: 'Register', error: null });
});

app.post('/register', async (req, res) => {
  const { name, email, password } = req.body;

  try {
    if (!name || !email || !password || password.length < 8) {
      return res.status(400).render('auth/register', {
        title: 'Register',
        error: 'Please fill in all fields. Password must be at least 8 characters.'
      });
    }

    const [existing] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
    if (existing.length) {
      return res.status(400).render('auth/register', {
        title: 'Register',
        error: 'An account with that email already exists.'
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    await pool.query(
      'INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)',
      [name, email, passwordHash]
    );

    res.redirect('/login');
  } catch (err) {
    console.error(err);
    res.status(500).render('auth/register', {
      title: 'Register',
      error: 'Something went wrong. Please try again.'
    });
  }
});

app.get('/products/:slug', async (req, res) => {
  try {
    const [[product]] = await pool.query(`
      SELECT p.*, c.name AS category
      FROM products p
      JOIN categories c ON c.id = p.category_id
      WHERE p.slug = ? AND p.is_active = TRUE
    `, [req.params.slug]);

    if (!product) return res.status(404).send('Product not found');

    const [variants] = await pool.query(
      `SELECT * FROM product_variants WHERE product_id = ? ORDER BY color, size`,
      [product.id]
    );

    const [images] = await pool.query(
      `SELECT * FROM product_images WHERE product_id = ? ORDER BY sort_order`,
      [product.id]
    );

    res.render('products/show', { title: product.name, product, variants, images });
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