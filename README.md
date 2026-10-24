# Ledgerline

A trading journal: dashboard, P&L calendar, trade log and review pages, daily journal, notebook, reports with cross analysis, playbooks, progress tracker, replay, economic calendar, agents, prop firm tracking and settings.

## Running it on Vercel with your own database

Every create, read, update and delete runs server-side in `api/docs.js`, a Vercel serverless function that talks to the database at `DATABASE_URL`. The page itself keeps no data of its own; it loads from and saves to that API.

Set these environment variables in the Vercel project (Production and Preview), then redeploy:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | PostgreSQL: `postgres://user:password@host:5500/dbname` · MySQL/MariaDB: `mysql://user:password@host:5500/dbname` |
| `LEDGERLINE_PASSWORD` | The password you'll type to open the journal. Without it the API refuses all requests, so nobody else can read or change your data. |

- The table `ledgerline_docs` is created automatically on first use. The database user needs permission to create tables.
- `host` must be reachable from the internet (a public IP or DDNS name with the port forwarded), because Vercel's servers connect from outside your network.
- PostgreSQL without SSL: add `?sslmode=disable`. With a self-signed certificate: `?sslmode=no-verify`.
- Server logs appear in Vercel under the project's **Logs** tab, prefixed `[ledgerline]`. Connection problems are logged there and shown on the sign-in screen with a hint.
- Changes made on one device appear on others within about 15 seconds.

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
package.json             server dependencies (pg, mysql2)
index.html               the website (generated)
src/ledgerline.html      the journal source / Claude artifact
build.py                 rebuilds index.html from the source
sample-data/trades.json  demo trades
```
