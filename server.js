// ---------- Requires ----------
const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const path = require('path');
require('dotenv').config();

const pool = require('./db/pool');
const { getOrCreateCart, getCartCount } = require('./lib/cart');

const webhookRoutes = require('./routes/webhook');
const productRoutes = require('./routes/products');
const authRoutes = require('./routes/auth');
const cartRoutes = require('./routes/cart');
const checkoutRoutes = require('./routes/checkout');
const adminRoutes = require('./routes/admin');

// ---------- App setup ----------
const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Stripe webhook must come BEFORE any body parser:
// signature verification needs the raw, unparsed request body
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
    maxAge: 1000 * 60 * 60 * 24 * 7   // 7 days
  }
}));

// Make the logged-in user available to every template
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  next();
});

// Cart count for the navbar badge
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
app.use('/', productRoutes);
app.use('/', authRoutes);
app.use('/', cartRoutes);
app.use('/', checkoutRoutes);

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});