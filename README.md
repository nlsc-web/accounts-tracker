# Accounts Tracker

Accounts Department daily ledger (Express + SQLite locally, Postgres in production).

Same layout as the marketing tracker: one Node server, PIN login, static frontend.

Live app: _deploy in progress — URL will be added here_

## Use on a laptop (staff)

Same as [marketing tracker](https://marketing-tracker-0qiu.onrender.com/):

1. Open the live URL in Chrome.
2. Chrome menu → **Install Accounts Ledger** (or the install icon in the address bar). A desktop shortcut appears.
3. Select your name, enter your PIN, then Log In.
4. Log out when you are done if someone else uses the same laptop.

Staff accounts only see jobs assigned to them and their own work log. Mrs.Lakmali, Ms.Sajini, and Mr.Denuwan can see every staff member's jobs and times.

View-only accounts can read the board, not create, stamp, edit, or delete jobs.

## Lifetime data (production)

Render free disk is temporary. For data that survives redeploys:

1. Create a free Postgres DB at [Neon](https://neon.tech) (or Supabase).
2. Copy the connection string (`postgresql://...`).
3. In [Render Dashboard](https://dashboard.render.com) → your web service → **Environment**:
   - `DATABASE_URL` = that connection string
   - `SESSION_SECRET` = a long random string (keeps logins valid across deploys)
4. Save → service redeploys. Empty DB auto-creates tables.

Local development stays on SQLite in `data/tracker.db` (no `DATABASE_URL` needed).

## Login security

PINs are checked on the server (hashed). The API requires a login cookie.

- View-only accounts can read data, not save/edit/delete
- Entry accounts can change only their own rows (and their own work log)
- After 5 wrong PIN attempts, that name is locked for 15 minutes

To change a PIN: run `node scripts/hash-pin.js <new-pin>`, then paste the hash into `auth.js` for that person, commit, and deploy.

To change staff names, edit the `USERS` list in `auth.js`.

## Run locally

```bash
npm install
npm start
```

Open http://localhost:5600
