-- ============================================================
-- DeniseClothing — database schema
-- ------------------------------------------------------------
-- RECONSTRUCTED from the queries in routes/ and lib/, because
-- the original file had been emptied. Every column the code
-- reads or writes is here.
--
-- Before trusting it over your real database, compare:
--   mysqldump --no-data --skip-comments -u root -p YOUR_DB > db/schema.dump.sql
-- and check the two agree. Your live database is the source
-- of truth; this file is what lets anyone else rebuild it.
--
-- Usage:  mysql -u root -p your_db < db/schema.sql
-- (the sessions table is created automatically on first run)
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  name              VARCHAR(100) NOT NULL,
  email             VARCHAR(255) NOT NULL,
  profile_photo_url VARCHAR(500) NULL,
  profile_photo_id  VARCHAR(255) NULL,          -- Cloudinary public_id
  password_hash     VARCHAR(255) NULL,          -- NULL for Google-only accounts
  google_id         VARCHAR(64)  NULL,
  role              ENUM('user', 'admin') NOT NULL DEFAULT 'user',
  created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY uq_users_email (email),
  UNIQUE KEY uq_users_google (google_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS categories (
  id    INT AUTO_INCREMENT PRIMARY KEY,
  name  VARCHAR(100) NOT NULL,
  slug  VARCHAR(120) NOT NULL,

  UNIQUE KEY uq_categories_slug (slug)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS products (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  category_id  INT NOT NULL,
  name         VARCHAR(200) NOT NULL,
  slug         VARCHAR(220) NOT NULL,
  description  TEXT NULL,
  -- DECIMAL, never FLOAT: 0.1 + 0.2 must equal 0.3 when it's money
  price        DECIMAL(10,2) NOT NULL,
  department   ENUM('men', 'women', 'unisex') NOT NULL DEFAULT 'unisex',
  -- Soft delete: hidden from the shop, but old orders still make sense
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY uq_products_slug (slug),
  -- RESTRICT: a category with products in it can't be deleted by accident
  CONSTRAINT fk_products_category
    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE RESTRICT,
  CONSTRAINT chk_products_price CHECK (price >= 0)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS product_variants (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  product_id      INT NOT NULL,
  size            VARCHAR(10) NOT NULL,
  color           VARCHAR(50) NOT NULL,
  sku             VARCHAR(64) NOT NULL,
  stock_quantity  INT NOT NULL DEFAULT 0,

  UNIQUE KEY uq_variants_sku (sku),
  UNIQUE KEY uq_variants_combo (product_id, size, color),
  CONSTRAINT fk_variants_product
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  -- Last line of defence against overselling
  CONSTRAINT chk_variants_stock CHECK (stock_quantity >= 0)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS product_images (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  product_id     INT NOT NULL,
  image_url      VARCHAR(500) NOT NULL,
  cloudinary_id  VARCHAR(255) NULL,             -- NULL for pasted URLs
  alt_text       VARCHAR(255) NULL,
  sort_order     INT NOT NULL DEFAULT 0,
  is_primary     BOOLEAN NOT NULL DEFAULT FALSE,

  CONSTRAINT fk_images_product
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  INDEX idx_images_product (product_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS carts (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  user_id      INT NULL,                        -- set for logged-in users
  guest_token  CHAR(64) NULL,                   -- set for guests
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY uq_carts_user (user_id),
  UNIQUE KEY uq_carts_guest (guest_token),
  CONSTRAINT fk_carts_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS cart_items (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  cart_id      INT NOT NULL,
  variant_id   INT NOT NULL,
  quantity     INT NOT NULL,
  added_price  DECIMAL(10,2) NOT NULL,          -- price when it went in the cart
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  -- One row per variant per cart. This is what ON DUPLICATE KEY UPDATE
  -- relies on to add quantities instead of inserting a second row.
  UNIQUE KEY uq_cart_variant (cart_id, variant_id),
  CONSTRAINT fk_cart_items_cart
    FOREIGN KEY (cart_id) REFERENCES carts(id) ON DELETE CASCADE,
  CONSTRAINT fk_cart_items_variant
    FOREIGN KEY (variant_id) REFERENCES product_variants(id) ON DELETE CASCADE,
  CONSTRAINT chk_cart_quantity CHECK (quantity > 0)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS orders (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  -- NULL + SET NULL: an order is a financial record and must
  -- outlive the account that placed it
  user_id            INT NULL,
  email              VARCHAR(255) NOT NULL,
  status             ENUM('pending', 'paid', 'shipped', 'delivered', 'cancelled')
                       NOT NULL DEFAULT 'pending',
  subtotal           DECIMAL(10,2) NOT NULL,
  shipping_fee       DECIMAL(10,2) NOT NULL,
  total              DECIMAL(10,2) NOT NULL,
  shipping_name      VARCHAR(100) NOT NULL,
  shipping_address   TEXT NOT NULL,
  -- UNIQUE is half of webhook idempotency: one Stripe session, one order
  stripe_session_id  VARCHAR(255) NULL,
  created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY uq_orders_stripe (stripe_session_id),
  CONSTRAINT fk_orders_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_orders_user (user_id),
  INDEX idx_orders_status (status)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS order_items (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  order_id      INT NOT NULL,
  -- SET NULL: deleting a variant must not delete sales history
  variant_id    INT NULL,
  -- Copied at purchase time, so the order still reads correctly
  -- after the product is renamed, repriced or deleted
  product_name  VARCHAR(200) NOT NULL,
  size          VARCHAR(10) NOT NULL,
  color         VARCHAR(50) NOT NULL,
  unit_price    DECIMAL(10,2) NOT NULL,
  quantity      INT NOT NULL,

  CONSTRAINT fk_order_items_order
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_order_items_variant
    FOREIGN KEY (variant_id) REFERENCES product_variants(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS reviews (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  product_id  INT NOT NULL,
  user_id     INT NOT NULL,
  rating      TINYINT NOT NULL,
  body        TEXT NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  -- One review per customer per product; posting again edits it
  UNIQUE KEY uq_review_product_user (product_id, user_id),
  CONSTRAINT fk_reviews_product
    FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  -- CASCADE: a review shows its author's name, so it leaves with them
  CONSTRAINT fk_reviews_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT chk_reviews_rating CHECK (rating BETWEEN 1 AND 5)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS password_resets (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  user_id     INT NOT NULL,
  -- SHA-256 of the token. The token itself is only ever in the email.
  token_hash  CHAR(64) NOT NULL,
  expires_at  DATETIME NOT NULL,
  used_at     DATETIME NULL,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY uq_resets_token (token_hash),
  CONSTRAINT fk_resets_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_resets_user (user_id, created_at)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS addresses (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  user_id         INT NOT NULL,
  label           VARCHAR(50)  NULL,            -- "Home", "Office"
  recipient_name  VARCHAR(100) NOT NULL,
  phone           VARCHAR(30)  NULL,
  line1           VARCHAR(255) NOT NULL,
  line2           VARCHAR(255) NULL,
  city            VARCHAR(100) NOT NULL,
  postal_code     VARCHAR(20)  NOT NULL,
  country         CHAR(2)      NOT NULL DEFAULT 'SG',
  is_default      BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  CONSTRAINT fk_addresses_user
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_addresses_user (user_id)
) ENGINE=InnoDB;
