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

  req.flash('success', `Welcome back, ${user.name.split(' ')[0]}.`);

  // Wait for the session to be written before redirecting
  req.session.save((err) => {
    if (err) {
      console.error('Session save failed:', err);
      return res.redirect('/login');
    }
    res.redirect(returnTo);
  });
}

// ============================================================
// Registration
// ============================================================
router.get('/register', (req, res) => {
  res.render('auth/register', { title: 'Create account', error: null, values: {} });
});

router.post('/register', async (req, res) => {
  const { name, email, password, confirm_password } = req.body;
  const values = { name, email };

  try {
    if (!name || !email || !password) {
      return res.status(400).render('auth/register', {
        title: 'Create account', values,
        error: 'Please fill in all fields.'
      });
    }

    if (password.length < 8) {
      return res.status(400).render('auth/register', {
        title: 'Create account', values,
        error: 'Your password needs at least 8 characters.'
      });
    }

    // Checked here as well as in the browser: client-side validation
    // is a convenience, never a guarantee
    if (password !== confirm_password) {
      return res.status(400).render('auth/register', {
        title: 'Create account', values,
        error: 'Those passwords do not match.'
      });
    }

    const [existing] = await pool.query(
      'SELECT id FROM users WHERE email = ?',
      [email]
    );
    if (existing.length) {
      return res.status(400).render('auth/register', {
        title: 'Create account', values,
        error: 'An account with that email already exists. Try logging in instead.'
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    await pool.query(
      'INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)',
      [name, email, passwordHash]
    );

    req.flash('success', 'Account created. You can log in now.');
    res.redirect('/login');
  } catch (err) {
    console.error(err);
    res.status(500).render('auth/register', {
      title: 'Create account', values,
      error: 'Something went wrong. Please try again.'
    });
  }
});

// ============================================================
// Login
// ============================================================
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

    // Same message for both failures, so the form can't be used to
    // discover which emails have accounts.
    // !user.password_hash covers Google-only accounts.
    if (!user || !user.password_hash) {
      return res.status(401).render('auth/login', {
        title: 'Log in',
        error: 'That email and password don\'t match an account.'
      });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).render('auth/login', {
        title: 'Log in',
        error: 'That email and password don\'t match an account.'
      });
    }

    await completeLogin(req, res, user);
  } catch (err) {
    console.error(err);
    res.status(500).render('auth/login', {
      title: 'Log in',
      error: 'Something went wrong. Please try again.'
    });
  }
});

// ============================================================
// Google OAuth
// ============================================================
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
      req.flash('error', 'We could not sign you in with Google. Please try again.');
      res.redirect('/login');
    }
  }
);

// ============================================================
// Logout
// ============================================================
router.post('/logout', (req, res) => {
  // No flash here: destroy() wipes the session the flash would live in
  req.session.destroy(() => res.redirect('/'));
});

// ============================================================
// Account
// ============================================================
router.get('/account', requireLogin, async (req, res) => {
  try {
    const [orders] = await pool.query(`
      SELECT o.id, o.status, o.total, o.created_at,
             COUNT(oi.id) AS item_count
      FROM orders o
      LEFT JOIN order_items oi ON oi.order_id = o.id
      WHERE o.user_id = ?
      GROUP BY o.id
      ORDER BY o.created_at DESC
    `, [req.session.user.id]);

    res.render('account', { title: 'My account', orders });
  } catch (err) {
    console.error(err);
    res.status(500).render('errors/500', { title: 'Something went wrong' });
  }
});

module.exports = router;