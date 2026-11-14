// ============================================================
// End-to-end checks for DeniseClothing
// ------------------------------------------------------------
// Don't run this file directly. Use `npm test`, which runs
// tests/run-tests.js: that builds a fresh test database, starts
// the app with fake keys, calls this, then shuts everything down.
//
// Each check() acts like a real visitor: it sends the same
// requests a browser would (with cookies and CSRF tokens), then
// looks at the page that comes back and at the database.
// ============================================================
const mysql = require('mysql2/promise');
const Stripe = require('stripe');
const { createResetToken } = require('../lib/tokens');

async function runChecks({ base, dbConfig, webhookSecret, verbose = false }) {
  const BASE = base;
  let pass = 0, fail = 0;
  // Section headings: one tidy line each, or spaced out with --verbose
  function section(name) {
    console.log(verbose ? '\n# ' + name : '  - ' + name);
  }

  function check(name, cond, extra) {
    if (cond) {
      pass++;
      if (verbose) console.log('  ok   ' + name);
    } else {
      fail++;
      console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + extra : ''));
    }
  }

  class Client {
    constructor() { this.cookies = {}; }
    async req(method, url, body, opts = {}) {
      const headers = { cookie: Object.entries(this.cookies).map(([k, v]) => k + '=' + v).join('; ') };
      let payload;
      if (body instanceof FormData) payload = body;
      else if (body) { headers['content-type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(body).toString(); }
      if (opts.referer) headers.referer = BASE + opts.referer;
      const res = await fetch(BASE + url, { method, headers, body: payload, redirect: 'manual' });
      for (const c of res.headers.getSetCookie()) {
        const [kv] = c.split(';'); const i = kv.indexOf('=');
        const k = kv.slice(0, i), v = kv.slice(i + 1);
        if (v === '' || /Expires=Thu, 01 Jan 1970/.test(c)) delete this.cookies[k]; else this.cookies[k] = v;
      }
      const text = await res.text();
      return { status: res.status, location: res.headers.get('location'), text };
    }
    get(u) { return this.req('GET', u); }
    async csrf(page) {
      const r = await this.get(page);
      const m = r.text.match(/name="_csrf" value="([^"]+)"/);
      return m ? m[1] : null;
    }
    async post(u, body, page) {
      const token = await this.csrf(page || '/cart');
      return this.req('POST', u, { _csrf: token, ...body });
    }
  }

  const db = await mysql.createConnection(dbConfig);
  const q = async (sql, p) => (await db.query(sql, p))[0];

  section('Public pages');
  const anon = new Client();
  for (const u of ['/', '/shop', '/shop?q=shi', '/products/oversized-linen-shirt', '/cart', '/login', '/register', '/forgot-password']) {
    const r = await anon.get(u); check('GET ' + u + ' is 200', r.status === 200, r.status);
  }
  let r = await anon.get('/shop?q=hi');
  check('search "hi" matches word-start "High-waist" but not mid-word "Shirt"', /High-waist Chino/.test(r.text) && !/Oversized Linen Shirt/.test(r.text));
  r = await anon.get('/shop?q=irt'); check('search "irt" (middle of "Shirt") finds nothing', /No results for/.test(r.text));
  r = await anon.get('/shop?q=hospital'); check('search "hospital" shows the named empty state', /No results for .{0,12}hospital/.test(r.text));
  r = await anon.get('/shop?q=50%25'); check('search "50%" does not crash', r.status === 200);
  r = await anon.get('/shop?sort=;DROP TABLE products'); check('junk sort falls back safely', r.status === 200);
  r = await anon.get('/shop'); check('nav search hidden on /shop', !/id="nav-search"/.test(r.text));
  r = await anon.get('/'); check('nav search shown on home', /id="nav-search"/.test(r.text));
  r = await anon.get('/nope'); check('unknown page is 404', r.status === 404);
  r = await anon.get('/privacy');
  check('privacy policy page loads', r.status === 200 && /Privacy policy/.test(r.text) && /Google API Services User Data Policy/.test(r.text), r.status);
  check('privacy policy shows the contact email', /mailto:support@example\.test/.test(r.text));
  r = await anon.get('/terms'); check('terms page loads', r.status === 200 && /Terms of use/.test(r.text), r.status);
  r = await anon.get('/'); check('home page links to the privacy policy and terms', /href="\/privacy"/.test(r.text) && /href="\/terms"/.test(r.text));
  r = await anon.get('/account/orders'); check('account needs login', r.status === 302 && r.location === '/login');
  r = await anon.get('/login'); check('"Please log in" flash is displayed', /Please log in to continue/.test(r.text));

  section('Register, guest cart merge, returnTo');
  const a = new Client();
  r = await a.post('/cart/add', { variant_id: 1, quantity: 2, slug: 'oversized-linen-shirt' }, '/products/oversized-linen-shirt');
  check('guest can add to cart', r.status === 302 && r.location === '/cart', r.status + ' ' + r.location);
  r = await a.get('/cart'); check('"added to your cart" flash shows', /added to your cart/.test(r.text));
  r = await a.get('/checkout'); check('guest checkout bounces to login', r.location === '/login');
  r = await a.post('/register', { name: 'Alice Tan', email: 'alice@example.test', password: 'password123', confirm_password: 'password123' }, '/register');
  check('register redirects back to /checkout (returnTo)', r.status === 302 && r.location === '/checkout', r.status + ' ' + r.location);
  r = await a.get('/cart'); check('guest cart merged into account cart', /Oversized Linen Shirt/.test(r.text));
  const [alice] = await q('SELECT * FROM users WHERE email = ?', ['alice@example.test']);
  check('password stored as bcrypt hash', alice && /^\$2[aby]\$12\$/.test(alice.password_hash));
  r = await a.get('/'); check('avatar initial rendered in nav', /class="nav-avatar"[\s\S]{0,300}<span>A<\/span>/.test(r.text));
  r = await a.post('/register', { name: 'x', email: 'bad', password: 'short', confirm_password: 'nope' }, '/cart');
  // logged-in user posting register: just make sure no 500
  check('register POST never 500s', r.status !== 500, r.status);

  section('Login failures');
  const b = new Client();
  r = await b.post('/login', { email: 'alice@example.test', password: 'wrong' }, '/login');
  check('wrong password -> 401 with message', r.status === 401 && /Email or password is incorrect/.test(r.text), r.status);
  check('email is kept in the form after a failed login', /value="alice@example.test"/.test(r.text));
  r = await b.post('/register', { name: 'Al', email: 'alice@example.test', password: 'password123', confirm_password: 'password123' }, '/register');
  check('duplicate email rejected with message', r.status === 400 && /already registered/.test(r.text), r.status);
  r = await b.post('/login', { email: 'alice@example.test', password: 'password123' }, '/login');
  check('correct password logs in', r.status === 302 && r.location === '/', r.status + ' ' + r.location);

  section('Password reset');
  const c = new Client();
  r = await c.post('/forgot-password', { email: 'alice@example.test' }, '/forgot-password');
  check('forgot-password accepted', r.status === 302 && r.location === '/forgot-password', r.status);
  r = await c.get('/forgot-password'); check('generic confirmation flash shown', /If that email is registered/.test(r.text));
  let resets = await q('SELECT *, TIMESTAMPDIFF(MINUTE, NOW(), expires_at) AS mins FROM password_resets WHERE user_id = ?', [alice.id]);
  check('reset row stored with a 64-char hash', resets.length === 1 && resets[0].token_hash.length === 64);
  check('reset expires in about an hour', resets.length === 1 && resets[0].mins >= 58 && resets[0].mins <= 60, resets[0] && resets[0].mins);
  r = await c.post('/forgot-password', { email: 'nobody@example.test' }, '/forgot-password');
  r = await c.get('/forgot-password'); check('unknown email gets the same message (no enumeration)', /If that email is registered/.test(r.text));
  const mine = createResetToken();
  await q('INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 60 MINUTE))', [alice.id, mine.hash]);
  r = await c.get('/reset-password/' + mine.token); check('valid reset link opens the form', r.status === 200 && /Choose a new password/.test(r.text), r.status);
  r = await c.post('/reset-password/' + mine.token, { password: 'newpassword1', confirm_password: 'different' }, '/reset-password/' + mine.token);
  check('mismatched new passwords rejected', r.status === 400 && /do not match/.test(r.text), r.status);
  r = await c.post('/reset-password/' + mine.token, { password: 'newpassword1', confirm_password: 'newpassword1' }, '/reset-password/' + mine.token);
  check('reset succeeds -> /login', r.status === 302 && r.location === '/login', r.status + ' ' + r.location);
  r = await c.get('/reset-password/' + mine.token); check('used link is refused', r.status === 302 && r.location === '/forgot-password');
  resets = await q('SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ? AND used_at IS NULL', [alice.id]);
  check('all outstanding tokens burned', resets[0].n === 0);
  r = await c.get('/reset-password/garbage'); check('garbage token refused without a 500', r.status === 302);
  for (let i = 0; i < 3; i++) await c.post('/forgot-password', { email: 'alice@example.test' }, '/forgot-password');
  r = await c.get('/forgot-password'); check('per-account reset limit kicks in', /Too many reset requests for this account/.test(r.text));
  r = await a.post('/logout', {}, '/cart'); check('logout redirects home', r.status === 302);
  check('logout removes the session cookie', !a.cookies.store_sid, JSON.stringify(a.cookies));
  r = await a.post('/login', { email: 'alice@example.test', password: 'password123' }, '/login');
  check('old password no longer works', r.status === 401);
  r = await a.post('/login', { email: 'alice@example.test', password: 'newpassword1' }, '/login');
  check('new password works', r.status === 302);

  section('Checkout + Stripe webhook');
  r = await a.get('/checkout'); check('checkout page renders', r.status === 200 && /Continue to payment/.test(r.text), r.status);
  r = await a.get('/checkout'); check('first checkout: no saved addresses, form is plainly required', /name="address_id" value="new"/.test(r.text) && /id="line1"[^>]*required/.test(r.text));
  r = await a.post('/checkout/session', { email: 'alice@example.test', address_id: 'new', recipient_name: 'Alice Tan', phone: '9123 4567', line1: 'Blk 123 Woodlands Ave 1', line2: '#04-56', postal_code: '730 123', label: 'Home', save_address: 'on' }, '/checkout');
  check('Stripe failure (dummy key) is handled, not a 500', r.status === 302 && r.location === '/checkout', r.status + ' ' + r.location);
  let [order] = await q('SELECT * FROM orders WHERE user_id = ?', [alice.id]);
  check('pending order written with totals', order && order.status === 'pending' && Number(order.total) === 104.80, order && order.total);
  await q('UPDATE orders SET stripe_session_id = ? WHERE id = ?', ['cs_test_local_1', order.id]);
  const stripe = Stripe('sk_test_dummy_not_real');
  const payload = JSON.stringify({ id: 'evt_1', object: 'event', type: 'checkout.session.completed', data: { object: { id: 'cs_test_local_1', object: 'checkout.session' } } });
  const sig = stripe.webhooks.generateTestHeaderString({ payload, secret: webhookSecret });
  const hook = (s) => fetch(BASE + '/webhook/stripe', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': s }, body: payload });
  let h = await hook('t=1,v1=bad'); check('webhook with a bad signature -> 400', h.status === 400, h.status);
  h = await hook(sig); check('signed webhook accepted', h.status === 200, h.status);
  [order] = await q('SELECT * FROM orders WHERE id = ?', [order.id]); check('order marked paid', order.status === 'paid', order.status);
  let [v] = await q('SELECT stock_quantity FROM product_variants WHERE id = 1'); check('stock decremented 5 -> 3', v.stock_quantity === 3, v.stock_quantity);
  h = await hook(sig); [v] = await q('SELECT stock_quantity FROM product_variants WHERE id = 1');
  check('duplicate webhook is idempotent (stock still 3)', h.status === 200 && v.stock_quantity === 3, v.stock_quantity);
  r = await a.get('/cart'); check('cart emptied after payment', /Your cart is empty/.test(r.text));
  r = await a.get('/order/success?session_id=cs_test_local_1'); check('success page renders', r.status === 200, r.status);

  section('Account: orders');
  r = await a.get('/account'); check('/account -> /account/orders', r.location === '/account/orders');
  r = await a.get('/account/orders'); check('order history renders', r.status === 200, r.status);
  check('order history shows the real total ($104.80)', /\$104\.80/.test(r.text) && !/NaN/.test(r.text));
  r = await a.get('/account/orders/' + order.id); check('order detail renders', r.status === 200, r.status);
  check('order detail totals correct (99.80 + 5.00 = 104.80)', /\$99\.80/.test(r.text) && /\$5\.00/.test(r.text) && /\$104\.80/.test(r.text) && !/NaN/.test(r.text));
  check('order detail shows the delivery address', /Woodlands Ave 1/.test(r.text) && /Singapore 730123/.test(r.text) && /Tel 9123 4567/.test(r.text));
  r = await a.get('/account/orders/abc'); check('non-numeric order id -> 404', r.status === 404, r.status);
  r = await a.get('/account/orders/99999'); check('missing order -> 404', r.status === 404, r.status);
  const bob = new Client();
  await bob.post('/register', { name: 'Bob Lim', email: 'bob@example.test', password: 'password123', confirm_password: 'password123' }, '/register');
  r = await bob.get('/account/orders/' + order.id); check("IDOR: Bob cannot open Alice's order (404)", r.status === 404, r.status);
  r = await bob.get('/account/orders'); check('empty order history renders', /No orders yet/.test(r.text));

  section('Reviews');
  r = await bob.post('/products/oversized-linen-shirt/reviews', { rating: 5, body: 'fake' }, '/products/oversized-linen-shirt');
  r = await bob.get('/products/oversized-linen-shirt'); check('non-buyer cannot review', /Only customers who bought/.test(r.text));
  r = await a.post('/products/oversized-linen-shirt/reviews', { rating: 4, body: 'Nice fabric' }, '/products/oversized-linen-shirt');
  r = await a.get('/products/oversized-linen-shirt'); check('buyer review is posted and shown', /Nice fabric/.test(r.text) && /Verified purchase/.test(r.text));
  await a.post('/products/oversized-linen-shirt/reviews', { rating: 2, body: 'Changed my mind' }, '/products/oversized-linen-shirt');
  let rv = await q('SELECT * FROM reviews'); check('second post edits rather than duplicates', rv.length === 1 && rv[0].rating === 2);
  r = await anon.get('/shop'); check('rating appears on the shop card', /card-rating/.test(r.text));
  const anon2 = new Client();
  r = await anon2.post('/products/oversized-linen-shirt/reviews', { rating: 5 }, '/products/oversized-linen-shirt');
  r = await anon2.post('/login', { email: 'bob@example.test', password: 'password123' }, '/login');
  check('login after a blocked POST does not return to a POST-only URL', r.status === 302 && r.location === '/', r.location);

  section('Account: settings');
  r = await a.get('/account/settings'); check('settings page renders', r.status === 200, r.status);
  r = await a.post('/account/settings/profile', { name: 'Alice T.', email: 'bob@example.test' }, '/account/settings');
  r = await a.get('/account/settings'); check('taken email is refused with a message', /already registered to another account/.test(r.text));
  r = await a.post('/account/settings/profile', { name: 'Alicia Tan', email: 'alicia@example.test' }, '/account/settings');
  r = await a.get('/account/settings'); check('name/email update + flash + nav refresh', /Details updated/.test(r.text) && /Alicia Tan/.test(r.text));
  r = await a.post('/account/settings/password', { current_password: 'nope', new_password: 'another123', confirm_password: 'another123' }, '/account/settings');
  r = await a.get('/account/settings'); check('wrong current password refused', /current password is incorrect/.test(r.text));
  r = await a.post('/account/settings/password', { current_password: 'newpassword1', new_password: 'another123', confirm_password: 'another123' }, '/account/settings');
  r = await a.get('/account/settings'); check('password change succeeds', /Password changed/.test(r.text));
  let token = await a.csrf('/account/settings');
  let fd = new FormData(); fd.append('photo', new Blob(['not an image'], { type: 'text/plain' }), 'notes.txt');
  r = await a.req('POST', '/account/settings/photo?_csrf=' + encodeURIComponent(token), fd, { referer: '/account/settings' });
  check('non-image upload is refused politely (not a 500)', r.status === 302 && r.location.endsWith('/account/settings'), r.status + ' ' + r.location);
  r = await a.get('/account/settings'); check('refusal message is shown', /Only JPEG, PNG, WebP and AVIF/.test(r.text));
  fd = new FormData(); fd.append('photo', new Blob([new Uint8Array(6 * 1024 * 1024)], { type: 'image/png' }), 'big.png');
  token = await a.csrf('/account/settings');
  r = await a.req('POST', '/account/settings/photo?_csrf=' + encodeURIComponent(token), fd, { referer: '/account/settings' });
  check('oversized upload is refused politely', r.status === 302, r.status);
  fd = new FormData(); fd.append('photo', new Blob(['x'], { type: 'image/png' }), 'a.png');
  r = await a.req('POST', '/account/settings/photo', fd, { referer: '/account/settings' });
  check('multipart POST without a CSRF token is rejected', r.status === 302 && !/Photo updated/.test((await a.get('/account/settings')).text));

  section('Admin');
  r = await bob.get('/admin'); check('non-admin gets 403', r.status === 403, r.status);
  await q("UPDATE users SET role = 'admin' WHERE email = 'bob@example.test'");
  const adm = new Client();
  await adm.post('/login', { email: 'bob@example.test', password: 'password123' }, '/login');
  for (const u of ['/admin', '/admin/orders', '/admin/orders?status=paid', '/admin/orders/' + order.id, '/admin/products', '/admin/products/new', '/admin/products/1/edit']) {
    r = await adm.get(u); check('GET ' + u + ' is 200', r.status === 200, r.status);
  }
  r = await adm.get('/admin'); check('dashboard revenue counts the paid order', /104\.80/.test(r.text));
  const todayLabel = (await q("SELECT DATE_FORMAT(CURDATE(), '%a') AS d"))[0].d;
  const barNear = new RegExp('\\$105[\\s\\S]{0,300}?' + todayLabel);
  check("today's chart bar (" + todayLabel + ") carries today's sale", barNear.test(r.text));
  token = await adm.csrf('/admin/products/new');
  fd = new FormData(); fd.append('name', 'Only a name');
  r = await adm.req('POST', '/admin/products?_csrf=' + encodeURIComponent(token), fd);
  check('new product with missing fields -> 400 + form', r.status === 400 && /all required/.test(r.text), r.status);
  token = await adm.csrf('/admin/products/new');
  fd = new FormData(); for (const [k, val] of Object.entries({ name: 'Rib Tank', slug: 'rib-tank', price: '19.90', category_id: '1', department: 'women' })) fd.append(k, val);
  r = await adm.req('POST', '/admin/products?_csrf=' + encodeURIComponent(token), fd);
  check('new product without an image is created', r.status === 302 && /\/admin\/products\/\d+\/edit/.test(r.location), r.status + ' ' + r.location);
  token = await adm.csrf('/admin/products/new');
  fd = new FormData(); for (const [k, val] of Object.entries({ name: 'Dup', slug: 'rib-tank', price: '1', category_id: '1' })) fd.append(k, val);
  r = await adm.req('POST', '/admin/products?_csrf=' + encodeURIComponent(token), fd);
  check('duplicate slug -> friendly error', r.status === 400 && /already in use/.test(r.text), r.status);

  section('Admin: sizes and stock');
  const newProduct = async (fields, rows) => {
    const t = await adm.csrf('/admin/products/new');
    const f = new FormData();
    for (const [k, val] of Object.entries(fields)) f.append(k, val);
    for (const row of rows) { f.append('variant_color', row[0]); f.append('variant_size', row[1]); f.append('variant_stock', row[2]); }
    return adm.req('POST', '/admin/products?_csrf=' + encodeURIComponent(t), f);
  };
  r = await adm.get('/admin/products/new');
  check('new-product form has size/stock rows', (r.text.match(/name="variant_color"/g) || []).length >= 3 && /data-variant-template/.test(r.text));
  r = await newProduct({ name: 'Boxy Tee', slug: 'boxy-tee', price: '25', category_id: '1', department: 'unisex' },
    [['black', 's', '5'], ['navy blue', 'xl', '3'], ['', '', '']]);
  check('product created together with its variants', r.status === 302 && /\/admin\/products\/\d+\/edit/.test(r.location), r.status + ' ' + r.location);
  const teeId = Number((r.location || '').match(/products\/(\d+)/)?.[1]);
  let tv = await q('SELECT * FROM product_variants WHERE product_id = ? ORDER BY id', [teeId]);
  check('two rows saved, the empty row skipped', tv.length === 2, tv.length);
  check('colour and size tidied (black -> Black, navy blue -> Navy Blue, xl -> XL)', tv[0]?.color === 'Black' && tv[0]?.size === 'S' && tv[1]?.color === 'Navy Blue' && tv[1]?.size === 'XL', JSON.stringify(tv.map(v => [v.color, v.size])));
  check('stock saved per row', tv[0]?.stock_quantity === 5 && tv[1]?.stock_quantity === 3);
  check('SKUs generated automatically', tv[0]?.sku === 'P' + teeId + '-BLACK-S' && tv[1]?.sku === 'P' + teeId + '-NAVY-BLUE-XL', tv.map(v => v.sku).join(','));
  r = await adm.get('/admin/products/' + teeId + '/edit'); check('success message counts the stock', /created with 2 variants \(8 in stock\)/.test(r.text));
  r = await newProduct({ name: 'Solo', slug: 'solo', price: '10', category_id: '1' }, [['Red', 'M', '4']]);
  const soloId = Number((r.location || '').match(/products\/(\d+)/)?.[1]);
  check('a single row (one value, not a list) works', r.status === 302 && (await q('SELECT COUNT(*) AS n FROM product_variants WHERE product_id = ?', [soloId]))[0].n === 1, r.status);
  r = await newProduct({ name: 'Plain', slug: 'plain-no-rows', price: '10', category_id: '1' }, []);
  check('no rows at all still creates the product', r.status === 302, r.status);
  let before2 = (await q('SELECT COUNT(*) AS n FROM products'))[0].n;
  r = await newProduct({ name: 'Dupe', slug: 'dupe', price: '10', category_id: '1' }, [['Black', 'S', '1'], ['black', 's', '2']]);
  check('same colour+size twice (any case) -> 400, nothing saved', r.status === 400 && /listed twice/.test(r.text) && (await q('SELECT COUNT(*) AS n FROM products'))[0].n === before2, r.status);
  check('rows and fields kept after an error', /value="black"/.test(r.text) && /value="Dupe"/.test(r.text));
  r = await newProduct({ name: 'Half', slug: 'half', price: '10', category_id: '1' }, [['Black', '', '3']]);
  check('colour without a size -> clear message', r.status === 400 && /Row 1: Enter a size/.test(r.text), r.status);
  r = await newProduct({ name: 'Long', slug: 'long', price: '10', category_id: '1' }, [['Black', 'Extra Large', '3']]);
  check('size too long -> clear message', r.status === 400 && /at most 10 characters/.test(r.text), r.status);
  r = await newProduct({ name: 'Neg', slug: 'neg', price: '10', category_id: '1' }, [['Black', 'M', '-2']]);
  check('negative stock refused', r.status === 400 && /whole number/.test(r.text), r.status);
  r = await newProduct({ name: 'Frac', slug: 'frac', price: '10', category_id: '1' }, [['Black', 'M', '1.5']]);
  check('fractional stock refused', r.status === 400, r.status);
  check('no half-made products left behind by any failure', (await q('SELECT COUNT(*) AS n FROM products'))[0].n === before2);

  section('Admin: add a variant on the edit page');
  const addVariant = (pid, body) => adm.post('/admin/products/' + pid + '/variants', body, '/admin/products/' + pid + '/edit');
  r = await addVariant(teeId, { color: 'white', size: 'm', sku: '', stock_quantity: '7' });
  r = await adm.get('/admin/products/' + teeId + '/edit');
  tv = await q('SELECT * FROM product_variants WHERE product_id = ? AND color = ?', [teeId, 'White']);
  check('blank SKU -> generated, stock saved', tv.length === 1 && tv[0].sku === 'P' + teeId + '-WHITE-M' && tv[0].stock_quantity === 7 && /Added White · M with 7 in stock/.test(r.text), JSON.stringify(tv[0]));
  r = await addVariant(teeId, { color: 'BLACK', size: 's', sku: '', stock_quantity: '1' });
  r = await adm.get('/admin/products/' + teeId + '/edit');
  check('existing colour+size in other case -> specific message', /Black · S is already on this product/.test(r.text));
  r = await addVariant(teeId, { color: 'Green', size: 'L', sku: 'P' + soloId + '-RED-M', stock_quantity: '1' });
  r = await adm.get('/admin/products/' + teeId + '/edit');
  check('typed SKU owned by another product -> names that product', /is already used by Solo/.test(r.text));
  r = await addVariant(teeId, { color: 'Green', size: 'Extra Large', sku: '', stock_quantity: '1' });
  r = await adm.get('/admin/products/' + teeId + '/edit');
  check('long size -> clear message, not "Could not add"', /at most 10 characters/.test(r.text));
  r = await addVariant(teeId, { color: '', size: 'L', sku: '', stock_quantity: '1' });
  r = await adm.get('/admin/products/' + teeId + '/edit');
  check('missing colour -> message', /Enter a colour/.test(r.text));
  await db.query("INSERT INTO product_variants (product_id, size, color, sku, stock_quantity) VALUES (?, 'XS', 'Pink', ?, 0)", [soloId, 'P' + teeId + '-PINK-XS']);
  r = await addVariant(teeId, { color: 'pink', size: 'xs', sku: '', stock_quantity: '2' });
  tv = await q('SELECT sku FROM product_variants WHERE product_id = ? AND color = ?', [teeId, 'Pink']);
  check('generated SKU already taken elsewhere -> gets a -2 suffix', tv.length === 1 && tv[0].sku === 'P' + teeId + '-PINK-XS-2', tv[0] && tv[0].sku);
  r = await addVariant(teeId, { color: 'Typed', size: 'M', sku: 'MY-OWN-SKU', stock_quantity: '0' });
  check('a free typed SKU is kept as typed', (await q("SELECT COUNT(*) AS n FROM product_variants WHERE sku = 'MY-OWN-SKU'"))[0].n === 1);
  r = await addVariant(99999, { color: 'X', size: 'M', sku: '', stock_quantity: '0' });
  check('adding to a missing product -> 404', r.status === 404, r.status);
  for (const size of ['xl', 'xs', 's']) await addVariant(soloId, { color: 'Red', size, sku: '', stock_quantity: '1' });
  r = await adm.get('/admin/products/' + soloId + '/edit');
  const sizeOrder = [...r.text.matchAll(/<td class="fw-semibold">Red<\/td>\s*<td class="font-display fw-bold">([^<]+)<\/td>/g)].map(m => m[1]);
  check('edit table lists sizes in wearing order (XS, S, M, XL)', sizeOrder.join(',') === 'XS,S,M,XL', sizeOrder.join(','));

  for (let i = 0; i < 12; i++) { const x = await adm.get('/admin/products'); if (x.status !== 200) { check('pool survives repeated requests', false, x.status); break; } if (i === 11) check('connection pool healthy after error paths', true); }
  r = await adm.post('/admin/orders/' + order.id + '/status', { status: 'shipped' }, '/admin/orders/' + order.id);
  r = await a.get('/account/orders/' + order.id); check('customer sees "On its way" after admin ships', /On its way/.test(r.text));


  section('Addresses');
  r = await a.get('/account/addresses'); check('address book renders', r.status === 200, r.status);
  check('address saved at checkout is listed as default', /1 of 10 saved/.test(r.text) && /Default/.test(r.text) && /Woodlands Ave 1/.test(r.text));
  r = await a.get('/account/addresses/new'); check('new address form prefills the current name', r.status === 200 && /id="recipient_name"[^>]*value="Alicia Tan"/.test(r.text), r.status);
  r = await a.post('/account/addresses', { recipient_name: 'Alice Tan', line1: 'Somewhere', postal_code: '12345' }, '/account/addresses/new');
  check('5-digit postal code refused, typing kept', r.status === 400 && /6 digits/.test(r.text) && /value="Somewhere"/.test(r.text), r.status);
  r = await a.post('/account/addresses', { recipient_name: 'x', line1: '', postal_code: '' }, '/account/addresses/new');
  check('empty address refused', r.status === 400, r.status);
  r = await a.post('/account/addresses', { recipient_name: 'Alice Tan', line1: '1 Raffles Place', line2: '#20-01', postal_code: '048616', label: 'Office', is_default: 'on' }, '/account/addresses/new');
  check('second address created', r.status === 302 && r.location === '/account/addresses', r.status);
  let addrs = await q('SELECT * FROM addresses WHERE user_id = ? ORDER BY id', [alice.id]);
  check('ticking "default" moves the default (exactly one)', addrs.length === 2 && !addrs[0].is_default && addrs[1].is_default && addrs.filter(x => x.is_default).length === 1);
  const [home, office] = addrs;
  r = await a.get('/account/addresses/' + home.id + '/edit'); check('edit form prefilled', r.status === 200 && /value="Blk 123 Woodlands Ave 1"/.test(r.text));
  r = await a.post('/account/addresses/' + home.id, { recipient_name: 'Alice Tan', line1: 'Blk 456 Woodlands Ave 2', postal_code: '730456', label: 'Home' }, '/account/addresses/' + home.id + '/edit');
  addrs = await q('SELECT * FROM addresses WHERE id = ?', [home.id]);
  check('edit saves (and clears the emptied unit field)', addrs[0].line1 === 'Blk 456 Woodlands Ave 2' && addrs[0].line2 === null);
  const bobUser = (await q("SELECT id FROM users WHERE email = 'bob@example.test'"))[0];
  r = await bob.get('/account/addresses/' + home.id + '/edit'); check("IDOR: Bob can't open Alice's address", r.status === 404, r.status);
  r = await bob.post('/account/addresses/' + home.id, { recipient_name: 'Hacker', line1: 'x', postal_code: '123456' }, '/account/addresses');
  check("IDOR: Bob can't edit Alice's address", r.status === 404 && (await q('SELECT recipient_name FROM addresses WHERE id = ?', [home.id]))[0].recipient_name === 'Alice Tan', r.status);
  r = await bob.post('/account/addresses/' + home.id + '/delete', {}, '/account/addresses');
  check("IDOR: Bob can't delete Alice's address", r.status === 404 && (await q('SELECT COUNT(*) AS n FROM addresses WHERE id = ?', [home.id]))[0].n === 1, r.status);
  r = await bob.post('/account/addresses/' + home.id + '/default', {}, '/account/addresses');
  check("IDOR: Bob can't change Alice's default", r.status === 404 && (await q('SELECT is_default FROM addresses WHERE id = ?', [office.id]))[0].is_default === 1, r.status);
  r = await a.get('/account/addresses/abc/edit'); check('junk address id -> 404', r.status === 404, r.status);
  r = await a.post('/account/addresses/' + home.id + '/default', {}, '/account/addresses');
  addrs = await q('SELECT id, is_default FROM addresses WHERE user_id = ?', [alice.id]);
  check('"Make default" switches it', addrs.find(x => x.id === home.id).is_default === 1 && addrs.filter(x => x.is_default).length === 1);

  section('Checkout with saved addresses');
  await q("UPDATE product_variants SET stock_quantity = 5 WHERE id = 3");
  await a.post('/cart/add', { variant_id: 3, quantity: 1, slug: 'high-waist-chino' }, '/products/high-waist-chino');
  r = await a.get('/checkout');
  check('checkout lists saved addresses with the default pre-selected', new RegExp('value="' + home.id + '"[^>]*data-address-choice\\s*checked').test(r.text) && /Raffles Place/.test(r.text), r.status);
  check('new-address fields are conditional, not hard-required', /id="line1"[^>]*data-required-when-new/.test(r.text) && !/id="line1"[^>]*\srequired[\s>]/.test(r.text));
  const before = (await q('SELECT MAX(id) AS m FROM orders'))[0].m;
  r = await a.post('/checkout/session', { email: 'alice@example.test', address_id: String(office.id) }, '/checkout');
  let [o2] = await q('SELECT * FROM orders WHERE id > ? ORDER BY id DESC LIMIT 1', [before]);
  check('order uses the chosen saved address', o2 && o2.shipping_name === 'Alice Tan' && o2.shipping_address === '1 Raffles Place\n#20-01\nSingapore 048616', o2 && JSON.stringify(o2.shipping_address));
  const [ins] = await db.query("INSERT INTO addresses (user_id, recipient_name, line1, city, postal_code) VALUES (?, 'Bob Lim', 'Bob St', 'Singapore', '111111')", [bobUser.id]);
  r = await a.post('/checkout/session', { email: 'alice@example.test', address_id: String(ins.insertId) }, '/checkout');
  check("IDOR: can't ship to someone else's saved address", r.status === 400 && /choose a delivery address/.test(r.text), r.status);
  r = await a.post('/checkout/session', { email: 'alice@example.test', address_id: 'abc' }, '/checkout');
  check('junk address_id -> 400, not 500', r.status === 400, r.status);
  r = await a.post('/checkout/session', { email: 'alice@example.test', address_id: 'new', recipient_name: 'Alice Tan', line1: 'Typed street', postal_code: '99' }, '/checkout');
  check('bad new address at checkout: 400, message, typing kept, "new" stays selected', r.status === 400 && /6 digits/.test(r.text) && /value="Typed street"/.test(r.text) && /value="new"[^>]*data-address-choice\s*checked/.test(r.text), r.status);
  r = await a.post('/checkout/session', { email: 'not-an-email', address_id: String(home.id) }, '/checkout');
  check('bad email at checkout -> 400 with message', r.status === 400 && /email address/.test(r.text), r.status);
  const n1 = (await q('SELECT COUNT(*) AS n FROM addresses WHERE user_id = ?', [alice.id]))[0].n;
  await a.post('/checkout/session', { email: 'alice@example.test', address_id: 'new', recipient_name: 'Gift', line1: 'Friend Rd', postal_code: '222222' }, '/checkout');
  check('unticked "save" does not save the address', (await q('SELECT COUNT(*) AS n FROM addresses WHERE user_id = ?', [alice.id]))[0].n === n1);

  section('Address delete + limit');
  r = await a.post('/account/addresses/' + home.id + '/delete', {}, '/account/addresses');
  addrs = await q('SELECT id, is_default FROM addresses WHERE user_id = ?', [alice.id]);
  check('deleting the default promotes another', addrs.length === 1 && addrs[0].id === office.id && addrs[0].is_default === 1);
  for (let i = 0; i < 9; i++) await db.query("INSERT INTO addresses (user_id, recipient_name, line1, city, postal_code) VALUES (?, 'Filler', 'Filler St', 'Singapore', '333333')", [alice.id]);
  r = await a.get('/account/addresses'); check('at 10 addresses the Add button is gone', /10 of 10 saved/.test(r.text) && !/href="\/account\/addresses\/new"/.test(r.text));
  r = await a.get('/account/addresses/new'); check('the new form redirects when full', r.status === 302);
  r = await a.post('/account/addresses', { recipient_name: 'Alice', line1: 'x', postal_code: '123456' }, '/account/addresses');
  check('POST is refused when full', (await q('SELECT COUNT(*) AS n FROM addresses WHERE user_id = ?', [alice.id]))[0].n === 10);


  section('Stock limits in the cart');
  const [lp] = await db.query("INSERT INTO products (category_id, name, slug, price, department) VALUES (1, 'Limited Tee', 'limited-tee', 20, 'unisex')");
  const [v1] = await db.query("INSERT INTO product_variants (product_id, size, color, sku, stock_quantity) VALUES (?, 'S', 'Indigo', 'LT-1', 1)", [lp.insertId]);
  const [v12] = await db.query("INSERT INTO product_variants (product_id, size, color, sku, stock_quantity) VALUES (?, 'M', 'Indigo', 'LT-12', 12)", [lp.insertId]);
  const shopper = new Client();
  r = await shopper.get('/products/limited-tee');
  check('options carry their stock for the buttons', new RegExp('value="' + v1.insertId + '" data-stock="1"').test(r.text) && new RegExp('value="' + v12.insertId + '" data-stock="12"').test(r.text));
  check('quantity box starts capped at 10 (biggest stock 12)', /id="qty"[^>]*max="10"/.test(r.text));
  r = await shopper.post('/cart/add', { variant_id: v1.insertId, quantity: 7, slug: 'limited-tee' }, '/products/limited-tee');
  r = await shopper.get('/products/limited-tee');
  check('asking for 7 of the last 1 is refused', /Only 1 available in that size/.test(r.text));
  await shopper.post('/cart/add', { variant_id: v1.insertId, quantity: 1, slug: 'limited-tee' }, '/products/limited-tee');
  await shopper.post('/cart/add', { variant_id: v1.insertId, quantity: 1, slug: 'limited-tee' }, '/products/limited-tee');
  r = await shopper.get('/products/limited-tee');
  check('adding the last one twice is refused', /already have 1 in your cart, which is all we have/.test(r.text));
  let ci = await q('SELECT quantity FROM cart_items WHERE variant_id = ?', [v1.insertId]);
  check('cart still holds exactly 1', ci.length === 1 && ci[0].quantity === 1, JSON.stringify(ci));
  await shopper.post('/cart/add', { variant_id: v12.insertId, quantity: 8, slug: 'limited-tee' }, '/products/limited-tee');
  await shopper.post('/cart/add', { variant_id: v12.insertId, quantity: 5, slug: 'limited-tee' }, '/products/limited-tee');
  r = await shopper.get('/products/limited-tee');
  check('per-size limit of 10 counts what is already in the cart', /have 8 in your cart already, so you can add 2 more/.test(r.text));
  const [[item12]] = await db.query('SELECT id FROM cart_items WHERE variant_id = ?', [v12.insertId]);
  r = await shopper.post('/cart/update', { item_id: item12.id, quantity: 50 }, '/cart');
  r = await shopper.get('/cart');
  ci = await q('SELECT quantity FROM cart_items WHERE id = ?', [item12.id]);
  check('cart update above the limit is lowered to 10, with a message', ci[0].quantity === 10 && /limit is 10 per size/.test(r.text), ci[0].quantity);
  await db.query('UPDATE product_variants SET stock_quantity = 3 WHERE id = ?', [v12.insertId]);
  await shopper.post('/cart/update', { item_id: item12.id, quantity: 9 }, '/cart');
  r = await shopper.get('/cart');
  ci = await q('SELECT quantity FROM cart_items WHERE id = ?', [item12.id]);
  check('cart update above stock is lowered to the stock', ci[0].quantity === 3 && /Only 3 left in that size, so your cart has 3/.test(r.text), ci[0].quantity);
  check('cart page caps the stepper at the stock', new RegExp('max="3"').test(r.text));
  await db.query('UPDATE product_variants SET stock_quantity = 0 WHERE id = ?', [v12.insertId]);
  await shopper.post('/cart/update', { item_id: item12.id, quantity: 2 }, '/cart');
  r = await shopper.get('/cart');
  check('updating a sold-out item says so', /That size has sold out/.test(r.text));
  const stranger = new Client();
  r = await stranger.post('/cart/update', { item_id: item12.id, quantity: 1 }, '/cart');
  ci = await q('SELECT quantity FROM cart_items WHERE id = ?', [item12.id]);
  check("can't change someone else's cart item", ci[0].quantity === 3);
  await db.query('UPDATE products SET is_active = FALSE WHERE id = ?', [lp.insertId]);
  await db.query('UPDATE product_variants SET stock_quantity = 5 WHERE id = ?', [v12.insertId]);
  const before3 = (await q('SELECT COUNT(*) AS n FROM cart_items'))[0].n;
  await stranger.post('/cart/add', { variant_id: v12.insertId, quantity: 1, slug: 'limited-tee' }, '/shop');
  check('hidden products can no longer be added', (await q('SELECT COUNT(*) AS n FROM cart_items'))[0].n === before3);
  await db.query('UPDATE products SET is_active = TRUE WHERE id = ?', [lp.insertId]);
  await db.query('UPDATE product_variants SET stock_quantity = 1 WHERE id = ?', [v1.insertId]);

  section('Delete account');
  r = await a.post('/account/delete', { password: 'wrong' }, '/account/settings');
  check('wrong password does not delete', (await q('SELECT COUNT(*) AS n FROM users WHERE id = ?', [alice.id]))[0].n === 1);
  r = await a.post('/account/delete', { password: 'another123' }, '/account/settings');
  check('account deleted', r.status === 302 && (await q('SELECT COUNT(*) AS n FROM users WHERE id = ?', [alice.id]))[0].n === 0, r.status);
  [order] = await q('SELECT * FROM orders WHERE id = ?', [order.id]);
  check('order survives with user_id NULL', order && order.user_id === null);
  check('reviews removed with the account', (await q('SELECT COUNT(*) AS n FROM reviews'))[0].n === 0);
  check('addresses removed with the account', (await q('SELECT COUNT(*) AS n FROM addresses WHERE user_id = ?', [alice.id]))[0].n === 0);
  r = await a.get('/account/orders'); check('deleted user is logged out', r.status === 302 && r.location === '/login');
  r = await adm.get('/admin/orders/' + order.id); check('admin can still open the orphaned order', r.status === 200, r.status);

  await db.end();
  return { pass, fail };
}

module.exports = runChecks;
