const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const path = require('path');
require('dotenv').config();

const pool = require('./db/pool');
const productRoutes = require('./routes/products');
const authRoutes = require('./routes/auth');
const { requireAdmin } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

const sessionStore = new MySQLStore({}, pool);

app.use(session({
  key: 'store_sid',
  secret: process.env.SESSION_SECRET,
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  next();
});

const { getOrCreateCart, getCartCount } = require('./lib/cart');

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

// Mount route modules
app.use('/', productRoutes);
app.use('/', authRoutes);

const cartRoutes = require('./routes/cart');
app.use('/', cartRoutes);

app.get('/admin', requireAdmin, (req, res) => {
  res.send('Admin area');
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});