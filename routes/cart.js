const express = require('express');
const pool = require('../db/pool');
const { getOrCreateCart, getCartItems } = require('../lib/cart');
const { SHIPPING_FEE } = require('../lib/config');
const router = express.Router();

// --- View cart ---
router.get('/cart', async (req, res) => {
  try {
    if (!req.session.user && !req.session.guestToken) {
      return res.render('cart/index', { title: 'Your cart', items: [], subtotal: 0, shippingFee: SHIPPING_FEE });
    }

    const cart = await getOrCreateCart(req);
    const items = await getCartItems(cart.id);

    const subtotal = items.reduce(
      (sum, item) => sum + Number(item.current_price) * item.quantity,
      0
    );

    res.render('cart/index', { title: 'Your cart', items, subtotal, shippingFee: SHIPPING_FEE });
  } catch (err) {
    console.error(err);
    req.flash('error', 'We could not load your cart. Please try again.');
    res.redirect('/shop');
  }
});

// Most of one size a customer can have in their cart. Stops one
// person reserving a whole run of stock, and matches the limit the
// quantity buttons show.
const MAX_PER_ITEM = 10;

// --- Add to cart ---
router.post('/cart/add', async (req, res) => {
  const { variant_id, slug } = req.body;
  const quantity = parseInt(req.body.quantity, 10);

  try {
    if (!variant_id || !Number.isInteger(quantity) || quantity < 1) {
      req.flash('warning', 'Please choose a size and colour first.');
      return res.redirect(`/products/${slug}`);
    }

    const [[variant]] = await pool.query(
      `SELECT v.*, p.name, p.price
       FROM product_variants v
       JOIN products p ON p.id = v.product_id
       WHERE v.id = ? AND p.is_active = TRUE`,
      [variant_id]
    );

    if (!variant) {
      req.flash('error', 'That item is no longer available.');
      return res.redirect('/shop');
    }

    const cart = await getOrCreateCart(req);

    // Count what's ALREADY in the cart too. Checking only the new
    // amount let someone add the last one twice and end up with 2.
    const [[inCart]] = await pool.query(
      'SELECT quantity FROM cart_items WHERE cart_id = ? AND variant_id = ?',
      [cart.id, variant.id]
    );
    const already = inCart ? inCart.quantity : 0;
    const limit = Math.min(variant.stock_quantity, MAX_PER_ITEM);

    if (already + quantity > limit) {
      let message;
      if (variant.stock_quantity === 0) {
        message = 'That option just sold out.';
      } else if (already >= limit) {
        message = limit === variant.stock_quantity
          ? `You already have ${already} in your cart, which is all we have in that size.`
          : `You already have ${already} in your cart. The limit is ${MAX_PER_ITEM} per size.`;
      } else {
        const canAdd = limit - already;
        message = already
          ? `You have ${already} in your cart already, so you can add ${canAdd} more.`
          : `Only ${limit} available in that size. Please lower the quantity.`;
      }
      req.flash('warning', message);
      return res.redirect(`/products/${slug}`);
    }

    await pool.query(`
      INSERT INTO cart_items (cart_id, variant_id, quantity, added_price)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE quantity = quantity + VALUES(quantity)
    `, [cart.id, variant.id, quantity, variant.price]);

    req.flash('success', `${variant.name} (${variant.color}, ${variant.size}) added to your cart.`);
    res.redirect('/cart');
  } catch (err) {
    console.error(err);
    req.flash('error', 'We could not add that to your cart. Please try again.');
    res.redirect(`/products/${slug}`);
  }
});

// --- Update quantity ---
router.post('/cart/update', async (req, res) => {
  const { item_id } = req.body;
  const quantity = parseInt(req.body.quantity, 10);

  try {
    const cart = await getOrCreateCart(req);

    if (!Number.isInteger(quantity) || quantity < 1) {
      await pool.query(
        'DELETE FROM cart_items WHERE id = ? AND cart_id = ?',
        [item_id, cart.id]
      );
      req.flash('info', 'Item removed from your cart.');
      return res.redirect('/cart');
    }

    // Look the item up with its current stock. "AND cart_id = ?"
    // keeps people to their own cart.
    const [[item]] = await pool.query(`
      SELECT ci.id, v.stock_quantity
      FROM cart_items ci
      JOIN product_variants v ON v.id = ci.variant_id
      WHERE ci.id = ? AND ci.cart_id = ?
    `, [item_id, cart.id]);

    if (!item) {
      req.flash('error', 'That item is no longer in your cart.');
      return res.redirect('/cart');
    }

    if (item.stock_quantity === 0) {
      req.flash('warning', 'That size has sold out. Remove it to check out.');
      return res.redirect('/cart');
    }

    // Asked for more than we have: give them the most we can, and say so
    const limit = Math.min(item.stock_quantity, MAX_PER_ITEM);
    const allowed = Math.min(quantity, limit);

    await pool.query(
      'UPDATE cart_items SET quantity = ? WHERE id = ? AND cart_id = ?',
      [allowed, item.id, cart.id]
    );

    if (allowed < quantity) {
      req.flash('warning', limit === item.stock_quantity
        ? `Only ${limit} left in that size, so your cart has ${limit}.`
        : `The limit is ${MAX_PER_ITEM} per size, so your cart has ${MAX_PER_ITEM}.`);
    } else {
      req.flash('success', 'Cart updated.');
    }
    res.redirect('/cart');
  } catch (err) {
    console.error(err);
    req.flash('error', 'We could not update your cart.');
    res.redirect('/cart');
  }
});

// --- Remove item ---
router.post('/cart/remove', async (req, res) => {
  try {
    const cart = await getOrCreateCart(req);
    await pool.query(
      'DELETE FROM cart_items WHERE id = ? AND cart_id = ?',
      [req.body.item_id, cart.id]
    );
    req.flash('info', 'Item removed from your cart.');
    res.redirect('/cart');
  } catch (err) {
    console.error(err);
    req.flash('error', 'We could not remove that item.');
    res.redirect('/cart');
  }
});

module.exports = router;