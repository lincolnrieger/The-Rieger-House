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

Deliberately small, with **no npm dependencies**:

- **Server:** Node.js 22.13 or newer, using only built-in modules (`node:http`,
  `node:crypto`, `node:sqlite`). The whole backend lives in `src/server.js` and
  `src/db.js`.
- **Database:** one SQLite file at `data/rieger-house.db`, or wherever `DATA_DIR`
  points.
- **Frontend:** plain HTML, CSS and JavaScript in `public/`, with no build step.
  A service worker and web manifest make it installable.

### Security

- PINs are hashed with scrypt and never stored in plain text.
- Sessions use random tokens kept in an `HttpOnly`, `SameSite=Lax` cookie, which
  is also `Secure` over HTTPS. Only a SHA-256 hash of each token is stored.
- Five wrong PINs lock that account for a while, with a longer lock each time.
  There is also a limit on attempts from any single IP address. Resetting the PIN
  from Admin unlocks the account.
- The admin PIN must be at least 6 digits. Everyone else uses 4 to 8 digits.
- First-time setup needs a one-off **setup code** from the server log, so nobody
  else can claim the admin account on a fresh server.
- Requests that change data must come from the app's own origin, in JSON. Strict
  security headers are set, including CSP and frame blocking.
- **Permissions:** anyone signed in can view the dinner list. People can change
  their own plans. Only the admin can change anyone's plans, unless the admin
  turns on "Let everyone update anyone's plans". Only the admin can see Admin.

## Run it locally

```bash
npm start          # http://localhost:3000
npm run dev        # same, restarts when you edit the code
npm test           # API tests
```

The first time the app starts, it prints a **setup code** in the terminal. Open
the app, enter the code and choose Lincoln's PIN. Grant, Emma and Elijah are added
for you. Then, in Admin, open each person and **Set a PIN** for them.

Lincoln starts off the dinner list. To check in for dinner too, turn on *On the
dinner list* for Lincoln in Admin.

Environment variables (all optional):

| Variable      | Default  | Purpose |
|---------------|----------|---------|
| `PORT`        | `3000`   | Port to listen on |
| `DATA_DIR`    | `./data` | Folder for the SQLite database |
| `SETUP_CODE`  | random   | Use a fixed setup code instead of a random one |
| `TRUST_PROXY` | off      | Set to `1` behind a proxy or host that terminates HTTPS (Fly, Render, Railway, nginx) |

## Deploy

The app needs a **persistent disk** for the SQLite file. It also needs **HTTPS**,
which phones require before they will install it as an app. Any of these work.

### Fly.io (recommended, about free for a family)

```bash
fly launch --no-deploy --copy-config   # pick a unique app name when asked
fly volumes create rieger_data --size 1 --region syd
fly deploy
fly logs                                # find the setup code here
```

Then open `https://<your-app>.fly.dev` and run setup. Set `primary_region` in
`fly.toml`, and the `--region` above, to the region nearest you (`syd` is Sydney,
`lhr` is London).

### Render or Railway

Deploy the repo using the included `Dockerfile`. Attach a persistent disk or
volume mounted at `/data`, and set `TRUST_PROXY=1`. Read the setup code from the
deploy logs.

### A computer at home (Raspberry Pi, NAS)

```bash
docker build -t rieger-house .
docker run -d --restart unless-stopped -p 8080:8080 -v rieger-data:/data rieger-house
docker logs <container>   # setup code
```

Put it behind HTTPS (for example Caddy, or a Cloudflare Tunnel) and set
`TRUST_PROXY=1`.

### Backups

Everything lives in one file, `rieger-house.db`, in the data folder. Copy it
somewhere safe now and then. With Fly, use `fly ssh sftp get /data/rieger-house.db`.

## Forgotten PINs

- **A family member:** Lincoln opens Admin, taps their name and sets a new PIN.
- **Lincoln:** run this on the server, then sign in with the new PIN:

  ```bash
  npm run reset-pin -- Lincoln 246810
  # On Fly: fly ssh console -C "npm run reset-pin -- Lincoln 246810"
  ```
