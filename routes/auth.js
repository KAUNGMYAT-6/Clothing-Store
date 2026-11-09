const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('../db/pool');
const passport = require('../lib/passport');
const { requireLogin } = require('../middleware/auth');
const { mergeGuestCart } = require('../lib/cart');

const router = express.Router();

// Shared by both password and Google login
async function completeLogin(req, res, user) {
  req.session.user = {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role || 'user'
  };

  try {
    await mergeGuestCart(req, user.id);
  } catch (mergeErr) {
    console.error('Cart merge failed:', mergeErr);
  }

  const returnTo = req.session.returnTo || '/';
  delete req.session.returnTo;

  req.session.save((err) => {
    if (err) {
      console.error('Session save failed:', err);
      return res.redirect('/login');
    }
    res.redirect(returnTo);
  });
}

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

    // Same message for both failures, to avoid revealing which emails exist.
    // !user.password_hash covers Google-only accounts.
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

    await completeLogin(req, res, user);
  } catch (err) {
    console.error(err);
    res.status(500).render('auth/login', {
      title: 'Log in',
      error: 'Something went wrong.'
    });
  }
});

// --- Google OAuth ---
router.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'], session: false })
);

router.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/login', session: false }),
  async (req, res) => {
    try {
      await completeLogin(req, res, req.user);
    } catch (err) {
      console.error(err);
      res.redirect('/login');
    }
  }
);

// --- Logout ---
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

// --- Account (protected) ---
router.get('/account', requireLogin, (req, res) => {
  res.send(`Account page for ${req.session.user.name}`);
});

module.exports = router;