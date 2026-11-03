const crypto = require('crypto');
const pool = require('../db/pool');

// Finds the current cart, or creates one. Works for both guests and users.
async function getOrCreateCart(req) {
  const userId = req.session.user ? req.session.user.id : null;

  if (userId) {
    const [[existing]] = await pool.query(
      'SELECT * FROM carts WHERE user_id = ?',
      [userId]
    );
    if (existing) return existing;

    const [result] = await pool.query(
      'INSERT INTO carts (user_id) VALUES (?)',
      [userId]
    );
    return { id: result.insertId, user_id: userId, guest_token: null };
  }

  // Guest: identified by a token stored in the session
  if (!req.session.guestToken) {
    req.session.guestToken = crypto.randomBytes(32).toString('hex');
  }
  const token = req.session.guestToken;

  const [[existing]] = await pool.query(
    'SELECT * FROM carts WHERE guest_token = ?',
    [token]
  );
  if (existing) return existing;

  const [result] = await pool.query(
    'INSERT INTO carts (guest_token) VALUES (?)',
    [token]
  );
  return { id: result.insertId, user_id: null, guest_token: token };
}

// Full cart contents, with live product data joined in
async function getCartItems(cartId) {
  const [items] = await pool.query(`
    SELECT ci.id, ci.quantity, ci.added_price,
           v.id AS variant_id, v.size, v.color, v.stock_quantity,
           p.name, p.slug, p.price AS current_price,
           i.image_url
    FROM cart_items ci
    JOIN product_variants v ON v.id = ci.variant_id
    JOIN products p ON p.id = v.product_id
    LEFT JOIN product_images i
      ON i.product_id = p.id AND i.is_primary = TRUE
    WHERE ci.cart_id = ?
    ORDER BY ci.created_at
  `, [cartId]);

  return items;
}

// Count of items, for the navbar badge
async function getCartCount(cartId) {
  const [[row]] = await pool.query(
    'SELECT COALESCE(SUM(quantity), 0) AS count FROM cart_items WHERE cart_id = ?',
    [cartId]
  );
  return Number(row.count);
}

module.exports = { getOrCreateCart, getCartItems, getCartCount };