# Testing

There are two parts to testing this project:

1. **Automated checks** (`npm test`): 167 checks that go through the whole site the way a visitor would, in about 10 seconds.
2. **A short manual checklist** for the things a script can't test properly: real payments, real emails, photo uploads, Google sign-in and how the pages look.

## 1. Automated checks

### What they do

The test script acts like a person using the site. It registers accounts, logs in, adds things to the cart, checks out, writes reviews, uses the admin pages, and tries things it shouldn't be allowed to do. After each step it checks two things: that the page that came back is right, and that the database contains what it should.

It runs against its own **separate test database**, which is deleted and rebuilt every time. Your normal database is never touched. The app is also started with **fake** Stripe, Resend, Cloudinary and Google keys, so no real payment, email or upload can happen during a test run.

### Setting it up (once)

1. Copy `.env.test.example` to `.env.test`:

   ```bash
   copy .env.test.example .env.test
   ```

   (On Mac or Linux use `cp` instead of `copy`.)

2. Open `.env.test` and put in your MySQL username and password. Leave `DB_NAME` as `denise_test`:

   ```
   DB_HOST=localhost
   DB_PORT=3306
   DB_USER=root
   DB_PASSWORD=your-mysql-password
   DB_NAME=denise_test
   ```

   The database name **has to end in `_test`**. The script refuses to run otherwise. That's a safety rule: the script deletes the database it's given, and this stops it ever being pointed at the real one by mistake.

3. Make sure `package.json` has this line under `"scripts"`:

   ```json
   "test": "node tests/run-tests.js"
   ```

4. `.env.test` has your MySQL password in it, so add this line to `.gitignore` to keep it off GitHub:

   ```
   .env.test
   ```

### Running it

Make sure MySQL is running, then:

```bash
npm test
```

You don't need to start the website first. The script starts its own copy on port 3111 and stops it at the end. Output looks like this:

```
Building test database "denise_test"...
Starting the app on port 3111...
Running checks...

  - Public pages
  - Register, guest cart merge, returnTo
  ...
  - Delete account

167 passed, 0 failed
```

To see every single check as it runs:

```bash
npm test -- --verbose
```

If a check fails, its name is printed with `FAIL`, plus what it got instead. The last lines of the app's own log are printed too, which usually show the actual error.

### What the 167 checks cover

| Area | Some of what's checked |
|---|---|
| Shop pages | Every public page loads. Search finds "High-waist" from "hi" but not "Shirt". Weird searches like `50%` or a fake sort option don't break anything |
| Accounts | Register, log in, log out. Wrong passwords and duplicate emails are refused with a clear message. Passwords are stored as bcrypt hashes |
| Password reset | Reset links expire after about an hour, only work once, and cancel any other open links. Unknown emails get the same message as real ones. Too many requests get blocked |
| Cart | Guest carts move into your account when you log in. You can't add more than is in stock, can't add the last item twice, and can't change someone else's cart |
| Checkout and payment | Orders are saved as pending first. A webhook with a bad signature is rejected. A real one marks the order paid and reduces stock. **The same webhook sent twice only counts once** |
| Orders | Order history and order details show the right totals and address. Another user gets "not found" for your order (the IDOR check) |
| Addresses | Add, edit, delete, and choose a default. Postal codes must be 6 digits. Checkout uses the chosen address. Another user can't view, edit, delete or ship to your address |
| Reviews | Only buyers can review. Posting again edits your review instead of adding a second one |
| Settings | Change name, email and password. Wrong current password refused. Non-image and oversized photo uploads refused politely. Uploads without a CSRF token refused |
| Admin | Non-admins get blocked. Dashboard totals and chart are right. New products with sizes and stock are saved together. Duplicate sizes, overly long sizes and negative stock are refused. SKUs are generated correctly |
| Deleting an account | Needs the right password. Orders stay, but reviews and addresses are removed, and the user is logged out |

The checks are in `tests/e2e.test.js`, grouped under the same headings.

## 2. Manual checklist

Run these on the real site (or locally with real test-mode keys) before showing the project to anyone, and again after deploying.

**Payments** (use card `4242 4242 4242 4242`, any future date, any CVC)
- [ ] Locally: `stripe listen` is running. Online: the webhook is set up in the Stripe dashboard
- [ ] Place an order. Within a few seconds it shows as **Paid** in My orders, not Pending
- [ ] The stock for that size went down by the right amount
- [ ] Cancel on the Stripe page. You come back to checkout and no order is marked paid

**Emails**
- [ ] The order confirmation email arrives
- [ ] "Forgot password" email arrives, the link works, and it doesn't work a second time

**Photos**
- [ ] Admin: create a product with a photo. It shows in the shop
- [ ] Admin: add a second photo, make it the main one, then delete the first
- [ ] Upload a profile photo. It shows in the menu at the top

**Google sign-in**
- [ ] "Continue with Google" works for a new account
- [ ] It also works for an email that already has a normal account (the two get linked)

**How it looks**
- [ ] Home, shop, product, cart and checkout pages on a phone-sized screen: nothing cut off, no sideways scrolling
- [ ] Every button and link can be reached with the Tab key

**After deploying**
- [ ] The app's logs show no `Missing environment variables` warning
- [ ] Log in, refresh, and you're still logged in (sessions are saved in the database)

## Things the tests don't cover yet

- Real Stripe payments end to end. The tests send a correctly signed fake webhook instead, which tests my code but not Stripe's side.
- Whether emails actually arrive. The tests only check that a failed send doesn't break anything.
- How pages look. That's what the manual checklist is for.
- Small unit tests for helper functions. Everything is tested through the website at the moment.
