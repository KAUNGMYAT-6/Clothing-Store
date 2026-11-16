# DeniseClothing

**A real, working online clothing store I built from scratch: browse, pay by card, track your order.**

### Website: [deniseclothingstore.com](https://deniseclothingstore.com)

<!-- Add screenshots here once taken, e.g.
<p>
  <img src="docs/screenshots/home.png" width="49%" alt="Home page">
  <img src="docs/screenshots/product.png" width="49%" alt="Product page">
</p>
-->

**Try it in 30 seconds:** create an account, add something to your cart and check out with the test card `4242 4242 4242 4242` (any future date, any CVC). Payments run in Stripe's test mode, so no real money moves, but everything else works for real: the order shows up in your account, and the stock goes down.

---

## Why I built this

I'm a Year 2 IT student at Republic Polytechnic. Most shop projects I'd seen stop at "list some products and add them to a cart". I wanted to build the parts that make a real shop hard: taking payments safely, never selling something that's out of stock, and keeping customers' data private. And then put it online for anyone to use.

## The Challenges 

**What if someone closes the tab right after paying?**
The site doesn't trust the "thank you" page. An order is only marked paid when Stripe's own server confirms the payment directly. If Stripe sends that confirmation twice, the order still only gets processed once.

**What if two people buy the last shirt at the same time?**
Stock is checked and reduced in a single database step, so only one of them can get it. Stock can never go below zero.

**What if someone changes a number in the address bar to see another person's order?**
They get "not found". Every order, address and cart item is checked against the person who's logged in, and my tests try exactly this trick on every page that matters.

**What if a product's price changes after someone bought it?**
Their order still shows what they actually paid. Each order keeps its own copy of the names, prices and delivery address from the moment it was placed.

**What if a customer deletes their account?**
Their personal data goes, but the shop's sales records stay correct.

The full reasoning behind each of these, plus the mistakes I made along the way, is in [docs/DECISIONS.md](docs/DECISIONS.md).

## What it can do

**For shoppers**

- Search, filter by department or category, and sort by price, newest or rating
- Choose a size and colour, with live stock levels. You can't add more than there is
- Shop as a guest. Your cart moves into your account when you log in
- Sign up with email or with Google
- Pay by card through Stripe and get a confirmation email
- Track each order from paid to shipped to delivered
- Save delivery addresses for faster checkout
- Review products, but only ones you've actually bought
- Manage your profile photo, email and password, or delete your account

**For the shop owner**

- A dashboard with the last 7 days of sales and orders waiting to be handled
- Add products with photos, sizes, colours and stock in one go
- Update order status, hide products, remove reviews

## Built with

|                    |                                                   |
| ------------------ | ------------------------------------------------- |
| **Server**   | Node.js, Express                                  |
| **Database** | MySQL                                             |
| **Pages**    | EJS templates, Bootstrap 5, plain JavaScript      |
| **Payments** | Stripe Checkout and webhooks                      |
| **Login**    | Sessions, bcrypt password hashing, Google sign-in |
| **Email**    | Resend                                            |
| **Images**   | Cloudinary                                        |
| **Hosting**  | Railway, with a custom domain through Cloudflare  |

## How I performed the test

`npm test` builds its own separate database, starts the site with fake payment and email keys, and runs **171 checks** that act like real visitors: signing up, checking out, trying to see other people's orders, sending fake payment confirmations, and more. It takes about 10 seconds. Details are in [TESTING.md](TESTING.md).

## How I built this

I used Claude, an AI assistant, a lot on this project. It explained concepts I hadn't learned yet (webhooks, CSRF, database transactions), suggested how to structure things, wrote a lot of the code with me, and helped track down bugs. I decided what the site should do and how it should behave, tested every feature as it was added, and went back to understand the parts I didn't get at first. Commits where AI helped are marked with a `Co-Authored-By` line.

Every decision in [DECISIONS.md](docs/DECISIONS.md) is one I can explain.

---

## Running it yourself

You'll need [Node.js](https://nodejs.org) 20 or newer and MySQL 8.

```bash
git clone <this repo's URL>
cd Clothing-Store
npm install
mysql -u root -p -e "CREATE DATABASE denise CHARACTER SET utf8mb4"
mysql -u root -p denise < db/schema.sql
```

Copy `.env.example` to `.env` and fill it in:

| Setting                                                                      | What it's for                                                    |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `PORT`, `BASE_URL`                                                       | Where the site runs, e.g. `3000` and `http://localhost:3000` |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`          | Your MySQL login                                                 |
| `SESSION_SECRET`                                                           | Any long random string                                           |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`                             | Stripe test-mode keys                                            |
| `RESEND_API_KEY`, `MAIL_FROM`                                            | Sending emails                                                   |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | Image uploads                                                    |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`      | "Continue with Google"                                           |
| `SUPPORT_EMAIL`                                                            | Contact address shown on the privacy and terms pages             |

Then start it:

```bash
npm start
```

For payments to be confirmed locally, Stripe needs a way to reach your computer. Run this in a second terminal and copy the `whsec_...` it prints into `STRIPE_WEBHOOK_SECRET`:

```bash
stripe listen --forward-to localhost:3000/webhook/stripe --events checkout.session.completed
```

(Skip this step and orders stay "pending" forever. I learned that the hard way, more than once.)

To use the admin side, register on the site, then:

```sql
UPDATE users SET role = 'admin' WHERE email = 'you@example.com';
```

## More documentation

- [docs/DECISIONS.md](docs/DECISIONS.md): why it's built this way, and what I learned
- [docs/DATABASE.md](docs/DATABASE.md): what the database stores, with a diagram
- [TESTING.md](TESTING.md): how to run the tests and what they check

## Known limitations

- Payments are in Stripe test mode. No real cards are charged and nothing ships.
- If two people pay for the very last item at the same moment, the second payment goes through but the order isn't fulfilled. A real shop would refund automatically. More on this in [DECISIONS.md](docs/DECISIONS.md#things-i-would-improve).

<!-- If the Resend domain isn't verified yet, add:
- Emails are sent from Resend's test sender, which only delivers to my own address.
-->
