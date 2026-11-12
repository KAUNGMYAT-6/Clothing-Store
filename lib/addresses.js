const pool = require('../db/pool');

// A cap keeps one account from filling the table with junk rows
const MAX_ADDRESSES = 10;

function clean(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

// ============================================================
// Read and check an address form.
// ------------------------------------------------------------
// Shared by the address book and checkout, so both accept and
// reject exactly the same input. Returns the cleaned values
// (to refill the form) and an error message, or null if valid.
// ============================================================
function readAddressForm(body) {
  const values = {
    label:          clean(body.label, 50),
    recipient_name: clean(body.recipient_name, 100),
    phone:          clean(body.phone, 30),
    line1:          clean(body.line1, 255),
    line2:          clean(body.line2, 255),
    // People type "730 123" or " 730123 "; store it as 730123
    postal_code:    clean(body.postal_code, 20).replace(/\s+/g, '')
  };

  let error = null;

  if (values.recipient_name.length < 2) {
    error = 'Enter the name of the person receiving the parcel.';
  } else if (!values.line1) {
    error = 'Enter the block or house number and street.';
  } else if (!/^\d{6}$/.test(values.postal_code)) {
    error = 'Singapore postal codes are 6 digits.';
  } else if (values.phone && !/^\+?[\d\s-]{8,20}$/.test(values.phone)) {
    error = "That phone number doesn't look right.";
  }

  return { values, error };
}

// ============================================================
// Turn a structured address into the text block stored on an
// order. orders.shipping_address is one TEXT column, so an order
// keeps its address exactly as it was, even if the customer
// edits or deletes the saved address afterwards.
// ============================================================
function formatAddress(address) {
  return [
    address.line1,
    address.line2,
    `Singapore ${address.postal_code}`,
    address.phone ? `Tel ${address.phone}` : null
  ].filter(Boolean).join('\n');
}

// Default first, then most recently changed
async function listAddresses(userId) {
  const [rows] = await pool.query(`
    SELECT * FROM addresses
    WHERE user_id = ?
    ORDER BY is_default DESC, updated_at DESC, id DESC
  `, [userId]);
  return rows;
}

// "AND user_id = ?" is the IDOR guard: an id from the URL or a
// form only ever finds the logged-in user's own address
async function getAddress(userId, addressId) {
  const [[row]] = await pool.query(
    'SELECT * FROM addresses WHERE id = ? AND user_id = ?',
    [addressId, userId]
  );
  return row || null;
}

async function countAddresses(db, userId) {
  const [[{ n }]] = await db.query(
    'SELECT COUNT(*) AS n FROM addresses WHERE user_id = ?', [userId]
  );
  return n;
}

// ============================================================
// Make one address the default.
// ------------------------------------------------------------
// One statement does it: every row of this user gets
// is_default = TRUE if its id matches, FALSE otherwise. No
// window where there are two defaults, or none.
// ============================================================
async function setDefault(db, userId, addressId) {
  await db.query(
    'UPDATE addresses SET is_default = (id = ?) WHERE user_id = ?',
    [addressId, userId]
  );
}

// `db` is either the pool or a connection inside a transaction,
// so checkout can save an address as part of placing an order
async function createAddress(db, userId, values, makeDefault = false) {
  // Someone's first address is always their default
  const isFirst = (await countAddresses(db, userId)) === 0;

  const [result] = await db.query(`
    INSERT INTO addresses
      (user_id, label, recipient_name, phone, line1, line2, city, postal_code, country)
    VALUES (?, ?, ?, ?, ?, ?, 'Singapore', ?, 'SG')
  `, [
    userId, values.label || null, values.recipient_name, values.phone || null,
    values.line1, values.line2 || null, values.postal_code
  ]);

  if (makeDefault || isFirst) await setDefault(db, userId, result.insertId);
  return result.insertId;
}

async function updateAddress(userId, addressId, values) {
  await pool.query(`
    UPDATE addresses
    SET label = ?, recipient_name = ?, phone = ?, line1 = ?, line2 = ?, postal_code = ?
    WHERE id = ? AND user_id = ?
  `, [
    values.label || null, values.recipient_name, values.phone || null,
    values.line1, values.line2 || null, values.postal_code,
    addressId, userId
  ]);
}

// ============================================================
// Delete, and if that was the default, promote the most recently
// updated one left. Done in a transaction so the account is never
// left with addresses but no default.
// ============================================================
async function deleteAddress(userId, addressId) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [[row]] = await connection.query(
      'SELECT is_default FROM addresses WHERE id = ? AND user_id = ? FOR UPDATE',
      [addressId, userId]
    );
    if (!row) {
      await connection.rollback();
      return false;
    }

    await connection.query(
      'DELETE FROM addresses WHERE id = ? AND user_id = ?',
      [addressId, userId]
    );

    if (row.is_default) {
      await connection.query(`
        UPDATE addresses SET is_default = TRUE
        WHERE user_id = ?
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
      `, [userId]);
    }

    await connection.commit();
    return true;
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

module.exports = {
  MAX_ADDRESSES,
  readAddressForm,
  formatAddress,
  listAddresses,
  getAddress,
  countAddresses,
  setDefault,
  createAddress,
  updateAddress,
  deleteAddress
};
