// ============================================================
// npm test
// ------------------------------------------------------------
// 1. Builds a brand new test database from db/schema.sql and
//    fills it with a few sample products
// 2. Starts the app on its own port, pointed at that database,
//    with FAKE Stripe / Resend / Cloudinary / Google keys, so no
//    real payment, email or upload can happen
// 3. Runs every check in tests/e2e.test.js
// 4. Stops the app and prints the result
//
// It never touches your normal database. The database name in
// .env.test has to end in "_test", otherwise it refuses to run,
// because step 1 deletes and rebuilds that database every time.
//
//   npm test             -> summary and any failures
//   npm test -- --verbose -> every check as it runs
// ============================================================
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
const verbose = process.argv.includes('--verbose');

// --- Settings: database login from .env.test, everything else fixed ---
const envFile = path.join(ROOT, '.env.test');
if (!fs.existsSync(envFile)) {
  console.error('Missing .env.test. Copy .env.test.example to .env.test and put your MySQL login in it.');
  process.exit(1);
}
const testEnv = require('dotenv').parse(fs.readFileSync(envFile));

const db = {
  host: testEnv.DB_HOST || 'localhost',
  port: Number(testEnv.DB_PORT) || 3306,
  user: testEnv.DB_USER || 'root',
  password: testEnv.DB_PASSWORD || '',
  database: testEnv.DB_NAME || 'denise_test'
};
const PORT = Number(testEnv.TEST_PORT) || 3111;
const BASE = `http://localhost:${PORT}`;
const WEBHOOK_SECRET = 'whsec_test_only_not_a_real_secret';

if (!/_test$/.test(db.database)) {
  console.error(`DB_NAME in .env.test is "${db.database}". It must end in _test, because the tests delete and rebuild it.`);
  process.exit(1);
}

// --- Step 1: fresh database ---
async function buildDatabase() {
  const conn = await mysql.createConnection({
    host: db.host, port: db.port, user: db.user, password: db.password,
    multipleStatements: true
  });

  await conn.query(`DROP DATABASE IF EXISTS \`${db.database}\``);
  await conn.query(`CREATE DATABASE \`${db.database}\` CHARACTER SET utf8mb4`);
  await conn.query(`USE \`${db.database}\``);

  const schema = fs.readFileSync(path.join(ROOT, 'db', 'schema.sql'), 'utf8');
  await conn.query(schema);

  // Some versions of the categories table have a slug column, some don't
  const [slugColumn] = await conn.query("SHOW COLUMNS FROM categories LIKE 'slug'");
  if (slugColumn.length) {
    await conn.query("INSERT INTO categories (name, slug) VALUES ('Tops','tops'), ('Bottoms','bottoms'), ('Outerwear','outerwear')");
  } else {
    await conn.query("INSERT INTO categories (name) VALUES ('Tops'), ('Bottoms'), ('Outerwear')");
  }

  // The checks expect exactly these, with these ids
  await conn.query(`
    INSERT INTO products (category_id, name, slug, description, price, department) VALUES
      (1, 'Oversized Linen Shirt', 'oversized-linen-shirt', 'Breezy linen with a relaxed cut.', 49.90, 'unisex'),
      (2, 'High-waist Chino', 'high-waist-chino', 'Tapered chino in stretch twill.', 59.00, 'women'),
      (3, 'Coach Jacket', 'coach-jacket', 'Water-resistant shell.', 89.00, 'men');
    INSERT INTO product_variants (product_id, size, color, sku, stock_quantity) VALUES
      (1, 'M', 'White', 'LIN-M-WHT', 5), (1, 'L', 'White', 'LIN-L-WHT', 2),
      (2, 'S', 'Khaki', 'CHI-S-KHA', 4), (3, 'L', 'Black', 'COA-L-BLK', 0);
    INSERT INTO product_images (product_id, image_url, alt_text, sort_order, is_primary) VALUES
      (1, 'https://placehold.co/600x800?text=Linen', 'Linen shirt', 0, TRUE);
  `);

  await conn.end();
}

// --- Step 2: start the app ---
function startApp() {
  // Every setting is given here, so nothing from your real .env is
  // used (dotenv never overwrites a value that's already set)
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(PORT),
    BASE_URL: BASE,
    DB_HOST: db.host,
    DB_PORT: String(db.port),
    DB_USER: db.user,
    DB_PASSWORD: db.password,
    DB_NAME: db.database,
    SESSION_SECRET: 'test-session-secret',
    STRIPE_SECRET_KEY: 'sk_test_fake_key_for_tests',
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    RESEND_API_KEY: 're_fake_key_for_tests',
    MAIL_FROM: 'tests@example.test',
    SUPPORT_EMAIL: 'support@example.test',
    CLOUDINARY_CLOUD_NAME: 'fake',
    CLOUDINARY_API_KEY: 'fake',
    CLOUDINARY_API_SECRET: 'fake',
    GOOGLE_CLIENT_ID: 'fake',
    GOOGLE_CLIENT_SECRET: 'fake',
    GOOGLE_CALLBACK_URL: `${BASE}/auth/google/callback`
  };

  const app = spawn(process.execPath, ['server.js'], { cwd: ROOT, env });

  // Keep the app's output quiet unless something goes wrong
  const output = [];
  const keep = chunk => {
    output.push(...chunk.toString().split('\n'));
    if (output.length > 200) output.splice(0, output.length - 200);
  };
  app.stdout.on('data', keep);
  app.stderr.on('data', keep);

  return { app, output };
}

async function waitForApp(app) {
  for (let i = 0; i < 40; i++) {
    if (app.exitCode !== null) return false;
    try {
      await fetch(BASE + '/');
      return true;
    } catch (e) {
      await new Promise(r => setTimeout(r, 250));
    }
  }
  return false;
}

// --- Run it all ---
(async () => {
  console.log(`Building test database "${db.database}"...`);
  try {
    await buildDatabase();
  } catch (err) {
    console.error('\nCould not set up the test database:', err.message);
    console.error('Check the MySQL login in .env.test, and that this user may create databases.');
    process.exit(1);
  }

  console.log(`Starting the app on port ${PORT}...`);
  const { app, output } = startApp();

  if (!(await waitForApp(app))) {
    console.error('\nThe app did not start. Its last output:\n');
    console.error(output.join('\n'));
    app.kill();
    process.exit(1);
  }

  console.log('Running checks...\n');
  let result;
  try {
    const runChecks = require('./e2e.test');
    result = await runChecks({
      base: BASE,
      dbConfig: { ...db },
      webhookSecret: WEBHOOK_SECRET,
      verbose
    });
  } catch (err) {
    console.error('\nThe tests crashed:', err);
    result = { pass: 0, fail: 1 };
  }

  app.kill();

  console.log(`\n${result.pass} passed, ${result.fail} failed`);
  if (result.fail) {
    console.log('\nLast lines from the app, in case they help:\n');
    console.log(output.slice(-40).join('\n'));
  }
  process.exit(result.fail ? 1 : 0);
})();
