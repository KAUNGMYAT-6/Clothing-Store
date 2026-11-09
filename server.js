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

// Flash messages — after sessions (it uses req.session), before routes (they call req.flash)
app.use(flash);

// ---------- CSRF (synchroniser token pattern: the token lives in the session) ----------
const { csrfSynchronisedProtection, generateToken } = csrfSync({
  getTokenFromRequest: (req) => req.body._csrf
});

app.use((req, res, next) => {
  res.locals.csrfToken = generateToken(req);
  next();
});

app.use(csrfSynchronisedProtection);

// ---------- Rate limiting ----------
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: 'Too many attempts. Please try again later.'
});

app.use(['/login', '/register'], authLimiter);

// ---------- Template locals ----------
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  next();
});

app.use(async (req, res, next) => {
  try {
    if (req.session.user || req.session.guestToken) {
      const cart = await getOrCreateCart(req);
      res.locals.cartCount = await getCartCount(cart.id);
    } else {
      res.locals.cartCount = 0;
    }
    next();
  } catch (err) {
    res.locals.cartCount = 0;
    next();
  }
});

// ---------- Routes ----------
app.use('/admin', adminRoutes);
app.use('/', homeRoutes);
app.use('/', productRoutes);
app.use('/', authRoutes);
app.use('/', cartRoutes);
app.use('/', checkoutRoutes);

// ---------- Error handling (must be last, and take four arguments) ----------
app.use((err, req, res, next) => {
  if (err.code === 'EBADCSRFTOKEN' || err.message === 'invalid csrf token') {
    return res.status(403).send('Your session expired. Please go back and try again.');
  }
  console.error(err);
  res.status(500).send('Something went wrong.');
});

// ---------- 404: no route matched ----------
app.use((req, res) => {
  res.status(404).render('errors/404', { title: 'Page not found' });
});

// ---------- Errors (must be last, and take four arguments) ----------
app.use((err, req, res, next) => {
  if (err.code === 'EBADCSRFTOKEN' || err.message === 'invalid csrf token') {
    req.flash('warning', 'Your session expired. Please try that again.');
    return res.redirect('back');
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