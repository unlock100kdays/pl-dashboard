# P&L Dashboard — Project Memory

Working memory for this project. Read this first when picking the work back up.

---

## What it is

A company money-flow dashboard. Records every dollar in and out, tagged by
**category** and **project**, plus an **employee roster** with salaries and
payroll runs that post straight to the ledger.

Fully client-side — all data lives in the visitor's own browser
(`localStorage`, key `pl-dashboard:v1`). No backend, no accounts, no network
calls. Loading it on a different browser or device shows a fresh dashboard.

## Where things live

| What | Where |
|---|---|
| Local source | `~/Desktop/P&L Dashboard` |
| Live site | https://pl-dashboard-40e.pages.dev |
| Cloudflare project | `pl-dashboard` (Workers & Pages) |
| GitHub repo | https://github.com/unlock100kdays/pl-dashboard |
| Deploy | push to `main` → GitHub Actions → Cloudflare Pages (~90s) |

Cloudflare project names can't contain `&` or spaces, so the slug is
`pl-dashboard`; "P&L Dashboard" is the display name inside the app.

### Deploying

**Normal path: just `git push`.** GitHub Actions runs
`.github/workflows/deploy.yml`, which stages `index.html` + `styles.css` +
`app.js` into `dist/` and deploys that. Repo secrets `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` are already set.

Two things learned the hard way here:
- **`.assetsignore` does nothing for `pages deploy`** — it's a Workers-assets
  feature. That's why the workflow stages `dist/` instead; without it,
  `CONTEXT.md`, `.gitignore` and `.github/` get published as static files.
- **Pages has no `404.html`, so unknown paths fall back to `index.html` with a
  200.** Don't read a 200 on `/CONTEXT.md` as "still published" — check the
  response body, not the status code.

### Fallback: deploying from this machine without wrangler

`wrangler` was unusable locally — the npm registry was crawling and both
`npx wrangler` and `npm i wrangler` stalled for 25+ minutes. Node's outbound
`fetch` is also blocked in this sandbox, though `curl` works. The first deploy
used the Pages **direct-upload API** with curl:

1. `GET  /accounts/:acct/pages/projects/pl-dashboard/upload-token` → JWT
2. `POST /pages/assets/check-missing`  (Bearer JWT) — `{hashes:[…]}`
3. `POST /pages/assets/upload`         (Bearer JWT) — `[{key,value(base64),metadata:{contentType},base64:true}]`
4. `POST /accounts/:acct/pages/projects/pl-dashboard/deployments` — `-F manifest=<manifest.json`

**The asset key does not have to be blake3.** Wrangler uses blake3, but the
server treats the key as an opaque content-address, so `sha256(base64+ext)`
truncated to 32 hex chars works fine. That's what unblocked this.

Note: `gh` is not installed on this machine — use the GitHub REST API via curl,
and PyNaCl (which *is* installed) to seal Actions secrets.

## Files

```
index.html    — full app shell: sidebar, topbar, 6 views, 6 modals
styles.css    — design tokens + all styling (light/dark)
app.js        — state, totals, SVG charts, CRUD, import/export, demo seed
CONTEXT.md    — this file
```

No build step, no dependencies, no framework. Open `index.html` directly or
serve the folder — both work.

## The six views

1. **Overview** — hero net profit + delta vs previous period, four stat tiles,
   cash-flow columns by month, category ranking bars, project P&L table, recent feed
2. **Transactions** — full ledger; search, filter by direction/category/project,
   sortable columns, CSV export, inline edit/delete
3. **Projects** — one card per project with net, in/out split, margin, team size, budget used
4. **Employees** — roster + salary cost tiles, and pay runs
5. **Categories** — manage income and expense categories, each with its own share meter
6. **Settings** — company name, currency, JSON backup/restore, CSV export, sample data, wipe

## Data model

```js
{
  settings:     { company, currency },
  categories:   [{ id, name, type }],                        // type: income | expense
  projects:     [{ id, name, client, status, budget, startDate }],
  employees:    [{ id, name, role, department, status, salary, frequency, project, startDate }],
  transactions: [{ id, created, type, amount, date, category, project,
                   description, method, reference, payrun?, employee? }],
  payruns:      [{ id, date, period, count, total }],
}
```

Amounts are always stored **positive**; `type` carries the direction. Anything
that sums money must branch on `type` — never assume a negative amount.

## Things worth remembering

- **Read form fields off `form.elements.x`, never `form.x`.** `form.name`,
  `form.method`, `form.action` and `form.target` are native HTMLFormElement
  properties and silently shadow inputs of the same name. This bit once already.
- **Salary frequency normalises to monthly** via `FREQ_TO_MONTHLY`
  (annual ÷12, biweekly ×26/12, weekly ×52/12, hourly ×160). Hourly assumes a
  160-hour month — change it there if that assumption is wrong.
- **A pay run writes one expense per person**, tagged to that person's assigned
  project and stamped with `payrun` + `employee` ids. Reversing a run deletes
  every transaction carrying its `payrun` id, so the link must stay intact.
- **Deleting a project or category never deletes money.** Entries keep their
  amounts and just lose the tag (project → blank, category → "Uncategorised").
- **Charts are hand-built SVG** — no chart library. Each draw fully rebuilds its
  host's `innerHTML`, which is what lets it recover from the empty state.
  Redraws are wired to resize, theme change, and view switch.
- **Chart colours are a validated diverging pair**: money in `#2a78d6` (blue),
  money out `#e34948` (red); dark mode steps to `#3987e5` / `#e66767`. Both
  modes clear the colourblind-separation and contrast gates. The category
  ranking uses a single-hue blue ramp (magnitude), and its light steps sit under
  3:1 on white — the value labels at the bar tips are the required relief, so
  **don't remove them**.
- **First visit auto-seeds a sample company** (Northgate Studio, 14 months of
  activity) so the dashboard is never a blank grid. It only fires when
  `localStorage` has no key at all — a genuinely wiped dashboard stays wiped.
- Keyboard: `n` opens a new entry, `/` jumps to the ledger search.

## Verified

Smoke-tested in headless Chromium (Playwright) with 0 console/page errors:
add + edit entries, search, sort, project CRUD, employee CRUD, a posted pay run,
currency switch, all seven date ranges, theme toggle, wipe → empty states →
reseed, and mobile at 390px with no horizontal overflow.

## Ideas not built yet

- Recurring / scheduled entries (rent, subscriptions) that auto-post
- Budget vs actual alerting per project
- Multi-currency entries (currency is global right now)
- Per-employee payroll history view
