# P&L Dashboard — working notes for Claude

Read `CONTEXT.md` first. It has the full data model, the six views, the deploy
recipe, and the history behind the decisions here. This file is just the rules
that are easy to break.

## What this is

A company money-flow dashboard: every dollar in and out, tagged by **category**
and **project**, plus an **employee roster** with salaries and payroll runs.

Vanilla HTML/CSS/JS. **No build step, no dependencies, no framework.** Three
files do everything:

- `index.html` — app shell, six views, six modals
- `styles.css` — design tokens + all styling (light and dark)
- `app.js` — state, totals, SVG charts, CRUD, import/export, demo seed

To run it: open `index.html`, or serve the folder. That's it. Don't add a
bundler, a framework, or a package.json unless the task genuinely requires one.

## Rules that are easy to break

- **Read form fields off `form.elements.x`, never `form.x`.** `form.name`,
  `form.method`, `form.action` and `form.target` are native HTMLFormElement
  properties and silently shadow inputs of the same name. This caused a real bug
  already.
- **Amounts are always stored positive**; the `type` field (`income` | `expense`)
  carries the direction. Anything summing money must branch on `type` — never
  assume a negative amount.
- **Don't remove the value labels at the tips of the category bars.** The lighter
  steps of that blue ramp sit under 3:1 contrast on white; the labels are the
  required accessibility relief, not decoration.
- **Chart colours are a validated pair** — money in `#2a78d6`, money out
  `#e34948` (dark: `#3987e5` / `#e66767`). They clear colourblind-separation and
  contrast gates in both modes. Don't swap them for "nicer" colours without
  re-validating.
- **Deleting a project or category never deletes money.** Entries keep their
  amounts and just lose the tag.
- **Each chart draw fully rebuilds its host's `innerHTML`.** That's deliberate —
  it's what lets the chart recover from the empty state. Don't "optimise" it into
  a partial update without handling that path.

## Deploying

`git push` to `main`. GitHub Actions stages the three site files into `dist/`
and deploys to Cloudflare Pages (~90s). Secrets are already configured on the
repo.

- Live: https://pl-dashboard-40e.pages.dev
- **`.assetsignore` does nothing for `pages deploy`** — that's why the workflow
  stages `dist/`. Without it, `CONTEXT.md` and `.github/` get published.
- Pages has no `404.html`, so unknown paths return **200 with `index.html`**.
  A 200 on `/CONTEXT.md` is not proof it's published — check the body.

## Verifying changes

There's no test suite. Verify in a real browser before claiming something works:
add and edit an entry, run payroll, switch currency and theme, sweep the date
ranges, and check 390px width for overflow. The last full pass was clean with
zero console errors.
