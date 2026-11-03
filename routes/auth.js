const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('../db/pool');
const { requireLogin } = require('../middleware/auth');
const { mergeGuestCart } = require('../lib/cart');

const router = express.Router();

// --- Registration ---
router.get('/register', (req, res) => {
  res.render('auth/register', { title: 'Register', error: null });
});

router.post('/register', async (req, res) => {
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

// --- Login ---
router.get('/login', (req, res) => {
  res.render('auth/login', { title: 'Log in', error: null });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const [users] = await pool.query(
      'SELECT * FROM users WHERE email = ?',
      [email]
    );
    const user = users[0];

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

    // A failed cart merge should not prevent the user logging in
    try {
      await mergeGuestCart(req, user.id);
    } catch (mergeErr) {
      console.error('Cart merge failed:', mergeErr);
    }

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

// --- Logout ---
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// --- Account (protected) ---
router.get('/account', requireLogin, (req, res) => {
  res.send(`Account page for ${req.session.user.name}`);
});

module.exports = router;