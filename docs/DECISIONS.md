# Why I built it this way

This page explains the main choices I made while building DeniseClothing, and the mistakes I learned from. Each section starts in plain English. The technical detail comes after, for anyone who wants it.

## Contents

1. [Orders are only marked paid when Stripe confirms it](#1-orders-are-only-marked-paid-when-stripe-confirms-it)
2. [Stock can't go below zero](#2-stock-cant-go-below-zero)
3. [Prices always come from the database](#3-prices-always-come-from-the-database)
4. [Passwords and reset links are stored differently](#4-passwords-and-reset-links-are-stored-differently)
5. [You can only ever see your own data](#5-you-can-only-ever-see-your-own-data)
6. [Forms are protected against fake submissions](#6-forms-are-protected-against-fake-submissions)
7. [Nothing important really gets deleted](#7-nothing-important-really-gets-deleted)
8. [Guests can shop before making an account](#8-guests-can-shop-before-making-an-account)
9. [Photos are stored on Cloudinary, not on the server](#9-photos-are-stored-on-cloudinary-not-on-the-server)
10. [Search matches the start of words](#10-search-matches-the-start-of-words)
11. [Only buyers can leave reviews](#11-only-buyers-can-leave-reviews)
12. [Dates come from the database](#12-dates-come-from-the-database)
13. [Mistakes I learned from](#mistakes-i-learned-from)
14. [Things I would improve](#things-i-would-improve)

---

## 1. Orders are only marked paid when Stripe confirms it

When you pay, Stripe sends you back to a "thank you" page on my site. My first idea was to mark the order as paid when that page loads. That's a bad idea: someone could close the tab before it loads, or just type the page's address in without paying at all.

So the "thank you" page only shows information. The order is marked paid when Stripe's server sends a separate message straight to my server saying the payment went through. That message is called a **webhook**.

**Technical detail**

- The webhook route checks Stripe's signature on every message using `STRIPE_WEBHOOK_SECRET`. A message without a valid signature gets a 400 and is ignored, so nobody can fake a "payment succeeded" message.
- Signature checking needs the request body exactly as Stripe sent it, byte for byte. That's why the webhook route uses `express.raw()` and is mounted in `server.js` **before** the body parsers. I had it after them at first and every webhook failed with "No signatures found".
- Stripe can send the same event more than once, so processing it twice must be safe (this is called being *idempotent*). Inside one transaction, the order row is locked with `SELECT ... FOR UPDATE`, and if its status isn't `pending` any more the handler stops. `orders.stripe_session_id` is also `UNIQUE`, so one Stripe checkout can only ever belong to one order.
- The confirmation email is sent **after** the transaction commits, inside its own `try/catch`. If the email service is down, the order is still paid and Stripe doesn't get an error back.

**What happened when I got it wrong:** three separate times, test orders stayed "pending" because I'd forgotten to run `stripe listen` on my laptop. Stripe had no way to reach `localhost`. I fixed those with `stripe events resend <event id>`. Resending was only safe *because* of the idempotency check above.

## 2. Stock can't go below zero

If there's one shirt left and two people pay for it at the same moment, only one of them should get it.

**Technical detail**

- Stock is reduced with a single conditional update, so checking and subtracting happen as one step:

  ```sql
  UPDATE product_variants
  SET stock_quantity = stock_quantity - ?
  WHERE id = ? AND stock_quantity >= ?
  ```

  If it changes 0 rows, there wasn't enough stock, and the whole transaction rolls back.
- There's also a `CHECK (stock_quantity >= 0)` on the column, as a last safety net.
- Before payment, the cart is limited to what's actually in stock, capped at 10 per size. The server counts what's **already** in your cart too. Before I fixed that, you could add the last item twice and end up with 2 in your cart. The quantity buttons grey out at the limit, but that's only for convenience. The real check is on the server, because anyone can send a request without using the buttons.

## 3. Prices always come from the database

The price shown on a page is never trusted when you check out. Someone could edit the page in their browser and change $49.90 to $0.01.

**Technical detail:** at checkout, totals are calculated from `products.price` in the database, and the same numbers are sent to Stripe. Nothing price-related is read from the submitted form. Money is stored as `DECIMAL(10,2)`, never `FLOAT`, because floating point can't store values like 0.10 exactly.

## 4. Passwords and reset links are stored differently

Passwords are never stored as you typed them. What's stored is a scrambled version that can't be turned back into the password. Password reset links work the same way: the link in your email contains a secret code, and the database only keeps a scrambled copy of it.

The interesting part is that the two use **different** scrambling methods, on purpose.

**Technical detail**

- **Passwords use bcrypt with cost 12.** bcrypt is deliberately slow, about a quarter of a second per attempt. You don't notice that when you log in once, but someone with a stolen copy of the database, trying billions of guesses, really does. People pick guessable passwords, so slowing down guessing is the whole point.
- **Reset tokens use SHA-256**, which is fast. The token is 32 random bytes from `crypto.randomBytes`, so there's nothing to guess. Slow hashing would only make clicking the link slower without adding any protection.
- A reset link works once and expires after 60 minutes. Using one cancels every other open reset link for that account.
- "Forgot password" shows the same message whether or not the email is registered, so it can't be used to check who has an account.
- Login and reset are rate limited **twice**: by IP address (50 login attempts per 15 minutes, 10 reset requests per hour) and per account (3 reset emails per hour). The IP limit alone doesn't stop many computers attacking one account, and the account limit alone doesn't stop one computer trying many accounts.
- One bug I fixed: the limiters were counting every page **view**, not just form submissions. Loading the forgot-password page a few times locked you out for an hour. They now only count `POST` requests.

## 5. You can only ever see your own data

Orders, addresses and cart items each have an ID number, and it shows up in the address bar, like `/account/orders/42`. If the site only looked up "order 42", anyone could change it to 43 and see someone else's order. This kind of bug is called an **IDOR** (insecure direct object reference). It's one of the most common security problems in real websites.

**Technical detail:** every lookup also checks who the item belongs to:

```sql
SELECT * FROM orders WHERE id = ? AND user_id = ?
```

The same goes for addresses (including the address you choose at checkout, which is submitted from a form), cart items (`AND cart_id = ?`) and reviews. The automated tests log in as a second user and try to open, edit and delete the first user's things. Each attempt has to return 404.

## 6. Forms are protected against fake submissions

Without protection, another website could secretly submit a form to my site while you're logged in, for example to change your email address. This attack is called **CSRF** (cross-site request forgery).

**Technical detail**

- Every form includes a hidden token that's tied to your session. A submission without the right token is rejected.
- I used `csrf-sync`, which uses the *synchroniser token* pattern. I first tried `csrf-csrf` (the *double-submit cookie* pattern), but its docs recommend the synchroniser pattern for apps that already have server-side sessions, and mine does.
- File uploads were tricky. Upload forms are sent as `multipart/form-data`, which Express's normal parser skips, so `req.body` was `undefined` and the token check crashed. Worse, that crash led to the error page itself crashing. For upload forms, the token now goes in the URL (`?_csrf=...`).
- Logging out is a `POST` form, not a link. A link could be triggered by an image tag on another site.

The site also sends a Content Security Policy (through `helmet`), which blocks inline JavaScript like `onclick="..."`. All the page behaviour lives in `public/js/app.js` and hooks onto `data-` attributes instead.

## 7. Nothing important really gets deleted

A shop needs its sales history to stay correct. If an order only said "product 12, quantity 2" and product 12 was later deleted or repriced, the order would become wrong or empty.

**Technical detail**

- **Products are hidden, not deleted.** Unticking "Live on the store" sets `is_active = FALSE`. The shop stops showing it, but the row stays.
- **Orders keep their own copy** of the product name, size, colour and price paid (`order_items`), and of the delivery address as text (`orders.shipping_address`). Editing a product or an address later doesn't change a past order.
- **When someone deletes their account**, each table was given its own rule:

  | Table | Rule | Why |
  |---|---|---|
  | orders | `ON DELETE SET NULL` | Financial records must stay, just no longer linked to the person |
  | reviews | `ON DELETE CASCADE` | A review shows the reviewer's name, so it goes with them |
  | addresses | `ON DELETE CASCADE` | Personal data, no reason to keep it |

  More on this in [DATABASE.md](DATABASE.md#what-happens-when-something-is-deleted).

## 8. Guests can shop before making an account

Forcing people to sign up before they can even add to cart loses customers. So guests get a cart too, and it moves into their account when they log in. You do have to log in to pay, though.

**Technical detail**

- A guest cart is identified by a random 64-character token (`crypto.randomBytes`) stored in the session, so it can't be guessed.
- On login, `mergeGuestCart` moves the guest's items into the account's cart in one transaction. It uses `INSERT ... SELECT ... ON DUPLICATE KEY UPDATE`, which adds quantities together when the same item is in both carts.
- **Bug I hit:** for a while you had to log in twice. The cart merge was throwing an error, which jumped to the login route's error handler. The merge now has its own `try/catch`, so a cart problem can never stop you logging in.
- **Another one:** right after logging in, the page sometimes still showed you as logged out. Saving the session is asynchronous, and the redirect was racing it. Now the redirect waits for `req.session.save()` to finish.
- Sessions are stored in MySQL (`express-mysql-session`) instead of the server's memory, so restarting the server doesn't log everyone out. The cookie is `httpOnly`, `sameSite: 'lax'`, and `secure` in production.

## 9. Photos are stored on Cloudinary, not on the server

**Technical detail:** most hosting services (Railway, Render) wipe the server's disk on every restart or deploy, so a photo saved there would just disappear. Uploads are read into memory with `multer.memoryStorage()` and streamed straight to Cloudinary. Only the image URL and Cloudinary's ID are saved in MySQL. Files are limited to 5 MB and checked for type (JPEG, PNG, WebP, AVIF). When a photo is replaced, the old one is deleted from Cloudinary so unused files don't pile up.

## 10. Search matches the start of words

My first search used `LIKE '%hi%'`, which matches "hi" *anywhere*. Searching "hi" returned every shirt in the shop, because "Shirt" contains "hi".

**Technical detail**

- Search now matches the start of a word: the start of the text, after a space, or after a hyphen. "hi" finds "High-waist" but not "Shirt".
- `%` and `_` typed by the user are escaped first. Otherwise searching "50%" would match everything.
- Sorting can't use `?` placeholders, because `ORDER BY ?` only accepts values, not column names. So the sort options are a fixed list in the code. Anything not in the list falls back to "Newest first", which means a sort value can't be used for SQL injection.

## 11. Only buyers can leave reviews

**Technical detail:** before saving a review, the server checks that the user has an order containing that product with status paid, shipped or delivered. The form is hidden for non-buyers, but hiding it isn't security, so the server checks again. `UNIQUE (product_id, user_id)` means one review per person per product, and posting again updates it (`ON DUPLICATE KEY UPDATE`).

## 12. Dates come from the database

The admin dashboard has a chart of sales for the last 7 days. For a while, every sale showed up on the **previous** day's bar.

**What was wrong:** MySQL handed back each day as a JavaScript `Date`, and my code turned it into text with `toISOString()`, which converts to UTC. Singapore is UTC+8, so midnight on the 12th became 4pm on the 11th.

**Fix:** the query now returns the date as plain text with `DATE_FORMAT(created_at, '%Y-%m-%d')`, and the list of 7 days is also generated by MySQL. Both sides agree on what "today" means, and no time zone conversion happens.

---

## Mistakes I learned from

Not everything went smoothly. These were the most useful lessons:

- **A commit emptied my `schema.sql`.** I pasted part of a file over the whole thing, and git recorded the deletion without complaining. My local database still worked, so I didn't notice for a while, but nobody else could have set up the project. I rebuilt it, and I now check `git diff` whenever a file gets much shorter.
- **A package was installed in the wrong folder.** `stripe` was installed one folder above the project. It worked on my laptop because Node looks in parent folders, but it would have crashed on any hosting service. I only caught it when it was pointed out.
- **A file was importing itself.** One line was pasted into the wrong file, `lib/mailer.js`, and the server wouldn't start.
- **Errors that hide.** Resend reports some failures in its response instead of throwing an error, so my code was logging "email sent" for emails that never went out. Both email functions now check the response.

## Things I would improve

- **Paid but out of stock.** If two people pay for the last item at almost the same time, the second payment succeeds but there's no stock left. That order stays "pending" and Stripe keeps retrying. A real shop would refund automatically (or reserve stock during checkout), and alert the owner.
- **Email delivery.** Resend's test sender only delivers to my own address. A verified domain would fix that.
- **Search.** Word-start matching is fine for a small catalogue. A larger shop should use MySQL `FULLTEXT` indexes or a proper search engine.
- **Testing.** The 167 automated checks run the whole site end to end. I'd add small unit tests for helper functions like address validation and SKU generation, and run the tests automatically on every push.
