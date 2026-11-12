const express = require('express');
const bcrypt = require('bcrypt');
const passport = require('passport');

const pool = require('../db/pool');
const { mergeGuestCart } = require('../lib/cart');
const { createResetToken, hashToken } = require('../lib/tokens');
const { sendPasswordReset } = require('../lib/mailer');

const router = express.Router();

// bcrypt work factor. 12 is slow on purpose — roughly a quarter
// of a second per hash. Users don't notice; someone brute-forcing
// a stolen database very much does.
const BCRYPT_ROUNDS = 12;

// Reset requests allowed per account per hour (separate from the
// per-IP limiter in server.js)
const RESET_LIMIT_PER_ACCOUNT = 3;

// How long a reset link stays valid
const RESET_TOKEN_MINUTES = 60;

// ============================================================
// Shared: start a session, merge the guest cart, redirect
// ------------------------------------------------------------
// Used by register, login and the Google callback so all three
// behave identically.
// ============================================================
async function startSession(req, res, user, fallback = '/') {
  req.session.user = {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    profile_photo_url: user.profile_photo_url || null
  };

  // Cart merging must not be able to break logging in. The first
  // version of this had no inner try/catch, so a merge failure was
  // caught by the route's catch and the user had to log in twice.
  try {
    await mergeGuestCart(req, user.id);
  } catch (err) {
    console.error('Cart merge failed (login continues):', err.message);
  }

  // Where they were headed before being bounced to login
  const target = req.session.returnTo || fallback;
  delete req.session.returnTo;

  // Writing the session is async. Redirecting without waiting is a
  // race: the next request can arrive before the write lands, and
  // the page renders as if logged out.
  return new Promise((resolve) => {
    req.session.save(() => {
      res.redirect(target);
      resolve();
    });
  });
}

// ============================================================
// REGISTER
// ============================================================
router.get('/register', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('auth/register', { title: 'Create an account', error: null, values: {} });
});

router.post('/register', async (req, res, next) => {
  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const { password, confirm_password } = req.body;

  function fail(message) {
    return res.status(400).render('auth/register', {
      title: 'Create an account',
      error: message,
      values: { name, email }   // keep what they typed, never the password
    });
  }

  try {
    if (name.length < 2 || name.length > 100) {
      return fail('Your name needs to be between 2 and 100 characters.');
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return fail("That doesn't look like an email address.");
    }
    if (!password || password.length < 8) {
      return fail('Your password must be at least 8 characters.');
    }
    if (password !== confirm_password) {
      return fail('The two passwords do not match.');
    }

    const [[existing]] = await pool.query(
      'SELECT id FROM users WHERE email = ?', [email]
    );
    if (existing) {
      return fail('That email is already registered. Try logging in instead.');
    }

    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const [result] = await pool.query(
      'INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)',
      [name, email, hash, 'user']
    );

    await startSession(req, res, {
      id: result.insertId, name, email, role: 'user', profile_photo_url: null
    });
  } catch (err) {
    next(err);
  }
});

// ============================================================
// LOGIN
// ============================================================
router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('auth/login', { title: 'Log in', error: null, values: {} });
});

router.post('/login', async (req, res, next) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const { password } = req.body;

  try {
    const [[user]] = await pool.query(
      'SELECT * FROM users WHERE email = ?', [email]
    );

    // One message for both "no such email" and "wrong password".
    // Telling them which is wrong confirms whether an address is
    // registered here, which is a privacy leak.
    const WRONG = 'Email or password is incorrect.';

    if (!user || !user.password_hash) {
      return res.status(401).render('auth/login', {
        title: 'Log in', error: WRONG, values: { email }
      });
    }

    const ok = await bcrypt.compare(password || '', user.password_hash);
    if (!ok) {
      return res.status(401).render('auth/login', {
        title: 'Log in', error: WRONG, values: { email }
      });
    }

    await startSession(req, res, user);
  } catch (err) {
    next(err);
  }
});

// ============================================================
// LOGOUT
// ------------------------------------------------------------
// POST, not GET. A GET logout can be fired by any <img> tag on
// any site, and CSRF protection doesn't apply to GET.
// ============================================================
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    // Must match the `key` given to session() in server.js
    res.clearCookie('store_sid');
    res.redirect('/');
  });
});

// ============================================================
// GOOGLE OAUTH
// ------------------------------------------------------------
// session: false — Passport's own session handling is switched
// off because this app manages req.session.user itself. Letting
// both run would give two sources of truth.
// The strategy itself is configured in lib/passport.js.
// ============================================================
router.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'], session: false })
);

router.get('/auth/google/callback',
  passport.authenticate('google', {
    session: false,
    failureRedirect: '/login'
  }),
  async (req, res, next) => {
    try {
      // req.user comes from the strategy's verify callback, which
      // links by email: an existing account with the same address
      // gets the Google id attached rather than a duplicate created
      await startSession(req, res, req.user);
    } catch (err) {
      next(err);
    }
  }
);

// ============================================================
// FORGOT PASSWORD
// ============================================================
router.get('/forgot-password', (req, res) => {
  res.render('auth/forgot-password', { title: 'Reset your password', error: null });
});

router.post('/forgot-password', async (req, res, next) => {
  const email = (req.body.email || '').trim().toLowerCase();

  // Deliberately identical whether or not the address exists
  const GENERIC = 'If that email is registered, a reset link is on its way.';

  try {
    const [[user]] = await pool.query(
      'SELECT id, name, email FROM users WHERE email = ?', [email]
    );

    if (!user) {
      req.flash('success', GENERIC);
      return res.redirect('/forgot-password');
    }

    // Per-account limit, on top of the per-IP limiter in server.js.
    // IP limiting alone doesn't stop someone hammering one account
    // from a botnet; account limiting alone doesn't stop someone
    // walking a list of addresses from one machine. You need both.
    const [[{ recent }]] = await pool.query(`
      SELECT COUNT(*) AS recent
      FROM password_resets
      WHERE user_id = ? AND created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)
    `, [user.id]);

    if (recent >= RESET_LIMIT_PER_ACCOUNT) {
      req.flash('error',
        'Too many reset requests for this account. Please wait an hour and try again, ' +
        'or check your inbox and spam folder for a link we already sent.');
      return res.redirect('/forgot-password');
    }

    // token goes in the email; only its hash goes in the database
    const { token, hash } = createResetToken();

    // The database works out the expiry, so the app server's clock
    // and time zone never come into it
    await pool.query(`
      INSERT INTO password_resets (user_id, token_hash, expires_at)
      VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))
    `, [user.id, hash, RESET_TOKEN_MINUTES]);

    const link = `${process.env.BASE_URL}/reset-password/${token}`;

    try {
      // Resend reports most failures in the response instead of throwing
      const result = await sendPasswordReset(user, link);
      if (result && result.error) throw new Error(result.error.message);
    } catch (e) {
      console.error('[EMAIL FAILED] password reset to', user.email, '-', e.message);
    }

    req.flash('success', GENERIC);
    res.redirect('/forgot-password');
  } catch (err) {
    next(err);
  }
});

// ============================================================
// RESET PASSWORD
// ------------------------------------------------------------
// The database stores a SHA-256 hash of the token, never the token.
// If the database leaks, the hashes are useless for logging in.
//
// SHA-256 here, bcrypt for passwords — that difference is on
// purpose. bcrypt is slow to defend weak, guessable passwords.
// A 32-byte random token has nothing to guess, so slow hashing
// buys nothing and only makes every reset click sluggish.
// ============================================================
async function findValidToken(rawToken) {
  const [[row]] = await pool.query(`
    SELECT pr.*, u.id AS uid, u.name, u.email, u.role, u.profile_photo_url
    FROM password_resets pr
    JOIN users u ON u.id = pr.user_id
    WHERE pr.token_hash = ?
      AND pr.used_at IS NULL
      AND pr.expires_at > NOW()
  `, [hashToken(rawToken)]);

  return row || null;
}

router.get('/reset-password/:token', async (req, res, next) => {
  try {
    const row = await findValidToken(req.params.token);

    if (!row) {
      req.flash('error', 'That reset link has expired or was already used. Request a new one below.');
      return res.redirect('/forgot-password');
    }

    res.render('auth/reset-password', {
      title: 'Choose a new password',
      token: req.params.token,
      error: null
    });
  } catch (err) {
    next(err);
  }
});

router.post('/reset-password/:token', async (req, res, next) => {
  const { password, confirm_password } = req.body;

  try {
    const row = await findValidToken(req.params.token);

    if (!row) {
      req.flash('error', 'That reset link has expired or was already used. Request a new one below.');
      return res.redirect('/forgot-password');
    }

    if (!password || password.length < 8) {
      return res.status(400).render('auth/reset-password', {
        title: 'Choose a new password',
        token: req.params.token,
        error: 'Your password must be at least 8 characters.'
      });
    }

    if (password !== confirm_password) {
      return res.status(400).render('auth/reset-password', {
        title: 'Choose a new password',
        token: req.params.token,
        error: 'The two passwords do not match.'
      });
    }

    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      await connection.query(
        'UPDATE users SET password_hash = ? WHERE id = ?', [hash, row.uid]
      );

      // Burn this token and every other outstanding one for the
      // account. If someone requested three resets, the other two
      // links must stop working the moment one is used.
      await connection.query(
        'UPDATE password_resets SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL',
        [row.uid]
      );

      await connection.commit();
    } catch (e) {
      await connection.rollback();
      throw e;
    } finally {
      connection.release();
    }

    req.flash('success', 'Password updated. You can log in now.');
    res.redirect('/login');
  } catch (err) {
    next(err);
  }
});

module.exports = router;