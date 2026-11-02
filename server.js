// ---------- Requires ----------
const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const bcrypt = require('bcrypt');
const path = require('path');
require('dotenv').config();

const pool = require('./db/pool');

// ---------- App setup ----------
const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

// ---------- Sessions ----------
const sessionStore = new MySQLStore({}, pool);

app.use(session({
  key: 'store_sid',
  secret: process.env.SESSION_SECRET,
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24 * 7   // 7 days
  }
}));

// Make the logged-in user available to every template
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  next();
});

// ---------- Access control middleware ----------
function requireLogin(req, res, next) {
  if (!req.session.user) {
    req.session.returnTo = req.originalUrl;
    return res.redirect('/login');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user) {
    req.session.returnTo = req.originalUrl;
    return res.redirect('/login');
  }
  if (req.session.user.role !== 'admin') {
    return res.status(403).render('errors/403', { title: 'Forbidden' });
  }
  next();
}

// ---------- Product routes ----------
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

    const [categories] = await pool.query(
      'SELECT id, name FROM categories ORDER BY name'
    );

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
      'SELECT * FROM product_variants WHERE product_id = ? ORDER BY color, size',
      [product.id]
    );

    const [images] = await pool.query(
      'SELECT * FROM product_images WHERE product_id = ? ORDER BY sort_order',
      [product.id]
    );

    res.render('products/show', {
      title: product.name,
      product,
      variants,
      images
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Database error');
  }
});

// ---------- Auth routes ----------
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

    const [existing] = await pool.query(
      'SELECT id FROM users WHERE email = ?',
      [email]
    );
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

app.get('/login', (req, res) => {
  res.render('auth/login', { title: 'Log in', error: null });
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const [[user]] = await pool.query(
      'SELECT * FROM users WHERE email = ?',
      [email]
    );

    // Same message for both failures, to avoid revealing which emails exist
    if (!user || !user.password_hash) {
      return res.status(401).render('auth/login', {
        title: 'Log in',
        error: 'Invalid email or password.'
      });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).render('auth/login', {
        title: 'Log in',
        error: 'Invalid email or password.'
      });
    }

    req.session.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role
    };

    const returnTo = req.session.returnTo || '/';
    delete req.session.returnTo;
    res.redirect(returnTo);
  } catch (err) {
    console.error(err);
    res.status(500).render('auth/login', {
      title: 'Log in',
      error: 'Something went wrong.'
    });
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// ---------- Protected routes (placeholders for now) ----------
app.get('/account', requireLogin, (req, res) => {
  res.send(`Account page for ${req.session.user.name}`);
});

app.get('/admin', requireAdmin, (req, res) => {
  res.send('Admin area');
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});