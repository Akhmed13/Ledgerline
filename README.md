# Ledgerline

A trading journal: dashboard, P&L calendar, trade log and review pages, daily journal, notebook, reports with cross analysis, playbooks, progress tracker, replay, economic calendar, agents, prop firm tracking and settings.

## Running it on Vercel with your own database

Every create, read, update and delete runs server-side in `api/docs.js`, a Vercel serverless function that talks to the database at `DATABASE_URL`. The page itself keeps no data of its own; it loads from and saves to that API.

Set these environment variables in the Vercel project (Production and Preview), then redeploy:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | PostgreSQL: `postgres://user:password@host:5500/dbname` · MySQL/MariaDB: `mysql://user:password@host:5500/dbname` |
| `LEDGERLINE_PASSWORD` | The password you'll type to open the journal. Without it the API refuses all requests, so nobody else can read or change your data. |
| `METAAPI_TOKEN` | Optional. A [MetaApi](https://metaapi.cloud) API token, used for MetaTrader 4/5 auto-sync (`api/broker.js`). |

- The table `ledgerline_docs` is created automatically on first use. The database user needs permission to create tables.
- `host` must be reachable from the internet (a public IP or DDNS name with the port forwarded), because Vercel's servers connect from outside your network.
- PostgreSQL without SSL: add `?sslmode=disable`. With a self-signed certificate: `?sslmode=no-verify`.
- Server logs appear in Vercel under the project's **Logs** tab, prefixed `[ledgerline]`. Connection problems are logged there and shown on the sign-in screen with a hint.
- Changes made on one device appear on others within about 15 seconds.

### Broker auto-sync (MetaTrader 4 / 5)

**Add trades** opens a wizard: pick a broker, prop firm or platform, then choose Auto-sync, File upload or Add manually.
Auto-sync links MetaTrader 4/5 accounts (MT5, MT4, and MT-based brokers and prop firms such as FTMO, IC Markets or Blueberry) through MetaApi:

1. Create a MetaApi account and an API token, and set `METAAPI_TOKEN` in Vercel, then redeploy.
2. In the journal choose your broker → Auto-sync, then enter the server, login and **investor (read-only)** password.
3. `api/broker.js` links the account at MetaApi, waits for the terminal to connect, reads the last 365 days of deals and turns closed positions into trades. You see a preview with starting balance, current balance and total P&L, then import.

The investor password is passed to MetaApi once and isn't stored in the journal database. Linked accounts show as **Auto-sync** under Settings → Accounts; new trades are pulled every 6 hours while the journal is open, or with **Sync now**. **Stop auto-sync** removes the account from MetaApi and keeps the imported trades. MetaApi bills per linked account, so check its pricing.

Other platforms use File upload (Tradovate and NinjaTrader have built-in parsers; the rest map CSV columns).

### Without a backend

Opened from a plain static host or as a local file (no `/api/docs`), the page falls back to saving in the browser's IndexedDB, with backup and restore under **Settings → Data**.

### As a Claude artifact

`src/ledgerline.html` is the source published as a Claude artifact. There it uses the artifact runtime (`window.claude.use(...)`):

| Capability | Used for |
| --- | --- |
| `db` | Saving trades, accounts, tags, playbooks, journal entries, notes, rules, templates and settings |
| `user` | Identifying the viewer |
| `assets` | Uploading trade screenshots |
| `downloads` | CSV exports |
| `sample` | The Ask Claude assistant, AI reviews and agents |

The file is a page fragment (it starts with `<title>` and `<style>`), because the artifact host wraps it in its own document skeleton.

## Editing

Edit `src/ledgerline.html`, then rebuild the site:

```
python3 build.py
```

That regenerates `index.html` by wrapping the source in a full HTML document.

## Data

Records are stored as JSON documents (one row per document in `ledgerline_docs`), grouped in these collections:

`trades`, `accounts`, `imports`, `templates`, `candles`, `econ`, `props`, `propTx`, `tagcats`, `playbooks`, `journal`, `notes`, `cash`, `dashTemplates`, and the `settings` documents `account`, `rules`, `notebook`, `fees` and `agents`.

`sample-data/trades.json` holds the 66 demo trades used to seed the artifact version.

## Repository layout

```
api/docs.js              server-side storage API (Vercel function)
api/broker.js            MetaTrader auto-sync through MetaApi (Vercel function)
package.json             server dependencies (pg, mysql2)
index.html               the website (generated)
src/ledgerline.html      the journal source / Claude artifact
build.py                 rebuilds index.html from the source
favicon.*, icon-*.png    site icons (plus apple-touch-icon.png, site.webmanifest)
sample-data/trades.json  demo trades
```
