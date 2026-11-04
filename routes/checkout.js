const express = require('express');
const pool = require('../db/pool');
const { getOrCreateCart, getCartItems } = require('../lib/cart');
const { SHIPPING_FEE } = require('../lib/config');

const router = express.Router();

router.get('/checkout', async (req, res) => {
  try {
    if (!req.session.user && !req.session.guestToken) {
      return res.redirect('/cart');
    }

    const cart = await getOrCreateCart(req);
    const items = await getCartItems(cart.id);

    if (items.length === 0) return res.redirect('/cart');

    // Anything out of stock blocks checkout
    const unavailable = items.filter(i => i.stock_quantity < i.quantity);
    if (unavailable.length) {
      return res.redirect('/cart?error=stock');
    }

    const subtotal = items.reduce(
      (sum, i) => sum + Number(i.current_price) * i.quantity,
      0
    );

    res.render('checkout/index', {
      title: 'Checkout',
      items,
      subtotal,
      shippingFee: SHIPPING_FEE,
      total: subtotal + SHIPPING_FEE,
      error: null
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Could not load checkout');
  }
});

module.exports = router;