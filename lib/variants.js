// ============================================================
// Variants (one size + colour of a product) — shared rules
// ------------------------------------------------------------
// Used by "new product" and "add a variant" so both accept and
// reject exactly the same input, with the same messages.
// ============================================================

// Must match the column sizes in product_variants
const MAX_COLOR = 50;
const MAX_SIZE = 10;
const MAX_STOCK = 100000;

// Common sizes, offered as suggestions in the form
const SIZE_SUGGESTIONS = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'One Size'];

function squeeze(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

// "navy blue" -> "Navy Blue". MySQL compares text without caring
// about case, so "black" and "Black" were already treated as the
// same colour. Storing one consistent spelling makes that visible.
function titleCase(value) {
  return value.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (m, sep, ch) => sep + ch.toUpperCase());
}

// Short sizes are codes (s, xl, 2xl, 32) -> upper case.
// Longer ones are words ("one size") -> title case.
function tidySize(value) {
  return value.length <= 4 ? value.toUpperCase() : titleCase(value);
}

// ============================================================
// Clean and check one variant.
// Returns { values, error }. error is null when it's fine.
// ============================================================
function readVariant({ color, size, stock }) {
  const values = {
    color: titleCase(squeeze(color)),
    size: tidySize(squeeze(size)),
    stock: String(stock === undefined || stock === null ? '' : stock).trim()
  };

  if (!values.color) return { values, error: 'Enter a colour.' };
  if (!values.size) return { values, error: 'Enter a size.' };
  if (values.color.length > MAX_COLOR) {
    return { values, error: `Colour can be at most ${MAX_COLOR} characters.` };
  }
  if (values.size.length > MAX_SIZE) {
    return { values, error: `Size can be at most ${MAX_SIZE} characters (try "XL" instead of "Extra Large").` };
  }

  // Blank stock means none yet
  const stockNumber = values.stock === '' ? 0 : Number(values.stock);
  if (!Number.isInteger(stockNumber) || stockNumber < 0 || stockNumber > MAX_STOCK) {
    return { values, error: `Stock for ${values.color} · ${values.size} must be a whole number from 0 to ${MAX_STOCK}.` };
  }
  values.stock = stockNumber;

  return { values, error: null };
}

// Same colour + size, ignoring case — the way MySQL compares them
function sameVariant(a, b) {
  return a.color.toLowerCase() === b.color.toLowerCase()
      && a.size.toLowerCase() === b.size.toLowerCase();
}

// ============================================================
// SKU (stock-keeping unit)
// ------------------------------------------------------------
// Must be unique across the WHOLE shop, not just this product.
// Typing them by hand was the main reason adding a variant
// "sometimes" failed: "13" or "BLK-S" was already used by some
// other product. Generated ones look like P12-NAVY-BLUE-XL.
// ============================================================
function baseSku(productId, color, size) {
  const part = s => s.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `P${productId}-${part(color)}-${part(size)}`.slice(0, 56);
}

async function freeSku(db, wanted) {
  // Normally the first try is free. The loop only matters if someone
  // typed this exact SKU by hand for another product.
  for (let n = 1; n < 50; n++) {
    const candidate = n === 1 ? wanted : `${wanted}-${n}`;
    const [[taken]] = await db.query('SELECT id FROM product_variants WHERE sku = ?', [candidate]);
    if (!taken) return candidate;
  }
  throw new Error('Could not find a free SKU');
}

// `db` is the pool or a connection inside a transaction
async function insertVariant(db, productId, values, typedSku = '') {
  const sku = typedSku ? typedSku : await freeSku(db, baseSku(productId, values.color, values.size));

  await db.query(`
    INSERT INTO product_variants (product_id, size, color, sku, stock_quantity)
    VALUES (?, ?, ?, ?, ?)
  `, [productId, values.size, values.color, sku, values.stock]);

  return sku;
}

module.exports = {
  MAX_COLOR,
  MAX_SIZE,
  SIZE_SUGGESTIONS,
  readVariant,
  sameVariant,
  insertVariant
};
