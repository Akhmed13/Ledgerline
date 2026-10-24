# Ledgerline

A trading journal: dashboard, P&L calendar, trade log and review pages, daily journal, notebook, reports with cross analysis, playbooks, progress tracker, replay, economic calendar, agents, prop firm tracking and settings.

## How it runs

`src/ledgerline.html` is a single self-contained page (HTML, CSS and JavaScript in one file). It is published as a Claude artifact and relies on the artifact runtime (`window.claude.use(...)`) for:

| Capability | Used for |
| --- | --- |
| `db` | Saving trades, accounts, tags, playbooks, journal entries, notes, rules, templates and settings |
| `user` | Identifying the viewer |
| `assets` | Uploading trade screenshots |
| `downloads` | CSV exports |
| `sample` | The Ask Claude assistant, AI reviews and agents |

Opened directly from disk, the page renders but shows "Saving isn't available in this view", and the assistant is unavailable.

The file is a page fragment (it starts with `<title>` and `<style>`, with no `<!doctype>`, `<html>` or `<body>`), because the artifact host wraps it in its own document skeleton.

## Data

Records live in the artifact's database, in these collections:

`trades`, `accounts`, `imports`, `templates`, `candles`, `econ`, `props`, `propTx`, `tagcats`, `playbooks`, `journal`, `notes`, `cash`, `dashTemplates`, and the `settings` documents `account`, `rules`, `notebook`, `fees` and `agents`.

`sample-data/trades.json` holds the 66 demo trades used to seed the journal.

## Repository layout

```
src/ledgerline.html      the journal page
sample-data/trades.json  demo trades
```
