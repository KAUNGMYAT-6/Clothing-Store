const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('../db/pool');
const passport = require('../lib/passport');
const { requireLogin } = require('../middleware/auth');
const { mergeGuestCart } = require('../lib/cart');
const { createResetToken, hashToken } = require('../lib/tokens');
const { sendPasswordReset } = require('../lib/mailer');

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

  // Wait for the session write before redirecting, so the next request
  // definitely sees the logged-in user
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

    const [existing] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
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
    const [users] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
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
// Password reset
// ============================================================
router.get('/forgot-password', (req, res) => {
  res.render('auth/forgot-password', { title: 'Reset password', error: null });
});

router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;

  // Identical response on every path below, so this form can't be used
  // to discover which emails have accounts
  const sameAnswer = () => {
    req.flash('info',
      'If an account exists for that email, a reset link is on its way. Check your inbox.');
    res.redirect('/login');
  };

  try {
    const [users] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
    const user = users[0];

    if (!user) return sameAnswer();

    // Per-account limit, on top of the per-IP limiter in server.js.
    // IP limits alone don't stop a distributed attack on one inbox.
    const [[recent]] = await pool.query(`
      SELECT COUNT(*) AS n FROM password_resets
      WHERE user_id = ? AND created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)
    `, [user.id]);

    if (recent.n >= 3) return sameAnswer();

    const { token, hash } = createResetToken();

    await pool.query(`
      INSERT INTO password_resets (user_id, token_hash, expires_at)
      VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 1 HOUR))
    `, [user.id, hash]);

    const resetUrl = `${process.env.BASE_URL}/reset-password/${token}`;

    try {
      await sendPasswordReset(user, resetUrl);
    } catch (mailErr) {
      console.error('Reset email failed:', mailErr);
    }

    sameAnswer();
  } catch (err) {
    console.error(err);
    res.status(500).render('auth/forgot-password', {
      title: 'Reset password',
      error: 'Something went wrong. Please try again.'
    });
  }
});

router.get('/reset-password/:token', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT * FROM password_resets
      WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW()
    `, [hashToken(req.params.token)]);

    if (rows.length === 0) {
      req.flash('error', 'That reset link has expired or already been used. Request a new one.');
      return res.redirect('/forgot-password');
    }

    res.render('auth/reset-password', {
      title: 'Choose a new password',
      token: req.params.token,
      error: null
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('errors/500', { title: 'Something went wrong' });
  }
});

router.post('/reset-password/:token', async (req, res) => {
  const { password, confirm_password } = req.body;
  const token = req.params.token;

  const connection = await pool.getConnection();
  try {
    if (!password || password.length < 8) {
      return res.status(400).render('auth/reset-password', {
        title: 'Choose a new password', token,
        error: 'Your password needs at least 8 characters.'
      });
    }

    if (password !== confirm_password) {
      return res.status(400).render('auth/reset-password', {
        title: 'Choose a new password', token,
        error: 'Those passwords do not match.'
      });
    }

    await connection.beginTransaction();

    // Lock the row so the same token can't be redeemed twice at once
    const [rows] = await connection.query(`
      SELECT * FROM password_resets
      WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW()
      FOR UPDATE
    `, [hashToken(token)]);

    if (rows.length === 0) {
      await connection.commit();
      req.flash('error', 'That reset link has expired or already been used.');
      return res.redirect('/forgot-password');
    }

    const reset = rows[0];
    const passwordHash = await bcrypt.hash(password, 12);

    await connection.query(
      'UPDATE users SET password_hash = ? WHERE id = ?',
      [passwordHash, reset.user_id]
    );

    // Mark this token used, and void any other outstanding ones
    await connection.query(`
      UPDATE password_resets SET used_at = NOW()
      WHERE user_id = ? AND used_at IS NULL
    `, [reset.user_id]);

    await connection.commit();

    req.flash('success', 'Password changed. You can log in now.');
    res.redirect('/login');
  } catch (err) {
    await connection.rollback();
    console.error(err);
    res.status(500).render('auth/reset-password', {
      title: 'Choose a new password', token,
      error: 'Something went wrong. Please try again.'
    });
  } finally {
    connection.release();
  }
});

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