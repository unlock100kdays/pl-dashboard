# P&L Dashboard

A company money-flow dashboard. Record every dollar in and out, tagged by
**category** and **project**, with an **employee roster** and **payroll runs**
that post salary expenses straight to the ledger.

**Live:** https://pl-dashboard-40e.pages.dev

---

## Running it

Open `index.html` in a browser. That's the whole setup — no install, no build,
no dependencies.

To serve it locally instead:

```bash
python3 -m http.server 8000
# → http://localhost:8000
```

## What's in it

| View | What it does |
|---|---|
| **Overview** | Net profit + trend, money in/out, margin, payroll cost, cash flow by month, category ranking, profit by project, recent activity |
| **Transactions** | The full ledger — search, filter by direction/category/project, sortable columns, CSV export |
| **Projects** | A card per project: net, in/out split, margin, team size, budget used |
| **Employees** | Roster with salary at any frequency (monthly/annual/biweekly/weekly/hourly), all normalised to monthly cost — plus payroll runs |
| **Categories** | Manage income and cost categories, each with a share meter |
| **Settings** | Company name, 9 currencies, JSON backup/restore, CSV export, sample data, wipe |

Light and dark themes; works down to 390px wide.

## Where the data lives

**Entirely in your browser** (`localStorage`, key `pl-dashboard:v1`). Nothing is
uploaded anywhere — there's no backend and no accounts. That means:

- Your data doesn't leave your machine.
- It does **not** sync between browsers or devices.
- Clearing site data wipes it. Use **Settings → Download backup (JSON)** first.

The app opens with a sample company so it isn't a blank grid.
**Settings → Erase everything** clears it and leaves it cleared.

## Files

```
index.html    app shell — six views, six modals
styles.css    design tokens + all styling
app.js        state, totals, SVG charts, CRUD, import/export
CLAUDE.md     working rules for Claude Code
CONTEXT.md    full project notes — data model, decisions, deploy recipe
```

## Deploying

Push to `main`. GitHub Actions deploys to Cloudflare Pages in about 90 seconds.

```bash
git add -A && git commit -m "your change" && git push
```

Repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are already set.
See `CONTEXT.md` for the deploy details and the gotchas behind them.
