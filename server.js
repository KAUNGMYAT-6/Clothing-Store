// ---------- Requires ----------
const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { csrfSync } = require('csrf-sync');
const path = require('path');
require('dotenv').config();

const pool = require('./db/pool');
const passport = require('./lib/passport');
const { flash } = require('./middleware/flash');
const { getOrCreateCart, getCartCount } = require('./lib/cart');

const webhookRoutes = require('./routes/webhook');
const homeRoutes = require('./routes/home');
const productRoutes = require('./routes/products');
const authRoutes = require('./routes/auth');
const cartRoutes = require('./routes/cart');
const checkoutRoutes = require('./routes/checkout');
const adminRoutes = require('./routes/admin');
const accountRoutes = require('./routes/account');

// ---------- App setup ----------
const app = express();
const PORT = process.env.PORT || 3000;

if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ---------- Security headers ----------
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "https://cdn.jsdelivr.net", "https://fonts.googleapis.com", "'unsafe-inline'"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https:"],
      formAction: ["'self'", "https://checkout.stripe.com"]
    }
  }
}));

// Stripe webhook must come BEFORE any body parser and before CSRF:
// signature verification needs the raw body, and Stripe sends no CSRF token
app.use('/', webhookRoutes);

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
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 7   // 7 days
  }
}));

// Passport handles authentication only; sessions stay ours
app.use(passport.initialize());

// Flash messages — after sessions, before routes
app.use(flash);

// ---------- Safe template defaults ----------
// Set before anything that can throw, so error pages always render even
// when the middleware below never got a chance to run
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.cartCount = 0;
  res.locals.navCategories = [];
  res.locals.csrfToken = '';
  res.locals.path = req.path;
  next();
});

// ---------- CSRF (synchroniser token pattern) ----------
const { csrfSynchronisedProtection, generateToken } = csrfSync({
  // Normal forms send the token in the body. Multipart (file upload) forms
  // can't: express.urlencoded skips multipart, so req.body is undefined
  // here — guard it, and let those forms pass the token in the query string.
  getTokenFromRequest: (req) => (req.body && req.body._csrf) || req.query._csrf
});

app.use((req, res, next) => {
  res.locals.csrfToken = generateToken(req);
  next();
});

app.use(csrfSynchronisedProtection);

// ---------- Rate limiting ----------
// Keyed by IP. Generous enough for shared networks (a campus behind one
// NAT), tight enough to stop scripted brute force.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: 'Too many attempts. Please try again in a few minutes.'
});

// Resets send email, so they cost more than a page view. A second,
// per-account limit lives in routes/auth.js — IP limits alone don't stop
// a distributed attack on one person's inbox.
const resetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: 'Too many reset requests. Please try again later.'
});

app.use(['/login', '/register'], loginLimiter);
app.use('/forgot-password', resetLimiter);

// ---------- Live template data ----------
// Cart count for the navbar badge
app.use(async (req, res, next) => {
  try {
    if (req.session.user || req.session.guestToken) {
      const cart = await getOrCreateCart(req);
      res.locals.cartCount = await getCartCount(cart.id);
    }
  } catch (err) {
    // Leave the default of 0 — a broken badge shouldn't break the page
  }
  next();
});

// Categories for the nav dropdown
app.use(async (req, res, next) => {
  try {
    const [cats] = await pool.query(`
      SELECT c.id, c.name, COUNT(p.id) AS product_count
      FROM categories c
      LEFT JOIN products p ON p.category_id = c.id AND p.is_active = TRUE
      GROUP BY c.id, c.name
      ORDER BY c.name
    `);
    res.locals.navCategories = cats;
  } catch (err) {
    // Leave the default of []
  }
  next();
});

// ---------- Routes ----------
app.use('/admin', adminRoutes);
app.use('/', homeRoutes);
app.use('/', productRoutes);
app.use('/', authRoutes);
app.use('/', cartRoutes);
app.use('/', checkoutRoutes);
app.use('/account', accountRoutes);

// ---------- 404: nothing above matched ----------
app.use((req, res) => {
  res.status(404).render('errors/404', { title: 'Page not found' });
});

// ---------- Errors (must be last, and take four arguments) ----------
app.use((err, req, res, next) => {
  // Expired or missing CSRF token: send them back rather than dead-ending
  if (err.code === 'EBADCSRFTOKEN' || err.message === 'invalid csrf token') {
    if (req.flash) req.flash('warning', 'Your session expired. Please try that again.');
    return res.redirect(req.get('Referer') || '/');
  }

  // Multer rejected the upload (too large, wrong type)
  if (err.code === 'LIMIT_FILE_SIZE') {
    if (req.flash) req.flash('error', 'That file is too large. Maximum size is 5 MB.');
    return res.redirect(req.get('Referer') || '/admin/products');
  }

  console.error(err);
  res.status(500).render('errors/500', { title: 'Something went wrong' });
});

// ---------- Start ----------
const required = ['DB_HOST', 'DB_USER', 'DB_NAME', 'SESSION_SECRET',
                  'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'BASE_URL'];
const missing = required.filter(k => !process.env[k]);
if (missing.length) {
  console.warn('Missing environment variables:', missing.join(', '));
}

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});