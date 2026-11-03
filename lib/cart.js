const crypto = require('crypto');
const pool = require('../db/pool');

// Finds the current cart, or creates one. Works for both guests and users.
async function getOrCreateCart(req) {
  const userId = req.session.user ? req.session.user.id : null;

  if (userId) {
    const [rows] = await pool.query(
      'SELECT * FROM carts WHERE user_id = ?',
      [userId]
    );
    if (rows.length) return rows[0];

    const [result] = await pool.query(
      'INSERT INTO carts (user_id) VALUES (?)',
      [userId]
    );
    return { id: result.insertId, user_id: userId, guest_token: null };
  }

  // Guest: identified by a random token stored in the session
  if (!req.session.guestToken) {
    req.session.guestToken = crypto.randomBytes(32).toString('hex');
  }
  const token = req.session.guestToken;

  const [rows] = await pool.query(
    'SELECT * FROM carts WHERE guest_token = ?',
    [token]
  );
  if (rows.length) return rows[0];

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
  const [rows] = await pool.query(
    'SELECT COALESCE(SUM(quantity), 0) AS count FROM cart_items WHERE cart_id = ?',
    [cartId]
  );
  return Number(rows[0].count);
}

// Called at login: moves a guest cart's items into the user's cart
async function mergeGuestCart(req, userId) {
  const token = req.session.guestToken;
  if (!token) return;

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // Does a guest cart exist for this token?
    const [guestCarts] = await connection.query(
      'SELECT id FROM carts WHERE guest_token = ?',
      [token]
    );

    if (guestCarts.length === 0) {
      await connection.commit();
      delete req.session.guestToken;
      return;
    }

    const guestCartId = guestCarts[0].id;

    // Find or create the user's cart
    const [userCarts] = await connection.query(
      'SELECT id FROM carts WHERE user_id = ?',
      [userId]
    );

    let userCartId;
    if (userCarts.length > 0) {
      userCartId = userCarts[0].id;
    } else {
      const [result] = await connection.query(
        'INSERT INTO carts (user_id) VALUES (?)',
        [userId]
      );
      userCartId = result.insertId;
    }

    // Move items across, combining quantities where the variant already exists
    await connection.query(`
      INSERT INTO cart_items (cart_id, variant_id, quantity, added_price)
      SELECT ?, ci.variant_id, ci.quantity, ci.added_price
      FROM cart_items ci
      WHERE ci.cart_id = ?
      ON DUPLICATE KEY UPDATE quantity = cart_items.quantity + VALUES(quantity)
    `, [userCartId, guestCartId]);

    // Remove the now-empty guest cart (cart_items cascade)
    await connection.query('DELETE FROM carts WHERE id = ?', [guestCartId]);

    await connection.commit();
    delete req.session.guestToken;
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

module.exports = { getOrCreateCart, getCartItems, getCartCount, mergeGuestCart };