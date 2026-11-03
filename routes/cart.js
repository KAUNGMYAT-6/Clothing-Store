const express = require('express');
const pool = require('../db/pool');
const { getOrCreateCart, getCartItems } = require('../lib/cart');

const router = express.Router();

// --- View cart ---
router.get('/cart', async (req, res) => {
  try {
    if (!req.session.user && !req.session.guestToken) {
      return res.render('cart/index', { title: 'Your cart', items: [], subtotal: 0 });
    }

    const cart = await getOrCreateCart(req);
    const items = await getCartItems(cart.id);

    const subtotal = items.reduce(
      (sum, item) => sum + Number(item.current_price) * item.quantity,
      0
    );

    res.render('cart/index', { title: 'Your cart', items, subtotal });
  } catch (err) {
    console.error(err);
    res.status(500).send('Could not load cart');
  }
});

// --- Add to cart ---
router.post('/cart/add', async (req, res) => {
  const { variant_id, slug } = req.body;
  const quantity = parseInt(req.body.quantity, 10);

  try {
    if (!variant_id || !Number.isInteger(quantity) || quantity < 1) {
      return res.redirect(`/products/${slug}`);
    }

    const [[variant]] = await pool.query(
      `SELECT v.*, p.price
       FROM product_variants v
       JOIN products p ON p.id = v.product_id
       WHERE v.id = ?`,
      [variant_id]
    );

    if (!variant) return res.redirect('/');

    if (variant.stock_quantity < quantity) {
      return res.redirect(`/products/${slug}?error=stock`);
    }

    const cart = await getOrCreateCart(req);

    await pool.query(`
      INSERT INTO cart_items (cart_id, variant_id, quantity, added_price)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE quantity = quantity + VALUES(quantity)
    `, [cart.id, variant.id, quantity, variant.price]);

    res.redirect('/cart');
  } catch (err) {
    console.error(err);
    res.status(500).send('Could not add to cart');
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
      return res.redirect('/cart');
    }

    await pool.query(
      'UPDATE cart_items SET quantity = ? WHERE id = ? AND cart_id = ?',
      [quantity, item_id, cart.id]
    );

    res.redirect('/cart');
  } catch (err) {
    console.error(err);
    res.status(500).send('Could not update cart');
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
    res.redirect('/cart');
  } catch (err) {
    console.error(err);
    res.status(500).send('Could not update cart');
  }
});

module.exports = router;