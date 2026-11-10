const pool = require('../db/pool');

// Has this user actually bought this product?
//
// Joins order_items -> product_variants -> products, and only counts orders
// that were really paid for. Note the limitation: order_items.variant_id is
// ON DELETE SET NULL, so if an admin deletes a variant, orders containing it
// can no longer prove a purchase. Rare, and the alternative (denormalising
// product_id onto order_items) isn't worth a schema change here.
async function hasPurchased(userId, productId) {
  const [[row]] = await pool.query(`
    SELECT COUNT(*) AS n
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    JOIN product_variants v ON v.id = oi.variant_id
    WHERE o.user_id = ?
      AND v.product_id = ?
      AND o.status IN ('paid', 'shipped', 'delivered')
  `, [userId, productId]);

  return row.n > 0;
}

// Reviews for a product, newest first, with the reviewer's name
async function getReviews(productId) {
  const [rows] = await pool.query(`
    SELECT r.id, r.rating, r.body, r.created_at, r.user_id,
           u.name AS author
    FROM reviews r
    JOIN users u ON u.id = r.user_id
    WHERE r.product_id = ?
    ORDER BY r.created_at DESC
  `, [productId]);

  return rows;
}

// Average and count, plus a per-star breakdown for the summary bars
async function getRatingSummary(productId) {
  const [[row]] = await pool.query(`
    SELECT COUNT(*) AS count,
           COALESCE(AVG(rating), 0) AS average,
           SUM(rating = 5) AS five,
           SUM(rating = 4) AS four,
           SUM(rating = 3) AS three,
           SUM(rating = 2) AS two,
           SUM(rating = 1) AS one
    FROM reviews
    WHERE product_id = ?
  `, [productId]);

  return {
    count: Number(row.count),
    average: Number(row.average),
    breakdown: {
      5: Number(row.five) || 0,
      4: Number(row.four) || 0,
      3: Number(row.three) || 0,
      2: Number(row.two) || 0,
      1: Number(row.one) || 0
    }
  };
}

module.exports = { hasPurchased, getReviews, getRatingSummary };