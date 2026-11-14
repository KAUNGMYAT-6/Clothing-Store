# DeniseClothing

An online clothing store I built from scratch as a portfolio project. You can browse clothes, add them to a cart, pay by card, and track your order. There's also an admin side for running the shop: adding products, managing stock and handling orders.

**Live site:** coming soon

<!-- TODO: replace the line above with the link once it's deployed -->

Payments run in Stripe's test mode, so no real money is involved. To try checkout, use the card number `4242 4242 4242 4242` with any future expiry date and any 3-digit CVC.

<!-- TODO: add 2-3 screenshots, e.g.
![Home page](docs/screenshots/home.png)
![Checkout](docs/screenshots/checkout.png)
![Admin dashboard](docs/screenshots/admin.png)
-->

## About this project

I'm a Year 2 IT student at Republic Polytechnic. I wanted one project that covers what a real online shop has to deal with, not just a page that lists products: taking payments safely, not overselling stock, keeping accounts secure, and keeping order records correct even when products or accounts change later.

I built it over about a month (October to November 2026), committing as I went, so the commit history shows how it came together piece by piece.

## What you can do on the site

**As a shopper**

- Browse by department (Women, Men, Unisex) or category, search, sort by price or rating, and page through results
- Pick a size and colour on each product. The site shows what's low in stock or sold out, and won't let you add more than there is
- Use the cart without an account. When you log in, whatever you added as a guest moves into your account
- Sign up with email and password, or with Google
- Pay with a card through Stripe and get a confirmation email
- See your past orders and where each one is (paid, shipped, delivered)
- Save delivery addresses so checkout fills them in next time
- Leave a review, but only for something you actually bought
- Change your name, email, password or profile photo, or delete your account

**As the shop owner (admin)**

- A dashboard with sales for the last 7 days and orders waiting to be handled
- Update an order's status (paid, shipped, delivered, cancelled)
- Add and edit products with photos, sizes, colours and stock levels
- Hide a product from the shop without losing its order history
- Remove reviews

## Built with

| Part          | What I used                                                        |
| ------------- | ------------------------------------------------------------------ |
| Server        | Node.js with Express                                               |
| Pages         | EJS templates, Bootstrap 5, plain JavaScript                       |
| Database      | MySQL                                                              |
| Payments      | Stripe Checkout and webhooks                                       |
| Email         | Resend                                                             |
| Image hosting | Cloudinary                                                         |
| Login         | Sessions with bcrypt password hashing, Google sign-in via Passport |

## Things I'm proud of

Some of these took the longest to get right. There's more detail on each in [docs/DECISIONS.md](docs/DECISIONS.md).

- **An order is only marked paid when Stripe confirms it.** Landing on the "thank you" page doesn't count, because anyone can open that page. If Stripe sends the same confirmation twice, the order still only gets processed once.
- **Stock can't go below zero**, even if two people try to buy the last item at the same time.
- **You can't see other people's data by changing a number in the URL.** Every order, address and cart item is checked against the logged-in user, and the tests try exactly that.
- **Old orders stay correct.** If a product is renamed, repriced or deleted later, past orders still show what the customer actually paid for.
- **167 automated checks** run through the whole site the way a visitor would. See [TESTING.md](TESTING.md).

## Running it on your own computer

You'll need [Node.js](https://nodejs.org) 20 or newer and MySQL 8.

1. Clone the repo and install the packages:

   ```bash
   git clone <this repo's URL>
   cd Clothing-Store
   npm install
   ```
2. Create a database and load the tables:

   ```bash
   mysql -u root -p -e "CREATE DATABASE denise CHARACTER SET utf8mb4"
   mysql -u root -p denise < db/schema.sql
   ```
3. Copy `.env.example` to `.env` and fill it in. These are the settings the app reads:

   | Setting                                                                      | What it's for                                                    |
   | ---------------------------------------------------------------------------- | ---------------------------------------------------------------- |
   | `PORT`, `BASE_URL`                                                       | Where the site runs, e.g. `3000` and `http://localhost:3000` |
   | `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`          | Your MySQL login and database name                               |
   | `SESSION_SECRET`                                                           | Any long random string                                           |
   | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`                             | From the Stripe dashboard (test mode) and the Stripe CLI         |
   | `RESEND_API_KEY`, `MAIL_FROM`                                            | For sending emails                                               |
   | `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | For product and profile photos                                   |
   | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`      | For "Continue with Google"                                       |
4. Start the site:

   ```bash
   npm start
   ```
5. Payments only get confirmed if Stripe can reach your computer. In a second terminal, run the [Stripe CLI](https://docs.stripe.com/stripe-cli):

   ```bash
   stripe listen --forward-to localhost:3000/webhook/stripe --events checkout.session.completed
   ```

   Copy the `whsec_...` secret it prints into `STRIPE_WEBHOOK_SECRET`. If you skip this step, orders stay on "pending" forever. I found that out the hard way, more than once.
6. To get into the admin side, register an account on the site, then give it admin rights:

   ```sql
   UPDATE users SET role = 'admin' WHERE email = 'you@example.com';
   ```

## Running the tests

```bash
npm test
```

This builds its own separate test database, so it never touches your real one. Setup steps are in [TESTING.md](TESTING.md).

## More documentation

- [docs/DECISIONS.md](docs/DECISIONS.md): why I built things the way I did, and the mistakes I learned from
- [docs/DATABASE.md](docs/DATABASE.md): what the database stores, with a diagram
- [TESTING.md](TESTING.md): how to run the tests and what they cover

## How I built this

I used Claude, an AI assistant, a lot on this project. It explained concepts I hadn't learned yet (webhooks, CSRF, transactions), suggested ways to structure things, wrote a lot of the code with me, and helped track down bugs. I decided what the site should do and how it should behave, tested each feature as it was added, and went back to understand the parts I didn't get at first. 

The [DECISIONS](docs/DECISIONS.md) page is the best place to see what I learned. Every decision on it is one I can explain.

## Known limitations

- Payments are in Stripe test mode. No real cards are charged.
- Emails are sent from Resend's test sender, which can only deliver to my own address. Sending to anyone else needs a verified domain, which I don't own yet.
- More in [docs/DECISIONS.md](docs/DECISIONS.md#things-i-would-improve).
