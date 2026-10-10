# The Rieger House

Who's home for dinner tonight, at a glance.

Open the app and today is already selected. The page shows who's home for dinner,
who isn't, who hasn't answered yet, and who has to head out after dinner and when.
Each person updates their own plans with two or three taps.

## What it does

- **Calendar.** A week strip, or a full month with "Show month". Each day has one
  dot per person: green means home, rose means not home, and an empty ring means
  no answer yet.
- **Daily check-in.** *Yes, home* or *No, not home*. If you're home, you also
  answer *Going out after dinner?* If yes, fill in **What is it?** and **What time
  do you need to leave?** Things you've typed before show up as one-tap chips.
- **Shared view.** Everyone sees everyone's answers for the selected day on one
  screen.
- **Automatic saving.** Every tap saves straight to the server. Other phones pick
  up changes within 30 seconds, or straight away when the app is reopened.
- **Accounts.** Each person taps their name and types a PIN. They stay signed in
  on that phone for six months.
- **Admin (Lincoln).** Add, rename or remove people, set or reset PINs, choose
  colours, decide who appears on the dinner list, rename the household, and choose
  whether everyone can update anyone's plans. That last one is handy if Mum wants
  to fill in for the kids.
- **Installable.** On iPhone: Share, then *Add to Home Screen*. On Android: the
  browser menu, then *Install app*.

## Tech stack

Everything runs on **Cloudflare**:

- **Cloudflare Workers.** `src/worker.js` is the API (`/api/*`). It has no
  dependencies and no build step.
- **Workers Static Assets.** Serves the frontend in `public/`: plain HTML, CSS and
  JavaScript, a service worker and a web manifest. Security headers live in
  `public/_headers`.
- **Cloudflare D1.** Stores everything in a SQLite database. The schema is in
  `migrations/`.
- **Wrangler.** Used for local development, migrations and deploys. It's the only
  dev dependency.

Cloudflare's free plan covers a family easily.

### Security

- PINs are hashed with PBKDF2-SHA256 (100,000 iterations, random salt) and never
  stored in plain text.
- Sessions use random tokens kept in an `HttpOnly`, `Secure`, `SameSite=Lax`
  cookie. Only a SHA-256 hash of each token is stored.
- Five wrong PINs lock that account for a while, with a longer lock each time.
  There is also a limit on attempts from any single IP address. Resetting the PIN
  from Admin unlocks the account.
- The admin PIN must be at least 6 digits. Everyone else uses 4 to 8 digits.
- First-time setup needs the `SETUP_CODE` secret, so nobody else can claim the
  admin account on a fresh deploy.
- Requests that change data must come from the app's own origin, in JSON. Strict
  security headers are set, including CSP and frame blocking.
- **Permissions:** anyone signed in can view the dinner list. People can change
  their own plans. Only the admin can change anyone's plans, unless the admin
  turns on "Let everyone update anyone's plans". Only the admin can see Admin.

## Deploy to Cloudflare

You need a free Cloudflare account and Node.js 20 or newer.

```bash
npm install
npx wrangler login

# 1. Create the database, then paste the database_id it prints into wrangler.jsonc
npx wrangler d1 create rieger-house --location oc   # oc = Oceania; weur = Western Europe

# 2. Create the tables
npm run db:migrate

# 3. Choose a setup code (any number you like; you'll type it once)
npx wrangler secret put SETUP_CODE

# 4. Deploy
npm run deploy
```

Wrangler prints the address, for example `https://rieger-house.<you>.workers.dev`.
To use your own domain, add it under the Worker's **Settings → Domains & Routes** in
the Cloudflare dashboard.

### First-time setup

1. Open the app, enter your setup code and choose Lincoln's PIN. Grant, Emma and
   Elijah are added for you.
2. In Admin, open each person and **Set a PIN** for them.
3. Lincoln starts off the dinner list. To check in for dinner too, turn on *On the
   dinner list* for Lincoln in Admin.

The setup code stops working once setup is done. You can delete the secret
afterwards with `npx wrangler secret delete SETUP_CODE`.

### Updating

After changing code, run `npm run deploy`. If a new file appears in `migrations/`,
run `npm run db:migrate` first.

## Run it locally

```bash
npm install
cp .dev.vars.example .dev.vars    # local setup code: 111111
npm run db:migrate:local
npm run dev                        # http://localhost:8787
npm test                           # API tests against a throwaway local database
```

Local development uses a local copy of D1 under `.wrangler/`, never your live data.

## Forgotten PINs

- **A family member:** Lincoln opens Admin, taps their name and sets a new PIN.
- **Lincoln:** run this from the project folder while logged in to Wrangler, then
  sign in with the new PIN:

  ```bash
  npm run reset-pin -- Lincoln 246810
  ```

## Backups

D1 keeps 30 days of history automatically (Time Travel). To restore, see
`npx wrangler d1 time-travel --help`. To save a copy yourself:

```bash
npx wrangler d1 export rieger-house --remote --output backup.sql
```
