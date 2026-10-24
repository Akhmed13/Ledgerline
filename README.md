# Ledgerline

A trading journal: dashboard, P&L calendar, trade log and review pages, daily journal, notebook, reports with cross analysis, playbooks, progress tracker, replay, economic calendar, agents, prop firm tracking and settings.

## Two ways to run it

### As a website (Vercel, GitHub Pages, any static host)

`index.html` at the repository root is the complete site. Deploy the repository as a static site with no build step and no framework preset; the host serves `index.html` at `/`.

In this mode the journal saves everything in the visitor's own browser (IndexedDB):

- Data stays on that browser and computer. It isn't shared between devices or visitors.
- **Settings → Data → Download backup** saves a JSON file; **Restore from backup** loads it into another browser.
- Ask Claude, AI reviews and the briefing and session-review agents are unavailable, because they need Claude.

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

Records are organised in these collections, in the artifact database or in browser storage:

`trades`, `accounts`, `imports`, `templates`, `candles`, `econ`, `props`, `propTx`, `tagcats`, `playbooks`, `journal`, `notes`, `cash`, `dashTemplates`, and the `settings` documents `account`, `rules`, `notebook`, `fees` and `agents`.

`sample-data/trades.json` holds the 66 demo trades used to seed the artifact version.

## Repository layout

```
index.html               the standalone website (generated)
src/ledgerline.html      the journal source / Claude artifact
build.py                 rebuilds index.html from the source
sample-data/trades.json  demo trades
```
