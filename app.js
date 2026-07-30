/* ═══════════════════════════════════════════════════════════
   P&L Dashboard
   Client-side ledger: money in / money out, tagged by category
   and project, plus an employee roster and payroll runs.
   All state lives in localStorage — nothing leaves the browser.
   ═══════════════════════════════════════════════════════════ */

'use strict';

const STORE_KEY = 'pl-dashboard:v1';
const THEME_KEY = 'pl-dashboard:theme';

/* ── tiny helpers ──────────────────────────────────────── */
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const sum = (arr, fn) => arr.reduce((a, x) => a + fn(x), 0);
const todayISO = () => new Date().toISOString().slice(0, 10);

/* ── state ─────────────────────────────────────────────── */
const DEFAULT_CATEGORIES = [
  { name: 'Client revenue',        type: 'income'  },
  { name: 'Product sales',         type: 'income'  },
  { name: 'Retainers',             type: 'income'  },
  { name: 'Interest & other',      type: 'income'  },
  { name: 'Salaries & wages',      type: 'expense' },
  { name: 'Contractors',           type: 'expense' },
  { name: 'Software & tools',      type: 'expense' },
  { name: 'Marketing & ads',       type: 'expense' },
  { name: 'Rent & utilities',      type: 'expense' },
  { name: 'Travel',                type: 'expense' },
  { name: 'Equipment',             type: 'expense' },
  { name: 'Professional fees',     type: 'expense' },
  { name: 'Taxes',                 type: 'expense' },
];

const blankState = () => ({
  settings: { company: 'My Company', currency: 'USD' },
  categories: DEFAULT_CATEGORIES.map((c) => ({ id: uid(), ...c })),
  projects: [],
  employees: [],
  transactions: [],
  payruns: [],
});

let state = load();
let ui = {
  view: 'overview',
  range: '12m',
  breakdownDir: 'expense',
  txSearch: '',
  txType: '',
  txCat: '',
  txProj: '',
  txSort: { key: 'date', dir: -1 },
};

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return blankState();
    const parsed = JSON.parse(raw);
    return { ...blankState(), ...parsed, settings: { ...blankState().settings, ...(parsed.settings || {}) } };
  } catch {
    return blankState();
  }
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch (err) {
    toast('Could not save — browser storage is full', 'bad');
  }
}

/* ── money & dates ─────────────────────────────────────── */
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND']);

function fmtMoney(n, { compact = false, sign = false } = {}) {
  const cur = state.settings.currency || 'USD';
  const abs = Math.abs(n);
  const opts = {
    style: 'currency', currency: cur,
    maximumFractionDigits: ZERO_DECIMAL.has(cur) ? 0 : (compact || abs >= 1000 ? 0 : 2),
    minimumFractionDigits: 0,
  };
  if (compact && abs >= 10000) { opts.notation = 'compact'; opts.maximumFractionDigits = 1; }
  let out;
  try { out = new Intl.NumberFormat(undefined, opts).format(abs); }
  catch { out = abs.toFixed(0); }
  const prefix = n < 0 ? '−' : (sign && n > 0 ? '+' : '');
  return prefix + out;
}

function currencySymbol() {
  const cur = state.settings.currency || 'USD';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, maximumFractionDigits: 0 })
      .formatToParts(0).find((p) => p.type === 'currency')?.value || '$';
  } catch { return '$'; }
}

const fmtDate = (iso) => {
  const d = new Date(iso + 'T00:00:00');
  return isNaN(d) ? iso : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};
const monthKey = (iso) => String(iso).slice(0, 7);
const monthLabel = (key) => {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'short' });
};
const monthLabelFull = (key) => {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
};

const RANGE_LABELS = {
  all: 'All time', ytd: 'Year to date', '12m': 'Last 12 months', '6m': 'Last 6 months',
  '90d': 'Last 90 days', '30d': 'Last 30 days', mtd: 'Month to date',
};

/** Returns {start, end} as ISO date strings; start is null for "all". */
function rangeBounds(range = ui.range) {
  const now = new Date();
  const end = todayISO();
  const back = (days) => { const d = new Date(now); d.setDate(d.getDate() - days + 1); return d.toISOString().slice(0, 10); };
  const backMonths = (m) => { const d = new Date(now.getFullYear(), now.getMonth() - m + 1, 1); return d.toISOString().slice(0, 10); };
  switch (range) {
    case 'all': return { start: null, end: null };
    case 'ytd': return { start: `${now.getFullYear()}-01-01`, end };
    case 'mtd': return { start: end.slice(0, 8) + '01', end };
    case '30d': return { start: back(30), end };
    case '90d': return { start: back(90), end };
    case '6m':  return { start: backMonths(6), end };
    case '12m':
    default:    return { start: backMonths(12), end };
  }
}

/** The equal-length window immediately before the current one. */
function previousBounds() {
  const { start, end } = rangeBounds();
  if (!start) return null;
  const s = new Date(start + 'T00:00:00'), e = new Date(end + 'T00:00:00');
  const span = Math.max(1, Math.round((e - s) / 86400000) + 1);
  const pe = new Date(s); pe.setDate(pe.getDate() - 1);
  const ps = new Date(pe); ps.setDate(ps.getDate() - span + 1);
  return { start: ps.toISOString().slice(0, 10), end: pe.toISOString().slice(0, 10) };
}

function inRange(tx, bounds) {
  if (!bounds || !bounds.start) return true;
  return tx.date >= bounds.start && tx.date <= bounds.end;
}

const txInRange = (bounds = rangeBounds()) => state.transactions.filter((t) => inRange(t, bounds));

/* ── lookups ───────────────────────────────────────────── */
const catById  = (id) => state.categories.find((c) => c.id === id);
const projById = (id) => state.projects.find((p) => p.id === id);
const catName  = (id) => catById(id)?.name || 'Uncategorised';
const projName = (id) => projById(id)?.name || null;

const FREQ_LABEL = { monthly: '/month', annual: '/year', biweekly: '/2 weeks', weekly: '/week', hourly: '/hour' };
const FREQ_TO_MONTHLY = { monthly: 1, annual: 1 / 12, biweekly: 26 / 12, weekly: 52 / 12, hourly: 160 };
const monthlyCost = (emp) => (Number(emp.salary) || 0) * (FREQ_TO_MONTHLY[emp.frequency] ?? 1);
const isActiveEmp = (e) => e.status === 'Active' || e.status === 'Contract' || e.status === 'On leave';

/* ── totals ────────────────────────────────────────────── */
function totals(list) {
  const income  = sum(list.filter((t) => t.type === 'income'),  (t) => Number(t.amount) || 0);
  const expense = sum(list.filter((t) => t.type === 'expense'), (t) => Number(t.amount) || 0);
  return { income, expense, net: income - expense, margin: income ? (income - expense) / income : null };
}

/** Month buckets covering the active range (or the data's own span). */
function monthlySeries(list) {
  const { start, end } = rangeBounds();
  let from, to;
  if (start) { from = start.slice(0, 7); to = end.slice(0, 7); }
  else if (list.length) {
    const keys = list.map((t) => monthKey(t.date)).sort();
    from = keys[0]; to = keys[keys.length - 1];
  } else {
    from = to = todayISO().slice(0, 7);
  }
  const buckets = new Map();
  let [y, m] = from.split('-').map(Number);
  const [ey, em] = to.split('-').map(Number);
  let guard = 0;
  while ((y < ey || (y === ey && m <= em)) && guard++ < 240) {
    buckets.set(`${y}-${String(m).padStart(2, '0')}`, { key: `${y}-${String(m).padStart(2, '0')}`, income: 0, expense: 0 });
    m++; if (m > 12) { m = 1; y++; }
  }
  for (const t of list) {
    const b = buckets.get(monthKey(t.date));
    if (b) b[t.type] += Number(t.amount) || 0;
  }
  return [...buckets.values()].map((b) => ({ ...b, net: b.income - b.expense }));
}

/* ═══════════════════════════════════════════════════════
   Charts — hand-built SVG.
   money in = blue, money out = red (validated diverging pair)
   ═══════════════════════════════════════════════════════ */
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Rounded data-end at the top, square at the baseline. */
function columnPath(x, y, w, h, r = 4) {
  const rr = Math.min(r, w / 2, Math.max(0, h));
  if (h <= 0.5) return '';
  return `M${x},${y + h}L${x},${y + rr}Q${x},${y} ${x + rr},${y}L${x + w - rr},${y}Q${x + w},${y} ${x + w},${y + rr}L${x + w},${y + h}Z`;
}
/** Rounded data-end at the right, square at the baseline. */
function rowPath(x, y, w, h, r = 4) {
  const rr = Math.min(r, h / 2, Math.max(0, w));
  if (w <= 0.5) return '';
  return `M${x},${y}L${x + w - rr},${y}Q${x + w},${y} ${x + w},${y + rr}L${x + w},${y + h - rr}Q${x + w},${y + h} ${x + w - rr},${y + h}L${x},${y + h}Z`;
}

function niceTicks(max, count = 4) {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const ticks = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step);
  return ticks;
}

const compactAxis = (n) => {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(a % 1e9 ? 1 : 0) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(a % 1e6 ? 1 : 0) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(a % 1e3 ? 1 : 0) + 'K';
  return String(Math.round(n));
};

/* ── cash-flow columns ─────────────────────────────────── */
function drawFlowChart() {
  const host = $('#flowHost');
  const data = monthlySeries(txInRange());

  if (!data.length || !data.some((d) => d.income || d.expense)) {
    host.onpointermove = host.onpointerleave = null;
    host.innerHTML = emptyBlock('No entries in this period', 'Add an entry or widen the date range to see cash flow.');
    $('#flowTable').innerHTML = '';
    return;
  }

  // rebuild the host each pass so it recovers cleanly from the empty state
  host.innerHTML = `<svg id="flowChart" role="img" aria-label="Grouped columns comparing money in and money out for each month"></svg><div class="tooltip" id="flowTip" role="status" aria-live="polite"></div>`;
  const svg = $('#flowChart', host);
  const tip = $('#flowTip', host);
  const W = host.clientWidth || 600;
  const H = host.clientHeight || 260;

  const pad = { t: 12, r: 8, b: 26, l: 44 };
  const iw = Math.max(40, W - pad.l - pad.r);
  const ih = Math.max(40, H - pad.t - pad.b);
  const max = Math.max(...data.map((d) => Math.max(d.income, d.expense)), 1);
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1];
  const yOf = (v) => pad.t + ih - (v / top) * ih;

  const band = iw / data.length;
  const GAP = 2;                                   // the surface gap between paired bars
  const barW = clamp((band - 16 - GAP) / 2, 3, 24); // bars capped at 24px, never fill the band
  const groupW = barW * 2 + GAP;

  let g = '';
  ticks.forEach((t) => {
    const y = yOf(t);
    g += `<line class="grid-line" x1="${pad.l}" y1="${y.toFixed(1)}" x2="${(pad.l + iw).toFixed(1)}" y2="${y.toFixed(1)}"/>`;
    g += `<text class="axis-text" x="${pad.l - 9}" y="${(y + 3.5).toFixed(1)}" text-anchor="end">${compactAxis(t)}</text>`;
  });
  g += `<line class="axis-line" x1="${pad.l}" y1="${(pad.t + ih).toFixed(1)}" x2="${(pad.l + iw).toFixed(1)}" y2="${(pad.t + ih).toFixed(1)}"/>`;

  const showEvery = Math.ceil(data.length / (iw / 46));
  data.forEach((d, i) => {
    const cx = pad.l + band * i + band / 2;
    const x0 = cx - groupW / 2;
    const hIn  = (d.income / top) * ih;
    const hOut = (d.expense / top) * ih;
    g += `<rect class="hover-band" data-i="${i}" x="${(pad.l + band * i).toFixed(1)}" y="${pad.t}" width="${band.toFixed(1)}" height="${ih}" rx="6"/>`;
    g += `<path class="bar" data-i="${i}" d="${columnPath(x0, yOf(d.income), barW, hIn)}" fill="var(--flow-in)"/>`;
    g += `<path class="bar" data-i="${i}" d="${columnPath(x0 + barW + GAP, yOf(d.expense), barW, hOut)}" fill="var(--flow-out)"/>`;
    if (i % showEvery === 0 || i === data.length - 1) {
      g += `<text class="axis-text" x="${cx.toFixed(1)}" y="${(pad.t + ih + 17).toFixed(1)}" text-anchor="middle">${monthLabel(d.key)}</text>`;
    }
  });

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = g;

  // hover layer: one band per month, crosshair-style
  const bands = $$('.hover-band', svg);
  const bars = $$('.bar', svg);
  const onMove = (ev) => {
    const rect = host.getBoundingClientRect();
    const i = clamp(Math.floor(((ev.clientX - rect.left) - pad.l) / band), 0, data.length - 1);
    if (ev.clientX - rect.left < pad.l) { onLeave(); return; }
    const d = data[i];
    bands.forEach((b, j) => b.classList.toggle('is-on', j === i));
    bars.forEach((b) => b.classList.toggle('is-hot', +b.dataset.i === i));
    host.classList.add('is-hovering');
    tip.innerHTML =
      `<h4>${monthLabelFull(d.key)}</h4>` +
      row('key-in', 'Money in', fmtMoney(d.income)) +
      row('key-out', 'Money out', fmtMoney(d.expense)) +
      `<div class="tooltip-sep"></div>` +
      `<div class="tooltip-row"><span>Net</span><b class="${d.net < 0 ? 'is-negative' : ''}">${fmtMoney(d.net, { sign: true })}</b></div>`;
    tip.classList.add('is-on');
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    const cx = pad.l + band * i + band / 2;
    tip.style.left = `${clamp(cx - tw / 2, 4, W - tw - 4)}px`;
    tip.style.top = `${clamp(yOf(Math.max(d.income, d.expense)) - th - 10, 4, H - th - 4)}px`;
  };
  const onLeave = () => {
    bands.forEach((b) => b.classList.remove('is-on'));
    host.classList.remove('is-hovering');
    tip.classList.remove('is-on');
  };
  host.onpointermove = onMove;
  host.onpointerleave = onLeave;

  function row(key, label, val) {
    return `<div class="tooltip-row"><i class="key ${key}"></i><span>${label}</span><b>${val}</b></div>`;
  }

  // table view — every value stays reachable without colour
  $('#flowTable').innerHTML =
    `<thead><tr><th>Month</th><th class="num">Money in</th><th class="num">Money out</th><th class="num">Net</th></tr></thead><tbody>` +
    data.map((d) => `<tr><td>${monthLabelFull(d.key)}</td><td class="num">${fmtMoney(d.income)}</td><td class="num">${fmtMoney(d.expense)}</td><td class="num ${d.net < 0 ? 'is-negative' : ''}">${fmtMoney(d.net, { sign: true })}</td></tr>`).join('') +
    `</tbody>`;
}

/* ── category ranking bars ─────────────────────────────── */
function drawCategoryChart() {
  const host = $('#catHost');
  const dir = ui.breakdownDir;
  const list = txInRange().filter((t) => t.type === dir);

  const byCat = new Map();
  for (const t of list) {
    const name = catName(t.category);
    byCat.set(name, (byCat.get(name) || 0) + (Number(t.amount) || 0));
  }
  let rows = [...byCat.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);

  if (!rows.length) {
    host.onpointermove = host.onpointerleave = null;
    host.style.height = '';
    host.innerHTML = emptyBlock('Nothing to break down', `No ${dir === 'expense' ? 'costs' : 'income'} recorded in this period.`);
    $('#catTable').innerHTML = '';
    return;
  }

  // cap at 6 slots; the tail folds into "Other" rather than growing the palette
  if (rows.length > 7) {
    const head = rows.slice(0, 6);
    const other = sum(rows.slice(6), (r) => r.value);
    rows = [...head, { name: 'Other', value: other, isOther: true }];
  }

  // size the host to the row count so bars never spill past the card
  const H = clamp(rows.length * 38, 180, 420);
  host.style.height = `${H}px`;
  host.innerHTML = `<svg id="catChart" role="img" aria-label="Horizontal bars ranking categories by total amount"></svg><div class="tooltip" id="catTip" role="status" aria-live="polite"></div>`;
  const svg = $('#catChart', host);
  const tip = $('#catTip', host);

  const W = host.clientWidth || 500;
  const labelW = clamp(Math.round(W * 0.32), 90, 168);
  const pad = { t: 4, r: 62, b: 4, l: labelW };
  const iw = Math.max(30, W - pad.l - pad.r);
  const ih = H - pad.t - pad.b;
  const max = Math.max(...rows.map((r) => r.value), 1);

  const band = ih / rows.length;
  const barH = clamp(band - 12, 6, 24);
  const ramp = ['--seq-1', '--seq-2', '--seq-3', '--seq-4', '--seq-5', '--seq-6'];
  const total = sum(rows, (r) => r.value);

  let g = '';
  rows.forEach((r, i) => {
    const y = pad.t + band * i + (band - barH) / 2;
    const w = (r.value / max) * iw;
    const fill = r.isOther ? 'var(--line-strong)' : `var(${ramp[Math.min(i, ramp.length - 1)]})`;
    const name = r.name.length > 22 ? r.name.slice(0, 21) + '…' : r.name;
    g += `<text class="cat-name" x="${pad.l - 12}" y="${(y + barH / 2 + 4).toFixed(1)}" text-anchor="end">${esc(name)}</text>`;
    g += `<rect class="hover-band" data-i="${i}" x="0" y="${(pad.t + band * i).toFixed(1)}" width="${W}" height="${band.toFixed(1)}" rx="6"/>`;
    g += `<path class="bar" data-i="${i}" d="${rowPath(pad.l, y, w, barH)}" fill="${fill}"/>`;
    // direct label at the tip — the relief for light hues that sit under 3:1
    g += `<text class="bar-label" x="${(pad.l + w + 9).toFixed(1)}" y="${(y + barH / 2 + 4).toFixed(1)}">${fmtMoney(r.value, { compact: true })}</text>`;
  });

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = g;

  const bars = $$('.bar', svg);
  const bands = $$('.hover-band', svg);
  host.onpointermove = (ev) => {
    const rect = host.getBoundingClientRect();
    const i = clamp(Math.floor(((ev.clientY - rect.top) - pad.t) / band), 0, rows.length - 1);
    const r = rows[i];
    bands.forEach((b, j) => b.classList.toggle('is-on', j === i));
    bars.forEach((b) => b.classList.toggle('is-hot', +b.dataset.i === i));
    host.classList.add('is-hovering');
    const share = total ? (r.value / total) * 100 : 0;
    tip.innerHTML = `<h4>${esc(r.name)}</h4>` +
      `<div class="tooltip-row"><span>Total</span><b>${fmtMoney(r.value)}</b></div>` +
      `<div class="tooltip-row"><span>Share</span><b>${share.toFixed(1)}%</b></div>`;
    tip.classList.add('is-on');
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = `${clamp(ev.clientX - rect.left + 14, 4, W - tw - 4)}px`;
    tip.style.top = `${clamp(pad.t + band * i + band / 2 - th / 2, 4, H - th - 4)}px`;
  };
  host.onpointerleave = () => {
    bands.forEach((b) => b.classList.remove('is-on'));
    host.classList.remove('is-hovering');
    tip.classList.remove('is-on');
  };

  $('#catTable').innerHTML =
    `<thead><tr><th>Category</th><th class="num">Total</th><th class="num">Share</th></tr></thead><tbody>` +
    rows.map((r) => `<tr><td>${esc(r.name)}</td><td class="num">${fmtMoney(r.value)}</td><td class="num">${total ? ((r.value / total) * 100).toFixed(1) : '0.0'}%</td></tr>`).join('') +
    `</tbody>`;
}

/* ── hero sparkline (single series → no legend) ────────── */
function drawSparkline() {
  const svg = $('#heroSpark');
  const data = monthlySeries(txInRange());
  const W = 320, H = 64;
  if (data.length < 2) { svg.innerHTML = ''; return; }

  const vals = data.map((d) => d.net);
  const lo = Math.min(...vals, 0), hi = Math.max(...vals, 0);
  const span = (hi - lo) || 1;
  const x = (i) => (i / (data.length - 1)) * (W - 6) + 3;
  const y = (v) => H - 6 - ((v - lo) / span) * (H - 12);

  const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  const line = `M${pts.join('L')}`;
  const area = `${line}L${x(data.length - 1).toFixed(1)},${y(lo).toFixed(1)}L${x(0).toFixed(1)},${y(lo).toFixed(1)}Z`;
  const last = vals[vals.length - 1];
  const stroke = last < 0 ? 'var(--flow-out)' : 'var(--flow-in)';
  const zeroY = y(0);

  svg.innerHTML =
    `<path d="${area}" fill="${stroke}" opacity="0.10"/>` +
    (lo < 0 ? `<line class="grid-line" x1="3" y1="${zeroY.toFixed(1)}" x2="${W - 3}" y2="${zeroY.toFixed(1)}"/>` : '') +
    `<path d="${line}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>` +
    `<circle cx="${x(data.length - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="4" fill="${stroke}" stroke="var(--surface)" stroke-width="2"/>`;
}

function emptyBlock(title, text, action = '') {
  return `<div class="empty">
    <span class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 18l5-6 4 3.5L20 7"/><path d="M4 20h16"/></svg></span>
    <b>${esc(title)}</b><p>${esc(text)}</p>${action}</div>`;
}

/* ═══════════════════════════════════════════════════════
   Views
   ═══════════════════════════════════════════════════════ */
function renderAll() {
  $('#brandCompany').textContent = state.settings.company || 'My Company';
  $('#navCountTx').textContent = state.transactions.length;
  $('#navCountProj').textContent = state.projects.length;
  $('#navCountEmp').textContent = state.employees.length;
  $$('.cur-sym, #txCurSym').forEach((n) => (n.textContent = currencySymbol()));

  renderSidebarStat();
  renderOverview();
  renderTransactions();
  renderProjects();
  renderEmployees();
  renderCategories();
  refreshSelects();
  renderStorageHint();
}

function renderStorageHint() {
  const bytes = new Blob([JSON.stringify(state)]).size;
  $('#storageHint').textContent =
    `${state.transactions.length} entries · ${state.projects.length} projects · ${state.employees.length} employees · ${(bytes / 1024).toFixed(1)} KB stored locally.`;
}

function renderSidebarStat() {
  const t = totals(txInRange());
  $('#sideNet').textContent = fmtMoney(t.net, { compact: true });
  $('#sideNet').classList.toggle('is-negative', t.net < 0);
  const denom = t.income + t.expense;
  $('#sideBar').style.width = `${denom ? (t.income / denom) * 100 : 50}%`;
  $('#sideSub').textContent = denom
    ? `${fmtMoney(t.income, { compact: true })} in · ${fmtMoney(t.expense, { compact: true })} out`
    : 'No entries yet';
}

/* ── overview ──────────────────────────────────────────── */
function renderOverview() {
  const list = txInRange();
  const t = totals(list);

  $('#heroRangeLabel').textContent = RANGE_LABELS[ui.range];
  const hero = $('#heroNet');
  hero.textContent = fmtMoney(t.net);
  hero.classList.toggle('is-negative', t.net < 0);

  // delta vs the previous equal-length window
  const prevB = previousBounds();
  const deltaEl = $('#heroDelta');
  const iconEl = $('.delta-icon', deltaEl);
  const textEl = $('.delta-text', deltaEl);
  deltaEl.classList.remove('is-up', 'is-down');
  if (prevB) {
    const prev = totals(txInRange(prevB));
    if (prev.net === 0 && t.net === 0) {
      textEl.textContent = 'No change'; iconEl.hidden = true;
      $('#heroDeltaSub').textContent = 'vs previous period';
    } else if (prev.net === 0) {
      textEl.textContent = 'New'; iconEl.hidden = true;
      $('#heroDeltaSub').textContent = 'no prior activity';
    } else {
      const pct = ((t.net - prev.net) / Math.abs(prev.net)) * 100;
      const up = t.net >= prev.net;
      iconEl.hidden = false;
      deltaEl.classList.add(up ? 'is-up' : 'is-down');
      textEl.textContent = `${Math.abs(pct).toFixed(pct >= 100 ? 0 : 1)}%`;
      $('#heroDeltaSub').textContent = `vs ${fmtMoney(prev.net)} previous period`;
    }
  } else {
    textEl.textContent = `${list.length} entries`; iconEl.hidden = true;
    $('#heroDeltaSub').textContent = 'across all time';
  }

  $('#tileIn').textContent = fmtMoney(t.income, { compact: true });
  $('#tileOut').textContent = fmtMoney(t.expense, { compact: true });
  $('#tileInSub').textContent = `${list.filter((x) => x.type === 'income').length} entries`;
  $('#tileOutSub').textContent = `${list.filter((x) => x.type === 'expense').length} entries`;
  $('#tileMargin').textContent = t.margin === null ? '—' : `${(t.margin * 100).toFixed(1)}%`;
  $('#tileMargin').classList.toggle('is-negative', t.margin !== null && t.margin < 0);

  const roster = state.employees.filter(isActiveEmp);
  const payrollMonthly = sum(roster, monthlyCost);
  $('#tilePayroll').textContent = fmtMoney(payrollMonthly, { compact: true });
  $('#tilePayrollSub').textContent = `${roster.length} ${roster.length === 1 ? 'person' : 'people'} · per month`;

  drawSparkline();
  drawFlowChart();
  drawCategoryChart();
  renderProjectSummary(list);
  renderRecent();
}

function renderProjectSummary(list) {
  const rows = state.projects.map((p) => {
    const own = list.filter((t) => t.project === p.id);
    return { ...p, ...totals(own), count: own.length };
  }).sort((a, b) => b.net - a.net);

  const table = $('#projSummaryTable');
  if (!rows.length) {
    table.innerHTML = `<tbody><tr><td>${emptyBlock('No projects yet', 'Create a project to see profitability broken out per job.', '<button class="ghost-btn sm" data-goto="projects">Create a project</button>')}</td></tr></tbody>`;
    return;
  }
  const peak = Math.max(...rows.map((r) => Math.abs(r.net)), 1);
  table.innerHTML =
    `<thead><tr><th>Project</th><th class="num">In</th><th class="num">Out</th><th class="num">Net</th><th>Margin</th></tr></thead><tbody>` +
    rows.map((r) => {
      const pct = r.margin === null ? null : r.margin * 100;
      const w = (Math.abs(r.net) / peak) * 100;
      return `<tr>
        <td><div class="cell-main"><b>${esc(r.name)}</b>${r.client ? `<small>${esc(r.client)}</small>` : ''}</div></td>
        <td class="num">${fmtMoney(r.income, { compact: true })}</td>
        <td class="num">${fmtMoney(r.expense, { compact: true })}</td>
        <td class="num ${r.net < 0 ? 'is-negative' : ''}">${fmtMoney(r.net, { compact: true, sign: true })}</td>
        <td><div class="cat-meter"><div class="mini-bar"><i style="width:${w.toFixed(0)}%;background:${r.net < 0 ? 'var(--flow-out)' : 'var(--flow-in)'}"></i></div><small>${pct === null ? '—' : pct.toFixed(0) + '%'}</small></div></td>
      </tr>`;
    }).join('') + `</tbody>`;
}

function renderRecent() {
  const feed = $('#recentFeed');
  const rows = [...state.transactions].sort((a, b) => (b.date.localeCompare(a.date)) || b.created - a.created).slice(0, 8);
  if (!rows.length) {
    feed.innerHTML = `<li>${emptyBlock('Nothing recorded yet', 'Your most recent money movements will appear here.', '<button class="primary-btn sm" id="feedAdd">Add first entry</button>')}</li>`;
    $('#feedAdd')?.addEventListener('click', () => openTx());
    return;
  }
  feed.innerHTML = rows.map((t) => {
    const inc = t.type === 'income';
    const proj = projName(t.project);
    return `<li>
      <span class="feed-icon feed-icon--${inc ? 'in' : 'out'}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
          ${inc ? '<path d="M12 19V5M12 5l-5 5M12 5l5 5"/>' : '<path d="M12 5v14M12 19l5-5M12 19l-5-5"/>'}
        </svg>
      </span>
      <span class="feed-body">
        <b>${esc(t.description || catName(t.category))}</b>
        <small>${fmtDate(t.date)} · ${esc(catName(t.category))}${proj ? ' · ' + esc(proj) : ''}</small>
      </span>
      <span class="feed-amt ${inc ? 'amt-in' : 'amt-out'}">${inc ? '+' : '−'}${fmtMoney(Number(t.amount)).replace('−', '')}</span>
    </li>`;
  }).join('');
}

/* ── transactions ──────────────────────────────────────── */
function filteredTx() {
  const q = ui.txSearch.trim().toLowerCase();
  return txInRange().filter((t) => {
    if (ui.txType && t.type !== ui.txType) return false;
    if (ui.txCat && t.category !== ui.txCat) return false;
    if (ui.txProj && (t.project || '') !== ui.txProj) return false;
    if (!q) return true;
    return [t.description, catName(t.category), projName(t.project), t.method, t.reference]
      .filter(Boolean).some((v) => String(v).toLowerCase().includes(q));
  });
}

function renderTransactions() {
  const rows = filteredTx();
  const { key, dir } = ui.txSort;
  const val = (t) => ({
    date: t.date, amount: Number(t.amount) || 0,
    category: catName(t.category), project: projName(t.project) || '',
    description: t.description || '', method: t.method || '', type: t.type,
  }[key]);
  rows.sort((a, b) => {
    const A = val(a), B = val(b);
    const c = typeof A === 'number' ? A - B : String(A).localeCompare(String(B));
    return c * dir || (b.created || 0) - (a.created || 0);
  });

  const table = $('#txTable');
  const cols = [
    ['date', 'Date', ''], ['description', 'Description', ''], ['category', 'Category', ''],
    ['project', 'Project', ''], ['method', 'Method', ''], ['amount', 'Amount', 'num'],
  ];
  const head = `<thead><tr>${cols.map(([k, label, cls]) =>
    `<th data-sort="${k}" class="${cls} ${key === k ? 'is-sorted' : ''}">${label}<span class="caret">${dir === 1 ? '▲' : '▼'}</span></th>`
  ).join('')}<th></th></tr></thead>`;

  if (!rows.length) {
    table.innerHTML = head + `<tbody><tr><td colspan="7">${emptyBlock(
      state.transactions.length ? 'No matching entries' : 'No entries yet',
      state.transactions.length ? 'Try clearing a filter or widening the date range.' : 'Record your first money movement to get started.',
      state.transactions.length ? '' : '<button class="primary-btn sm" id="txEmptyAdd">Add an entry</button>'
    )}</td></tr></tbody>`;
    $('#txEmptyAdd')?.addEventListener('click', () => openTx());
    $('#txFoot').innerHTML = '';
    bindSort(table);
    return;
  }

  table.innerHTML = head + `<tbody>` + rows.map((t) => {
    const inc = t.type === 'income';
    const proj = projName(t.project);
    return `<tr data-id="${t.id}">
      <td style="white-space:nowrap">${fmtDate(t.date)}</td>
      <td><div class="cell-main"><b>${esc(t.description || '—')}</b>${t.reference ? `<small>${esc(t.reference)}</small>` : ''}</div></td>
      <td><span class="tag"><i style="color:${inc ? 'var(--flow-in)' : 'var(--flow-out)'}"></i>${esc(catName(t.category))}</span></td>
      <td>${proj ? `<span class="tag tag--muted">${esc(proj)}</span>` : '<span class="tag tag--muted">—</span>'}</td>
      <td style="color:var(--ink-muted)">${esc(t.method || '—')}</td>
      <td class="num ${inc ? 'amt-in' : 'amt-out'}">${inc ? '+' : '−'}${fmtMoney(Number(t.amount)).replace('−', '')}</td>
      <td><div class="row-actions">
        <button class="icon-btn" data-edit="${t.id}" aria-label="Edit entry"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg></button>
        <button class="icon-btn" data-del="${t.id}" aria-label="Delete entry"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14M10 7V5h4v2M8 7l.7 12h6.6L16 7"/></svg></button>
      </div></td>
    </tr>`;
  }).join('') + `</tbody>`;

  const t = totals(rows);
  $('#txFoot').innerHTML = `<div class="foot-stats">
      <span>${rows.length} of ${state.transactions.length} entries</span>
      <span>In <strong>${fmtMoney(t.income)}</strong></span>
      <span>Out <strong>${fmtMoney(t.expense)}</strong></span>
    </div><span>Net <strong class="${t.net < 0 ? 'is-negative' : ''}">${fmtMoney(t.net, { sign: true })}</strong></span>`;

  bindSort(table);
  $$('[data-edit]', table).forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); openTx(b.dataset.edit); }));
  $$('[data-del]', table).forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (await confirmAction('Delete this entry?', 'It will be removed from every total and chart.')) {
      state.transactions = state.transactions.filter((x) => x.id !== b.dataset.del);
      save(); renderAll(); toast('Entry deleted');
    }
  }));
}

function bindSort(table) {
  $$('th[data-sort]', table).forEach((th) => th.addEventListener('click', () => {
    const k = th.dataset.sort;
    ui.txSort = { key: k, dir: ui.txSort.key === k ? -ui.txSort.dir : (k === 'date' || k === 'amount' ? -1 : 1) };
    renderTransactions();
  }));
}

/* ── projects ──────────────────────────────────────────── */
const STATUS_CLASS = { 'Active': 'active', 'On hold': 'hold', 'Completed': 'done', 'Archived': 'off' };

function renderProjects() {
  const grid = $('#projGrid');
  const list = txInRange();
  if (!state.projects.length) {
    grid.innerHTML = `<div class="card" style="grid-column:1/-1">${emptyBlock(
      'No projects yet',
      'Group income and costs by job, client or campaign to see which ones actually make money.',
      '<button class="primary-btn sm" id="projEmptyAdd">Create a project</button>')}</div>`;
    $('#projEmptyAdd')?.addEventListener('click', () => openProj());
    return;
  }
  grid.innerHTML = state.projects.map((p) => {
    const own = list.filter((t) => t.project === p.id);
    const t = totals(own);
    const denom = t.income + t.expense || 1;
    const staff = state.employees.filter((e) => e.project === p.id && isActiveEmp(e));
    const budgetPct = p.budget ? clamp((t.expense / Number(p.budget)) * 100, 0, 100) : null;
    return `<article class="card proj-card" data-proj="${p.id}">
      <div class="proj-top">
        <div><div class="proj-name">${esc(p.name)}</div>${p.client ? `<div class="proj-client">${esc(p.client)}</div>` : ''}</div>
        <span class="status status--${STATUS_CLASS[p.status] || 'off'}"><i></i>${esc(p.status || 'Active')}</span>
      </div>
      <div>
        <div class="proj-net"><strong class="${t.net < 0 ? 'is-negative' : ''}">${fmtMoney(t.net, { compact: true, sign: true })}</strong><span>net</span></div>
        <div class="proj-split" style="margin-top:10px">
          <i style="width:${((t.income / denom) * 100).toFixed(1)}%;background:var(--flow-in)"></i>
          <i style="width:${((t.expense / denom) * 100).toFixed(1)}%;background:var(--flow-out)"></i>
        </div>
      </div>
      <div class="proj-stats">
        <div class="proj-stat"><span>Money in</span><b>${fmtMoney(t.income, { compact: true })}</b></div>
        <div class="proj-stat"><span>Money out</span><b>${fmtMoney(t.expense, { compact: true })}</b></div>
        <div class="proj-stat"><span>Margin</span><b class="${t.margin !== null && t.margin < 0 ? 'is-negative' : ''}">${t.margin === null ? '—' : (t.margin * 100).toFixed(0) + '%'}</b></div>
      </div>
      <div class="proj-stats" style="border-top:0;padding-top:0">
        <div class="proj-stat"><span>Entries</span><b>${own.length}</b></div>
        <div class="proj-stat"><span>Team</span><b>${staff.length}</b></div>
        <div class="proj-stat"><span>Budget used</span><b>${budgetPct === null ? '—' : budgetPct.toFixed(0) + '%'}</b></div>
      </div>
    </article>`;
  }).join('');
  $$('[data-proj]', grid).forEach((c) => c.addEventListener('click', () => openProj(c.dataset.proj)));
}

/* ── employees ─────────────────────────────────────────── */
function renderEmployees() {
  const active = state.employees.filter(isActiveEmp);
  const monthly = sum(active, monthlyCost);
  $('#empCount').textContent = state.employees.length;
  $('#empCountSub').textContent = `${active.length} active`;
  $('#empMonthly').textContent = fmtMoney(monthly, { compact: true });
  $('#empAnnual').textContent = fmtMoney(monthly * 12, { compact: true });

  const runs = state.payruns.filter((r) => inRange({ date: r.date }, rangeBounds()));
  $('#empPaid').textContent = fmtMoney(sum(runs, (r) => r.total), { compact: true });
  $('#empPaidSub').textContent = `${runs.length} pay ${runs.length === 1 ? 'run' : 'runs'}`;

  const table = $('#empTable');
  if (!state.employees.length) {
    table.innerHTML = `<tbody><tr><td>${emptyBlock('No employees yet', 'Add your team to track salary cost and post payroll straight to the ledger.', '<button class="primary-btn sm" id="empEmptyAdd">Add an employee</button>')}</td></tr></tbody>`;
    $('#empEmptyAdd')?.addEventListener('click', () => openEmp());
  } else {
    table.innerHTML =
      `<thead><tr><th>Name</th><th>Department</th><th>Project</th><th>Status</th><th class="num">Salary</th><th class="num">Monthly cost</th><th></th></tr></thead><tbody>` +
      state.employees.map((e) => {
        const st = e.status === 'Active' ? 'active' : e.status === 'On leave' ? 'hold' : e.status === 'Contract' ? 'done' : 'off';
        return `<tr>
          <td><div class="cell-main"><b>${esc(e.name)}</b>${e.role ? `<small>${esc(e.role)}</small>` : ''}</div></td>
          <td style="color:var(--ink-2)">${esc(e.department || '—')}</td>
          <td>${e.project && projName(e.project) ? `<span class="tag tag--muted">${esc(projName(e.project))}</span>` : '<span class="tag tag--muted">Company-wide</span>'}</td>
          <td><span class="status status--${st}"><i></i>${esc(e.status || 'Active')}</span></td>
          <td class="num">${fmtMoney(Number(e.salary) || 0)}<small style="color:var(--ink-muted)">${FREQ_LABEL[e.frequency] || ''}</small></td>
          <td class="num">${fmtMoney(monthlyCost(e))}</td>
          <td><div class="row-actions">
            <button class="icon-btn" data-eedit="${e.id}" aria-label="Edit employee"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg></button>
            <button class="icon-btn" data-edel="${e.id}" aria-label="Remove employee"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14M10 7V5h4v2M8 7l.7 12h6.6L16 7"/></svg></button>
          </div></td>
        </tr>`;
      }).join('') + `</tbody>`;

    $$('[data-eedit]', table).forEach((b) => b.addEventListener('click', () => openEmp(b.dataset.eedit)));
    $$('[data-edel]', table).forEach((b) => b.addEventListener('click', async () => {
      const emp = state.employees.find((x) => x.id === b.dataset.edel);
      if (await confirmAction(`Remove ${emp?.name || 'this employee'}?`, 'Salary expenses already posted to the ledger stay put.')) {
        state.employees = state.employees.filter((x) => x.id !== b.dataset.edel);
        save(); renderAll(); toast('Employee removed');
      }
    }));
  }

  const pt = $('#payrollTable');
  const allRuns = [...state.payruns].sort((a, b) => b.date.localeCompare(a.date));
  if (!allRuns.length) {
    pt.innerHTML = `<tbody><tr><td>${emptyBlock('No pay runs yet', 'Running payroll posts one salary expense per person, tagged to their project.')}</td></tr></tbody>`;
  } else {
    pt.innerHTML =
      `<thead><tr><th>Pay date</th><th>Period</th><th class="num">People</th><th class="num">Total</th><th></th></tr></thead><tbody>` +
      allRuns.map((r) => `<tr>
        <td style="white-space:nowrap">${fmtDate(r.date)}</td>
        <td style="color:var(--ink-2)">${esc(r.period || 'Monthly')}</td>
        <td class="num">${r.count}</td>
        <td class="num amt-out">−${fmtMoney(r.total).replace('−', '')}</td>
        <td><div class="row-actions"><button class="icon-btn" data-rdel="${r.id}" aria-label="Reverse pay run"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7h14M10 7V5h4v2M8 7l.7 12h6.6L16 7"/></svg></button></div></td>
      </tr>`).join('') + `</tbody>`;

    $$('[data-rdel]', pt).forEach((b) => b.addEventListener('click', async () => {
      if (await confirmAction('Reverse this pay run?', 'Every salary expense it created will be deleted too.')) {
        const id = b.dataset.rdel;
        state.transactions = state.transactions.filter((t) => t.payrun !== id);
        state.payruns = state.payruns.filter((r) => r.id !== id);
        save(); renderAll(); toast('Pay run reversed');
      }
    }));
  }
}

/* ── categories ────────────────────────────────────────── */
function renderCategories() {
  const list = txInRange();
  ['income', 'expense'].forEach((type) => {
    const host = $(type === 'income' ? '#catListIncome' : '#catListExpense');
    const cats = state.categories.filter((c) => c.type === type);
    if (!cats.length) {
      host.innerHTML = `<li>${emptyBlock('No categories', `Add a ${type === 'income' ? 'revenue' : 'cost'} category to start tagging entries.`)}</li>`;
      return;
    }
    const withTotals = cats.map((c) => ({
      ...c, total: sum(list.filter((t) => t.category === c.id), (t) => Number(t.amount) || 0),
      count: list.filter((t) => t.category === c.id).length,
    })).sort((a, b) => b.total - a.total);
    const peak = Math.max(...withTotals.map((c) => c.total), 1);
    const grand = sum(withTotals, (c) => c.total);

    host.innerHTML = withTotals.map((c) => `<li>
      <div class="cat-info">
        <b>${esc(c.name)}</b>
        <div class="cat-meter">
          <div class="mini-bar"><i style="width:${((c.total / peak) * 100).toFixed(0)}%;background:${type === 'income' ? 'var(--flow-in)' : 'var(--flow-out)'}"></i></div>
          <small>${c.count} ${c.count === 1 ? 'entry' : 'entries'}${grand ? ' · ' + ((c.total / grand) * 100).toFixed(0) + '%' : ''}</small>
        </div>
      </div>
      <span class="cat-amt">${fmtMoney(c.total, { compact: true })}</span>
      <div class="row-actions">
        <button class="icon-btn" data-cedit="${c.id}" aria-label="Edit category"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg></button>
      </div>
    </li>`).join('');

    $$('[data-cedit]', host).forEach((b) => b.addEventListener('click', () => openCat(b.dataset.cedit)));
  });
}

/* ── shared selects ────────────────────────────────────── */
function refreshSelects() {
  const catOpts = (type) => state.categories.filter((c) => c.type === type)
    .map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  const projOpts = state.projects.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');

  const keepValue = (sel, html) => { const v = sel.value; sel.innerHTML = html; sel.value = v; };

  keepValue($('#txCatFilter'), `<option value="">All categories</option>` +
    `<optgroup label="Money in">${catOpts('income')}</optgroup><optgroup label="Money out">${catOpts('expense')}</optgroup>`);
  keepValue($('#txProjFilter'), `<option value="">All projects</option>${projOpts}`);
  keepValue($('#txProject'), `<option value="">— No project —</option>${projOpts}`);
  keepValue($('#empProject'), `<option value="">— Company-wide —</option>${projOpts}`);
}

function fillTxCategories(type, selected) {
  const sel = $('#txCategory');
  sel.innerHTML = state.categories.filter((c) => c.type === type)
    .map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  if (selected && sel.querySelector(`option[value="${selected}"]`)) sel.value = selected;
}

/* ═══════════════════════════════════════════════════════
   Modals / CRUD
   ═══════════════════════════════════════════════════════ */
let editingTx = null, editingProj = null, editingEmp = null, editingCat = null;

function openTx(id) {
  const form = $('#txForm');
  form.reset();
  editingTx = id ? state.transactions.find((t) => t.id === id) : null;
  $('#txModalTitle').textContent = editingTx ? 'Edit entry' : 'New entry';
  $('#txDelete').hidden = !editingTx;
  refreshSelects();

  // NB: read fields off form.elements — `form.name`/`form.method` are native
  // HTMLFormElement properties and would shadow the inputs of the same name.
  const el = form.elements;
  const type = editingTx?.type || 'income';
  form.querySelector(`input[name="type"][value="${type}"]`).checked = true;
  fillTxCategories(type, editingTx?.category);
  el.date.value = editingTx?.date || todayISO();
  if (editingTx) {
    el.amount.value = editingTx.amount;
    el.description.value = editingTx.description || '';
    el.method.value = editingTx.method || 'Bank transfer';
    el.reference.value = editingTx.reference || '';
    $('#txProject').value = editingTx.project || '';
  }
  $('#txModal').showModal();
  setTimeout(() => el.amount.focus(), 50);
}

$('#txForm').addEventListener('submit', (e) => {
  const f = e.target.elements;
  const amount = Math.abs(Number(f.amount.value) || 0);
  if (!amount) { e.preventDefault(); toast('Enter an amount above zero', 'warn'); return; }
  const rec = {
    id: editingTx?.id || uid(),
    created: editingTx?.created || Date.now(),
    type: f.type.value,
    amount,
    date: f.date.value || todayISO(),
    category: f.category.value,
    project: $('#txProject').value || '',
    description: f.description.value.trim(),
    method: f.method.value,
    reference: f.reference.value.trim(),
  };
  if (editingTx) state.transactions = state.transactions.map((t) => (t.id === rec.id ? { ...t, ...rec } : t));
  else state.transactions.push(rec);
  save(); renderAll();
  toast(editingTx ? 'Entry updated' : `${rec.type === 'income' ? 'Money in' : 'Money out'} recorded`);
});

$$('#txForm input[name="type"]').forEach((r) => r.addEventListener('change', () => fillTxCategories(r.value)));

$('#txDelete').addEventListener('click', async () => {
  if (!editingTx) return;
  if (await confirmAction('Delete this entry?', 'It will be removed from every total and chart.')) {
    state.transactions = state.transactions.filter((t) => t.id !== editingTx.id);
    save(); renderAll(); $('#txModal').close(); toast('Entry deleted');
  }
});

/* projects */
function openProj(id) {
  const form = $('#projForm');
  form.reset();
  editingProj = id ? projById(id) : null;
  $('#projModalTitle').textContent = editingProj ? 'Edit project' : 'New project';
  $('#projDelete').hidden = !editingProj;
  const el = form.elements;
  if (editingProj) {
    el.name.value = editingProj.name;
    el.client.value = editingProj.client || '';
    el.status.value = editingProj.status || 'Active';
    el.budget.value = editingProj.budget || '';
    el.startDate.value = editingProj.startDate || '';
  } else el.startDate.value = todayISO();
  $('#projModal').showModal();
}

$('#projForm').addEventListener('submit', (e) => {
  const f = e.target.elements;
  const rec = {
    id: editingProj?.id || uid(),
    name: f.name.value.trim(), client: f.client.value.trim(),
    status: f.status.value, budget: Number(f.budget.value) || 0, startDate: f.startDate.value,
  };
  if (!rec.name) { e.preventDefault(); toast('Give the project a name', 'warn'); return; }
  if (editingProj) state.projects = state.projects.map((p) => (p.id === rec.id ? rec : p));
  else state.projects.push(rec);
  save(); renderAll(); toast(editingProj ? 'Project updated' : 'Project created');
});

$('#projDelete').addEventListener('click', async () => {
  if (!editingProj) return;
  const n = state.transactions.filter((t) => t.project === editingProj.id).length;
  if (await confirmAction(`Delete ${editingProj.name}?`, n ? `${n} entries will keep their amounts but lose the project tag.` : 'This project has no entries yet.')) {
    state.projects = state.projects.filter((p) => p.id !== editingProj.id);
    state.transactions = state.transactions.map((t) => (t.project === editingProj.id ? { ...t, project: '' } : t));
    state.employees = state.employees.map((e2) => (e2.project === editingProj.id ? { ...e2, project: '' } : e2));
    save(); renderAll(); $('#projModal').close(); toast('Project deleted');
  }
});

/* employees */
function openEmp(id) {
  const form = $('#empForm');
  form.reset();
  editingEmp = id ? state.employees.find((e) => e.id === id) : null;
  $('#empModalTitle').textContent = editingEmp ? 'Edit employee' : 'Add employee';
  $('#empDelete').hidden = !editingEmp;
  refreshSelects();
  const el = form.elements;
  if (editingEmp) {
    el.name.value = editingEmp.name;
    el.role.value = editingEmp.role || '';
    el.department.value = editingEmp.department || 'Engineering';
    el.status.value = editingEmp.status || 'Active';
    el.salary.value = editingEmp.salary || '';
    el.frequency.value = editingEmp.frequency || 'monthly';
    el.startDate.value = editingEmp.startDate || '';
    $('#empProject').value = editingEmp.project || '';
  } else el.startDate.value = todayISO();
  updateEmpHint();
  $('#empModal').showModal();
}

function updateEmpHint() {
  const f = $('#empForm').elements;
  const m = (Number(f.salary.value) || 0) * (FREQ_TO_MONTHLY[f.frequency.value] ?? 1);
  $('#empCostHint').textContent = m
    ? `Costs ${fmtMoney(m)} per month · ${fmtMoney(m * 12)} per year${f.frequency.value === 'hourly' ? ' (assuming 160 hours a month)' : ''}.`
    : 'Enter a salary to see the monthly and annual cost.';
}
['input', 'change'].forEach((ev) => $('#empForm').addEventListener(ev, updateEmpHint));

$('#empForm').addEventListener('submit', (e) => {
  const f = e.target.elements;
  const rec = {
    id: editingEmp?.id || uid(),
    name: f.name.value.trim(), role: f.role.value.trim(),
    department: f.department.value, status: f.status.value,
    salary: Number(f.salary.value) || 0, frequency: f.frequency.value,
    project: $('#empProject').value || '', startDate: f.startDate.value,
  };
  if (!rec.name) { e.preventDefault(); toast('Enter the employee name', 'warn'); return; }
  if (editingEmp) state.employees = state.employees.map((x) => (x.id === rec.id ? rec : x));
  else state.employees.push(rec);
  save(); renderAll(); toast(editingEmp ? 'Employee updated' : `${rec.name} added to the roster`);
});

$('#empDelete').addEventListener('click', async () => {
  if (!editingEmp) return;
  if (await confirmAction(`Remove ${editingEmp.name}?`, 'Salary expenses already posted to the ledger stay put.')) {
    state.employees = state.employees.filter((x) => x.id !== editingEmp.id);
    save(); renderAll(); $('#empModal').close(); toast('Employee removed');
  }
});

/* categories */
function openCat(id) {
  const form = $('#catForm');
  form.reset();
  editingCat = id ? catById(id) : null;
  $('#catModalTitle').textContent = editingCat ? 'Edit category' : 'New category';
  $('#catDelete').hidden = !editingCat;
  if (editingCat) { form.elements.name.value = editingCat.name; form.elements.type.value = editingCat.type; }
  $('#catModal').showModal();
}

$('#catForm').addEventListener('submit', (e) => {
  const f = e.target.elements;
  const name = f.name.value.trim();
  if (!name) { e.preventDefault(); toast('Give the category a name', 'warn'); return; }
  if (editingCat) state.categories = state.categories.map((c) => (c.id === editingCat.id ? { ...c, name, type: f.type.value } : c));
  else state.categories.push({ id: uid(), name, type: f.type.value });
  save(); renderAll(); toast(editingCat ? 'Category updated' : 'Category added');
});

$('#catDelete').addEventListener('click', async () => {
  if (!editingCat) return;
  const n = state.transactions.filter((t) => t.category === editingCat.id).length;
  if (await confirmAction(`Delete "${editingCat.name}"?`, n ? `${n} entries will show as Uncategorised.` : 'No entries use this category.')) {
    state.categories = state.categories.filter((c) => c.id !== editingCat.id);
    save(); renderAll(); $('#catModal').close(); toast('Category deleted');
  }
});

/* payroll */
const PERIOD_FACTOR = { monthly: 1, biweekly: 12 / 26, weekly: 12 / 52 };
const PERIOD_LABEL = { monthly: 'Monthly', biweekly: 'Two weeks', weekly: 'Weekly' };

function openPayroll() {
  const roster = state.employees.filter((e) => e.status === 'Active' || e.status === 'Contract');
  if (!roster.length) { toast('Add an active employee first', 'warn'); return; }
  const form = $('#payrollForm');
  form.elements.date.value = todayISO();
  form.elements.period.value = 'monthly';
  $('#payrollList').innerHTML = roster.map((e) => `<li>
    <input type="checkbox" data-pay="${e.id}" checked>
    <div class="cell-main"><b>${esc(e.name)}</b><small>${esc(e.role || e.department || '')}${e.project && projName(e.project) ? ' · ' + esc(projName(e.project)) : ''}</small></div>
    <span class="num" data-amt="${e.id}"></span>
  </li>`).join('');
  updatePayrollTotal();
  $('#payrollModal').showModal();
}

function updatePayrollTotal() {
  const factor = PERIOD_FACTOR[$('#payrollForm').elements.period.value] ?? 1;
  let total = 0;
  $$('#payrollList [data-pay]').forEach((cb) => {
    const emp = state.employees.find((e) => e.id === cb.dataset.pay);
    if (!emp) return;
    const amt = monthlyCost(emp) * factor;
    $(`[data-amt="${emp.id}"]`).textContent = fmtMoney(amt);
    if (cb.checked) total += amt;
  });
  $('#payrollTotal').textContent = fmtMoney(total);
}
['change', 'input'].forEach((ev) => $('#payrollForm').addEventListener(ev, updatePayrollTotal));

$('#payrollForm').addEventListener('submit', (e) => {
  const f = e.target.elements;
  const factor = PERIOD_FACTOR[f.period.value] ?? 1;
  const picked = $$('#payrollList [data-pay]').filter((cb) => cb.checked).map((cb) => cb.dataset.pay);
  if (!picked.length) { e.preventDefault(); toast('Select at least one person', 'warn'); return; }

  let salaryCat = state.categories.find((c) => c.type === 'expense' && /salar/i.test(c.name));
  if (!salaryCat) { salaryCat = { id: uid(), name: 'Salaries & wages', type: 'expense' }; state.categories.push(salaryCat); }

  const runId = uid();
  const date = f.date.value || todayISO();
  let total = 0;
  picked.forEach((id) => {
    const emp = state.employees.find((x) => x.id === id);
    if (!emp) return;
    const amount = Math.round(monthlyCost(emp) * factor * 100) / 100;
    total += amount;
    state.transactions.push({
      id: uid(), created: Date.now(), type: 'expense', amount, date,
      category: salaryCat.id, project: emp.project || '',
      description: `Salary — ${emp.name}`, method: 'Bank transfer',
      reference: `Payroll ${PERIOD_LABEL[f.period.value]}`, payrun: runId, employee: emp.id,
    });
  });
  state.payruns.push({ id: runId, date, period: PERIOD_LABEL[f.period.value], count: picked.length, total });
  save(); renderAll();
  toast(`Payroll posted — ${fmtMoney(total)} across ${picked.length} ${picked.length === 1 ? 'person' : 'people'}`);
});

/* confirm dialog as a promise */
let confirmResolve = null;
function confirmAction(title, text) {
  $('#confirmTitle').textContent = title;
  $('#confirmText').textContent = text;
  $('#confirmModal').showModal();
  return new Promise((res) => { confirmResolve = res; });
}
$('#confirmOk').addEventListener('click', () => { $('#confirmModal').close(); confirmResolve?.(true); confirmResolve = null; });
$('#confirmModal').addEventListener('close', () => { confirmResolve?.(false); confirmResolve = null; });

/* ═══════════════════════════════════════════════════════
   Import / export
   ═══════════════════════════════════════════════════════ */
const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function download(name, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ledgerCsv(rows) {
  const head = ['Date', 'Direction', 'Category', 'Project', 'Description', 'Method', 'Reference', 'Amount', 'Currency'];
  const body = rows.map((t) => [
    t.date, t.type === 'income' ? 'Money in' : 'Money out',
    catName(t.category), projName(t.project) || '', t.description || '',
    t.method || '', t.reference || '',
    (t.type === 'income' ? 1 : -1) * (Number(t.amount) || 0),
    state.settings.currency,
  ].map(csvCell).join(','));
  return [head.join(','), ...body].join('\n');
}

/* ═══════════════════════════════════════════════════════
   Sample data
   ═══════════════════════════════════════════════════════ */
function seedDemo() {
  const s = blankState();
  s.settings = { company: 'Northgate Studio', currency: state.settings.currency || 'USD' };
  const cat = (name) => s.categories.find((c) => c.name === name).id;

  s.projects = [
    { id: uid(), name: 'Meridian Rebrand',   client: 'Meridian Foods',  status: 'Active',    budget: 180000, startDate: '2025-11-04' },
    { id: uid(), name: 'Atlas Mobile App',   client: 'Atlas Logistics', status: 'Active',    budget: 320000, startDate: '2026-01-12' },
    { id: uid(), name: 'Harbor Retainer',    client: 'Harbor Group',    status: 'Active',    budget: 96000,  startDate: '2025-09-01' },
    { id: uid(), name: 'Vela Site Refresh',  client: 'Vela Cosmetics',  status: 'Completed', budget: 74000,  startDate: '2025-08-15' },
  ];
  const P = s.projects.map((p) => p.id);

  s.employees = [
    { id: uid(), name: 'Jordan Reyes',   role: 'Engineering Lead',   department: 'Engineering', status: 'Active',   salary: 11500, frequency: 'monthly', project: P[1], startDate: '2024-03-11' },
    { id: uid(), name: 'Priya Nandakumar', role: 'Senior Designer',  department: 'Engineering', status: 'Active',   salary: 9200,  frequency: 'monthly', project: P[0], startDate: '2024-07-22' },
    { id: uid(), name: 'Marcus Bell',    role: 'Account Director',   department: 'Sales',       status: 'Active',   salary: 128000, frequency: 'annual', project: '',   startDate: '2023-11-06' },
    { id: uid(), name: 'Sofia Lindqvist', role: 'Frontend Engineer', department: 'Engineering', status: 'Active',   salary: 8400,  frequency: 'monthly', project: P[1], startDate: '2025-02-17' },
    { id: uid(), name: 'Dev Kapoor',     role: 'Growth Marketer',    department: 'Marketing',   status: 'Active',   salary: 7100,  frequency: 'monthly', project: '',   startDate: '2025-05-05' },
    { id: uid(), name: 'Elena Moreau',   role: 'Finance Manager',    department: 'Finance',     status: 'Active',   salary: 8800,  frequency: 'monthly', project: '',   startDate: '2024-01-15' },
    { id: uid(), name: 'Tomas Vidal',    role: 'QA Contractor',      department: 'Engineering', status: 'Contract', salary: 78,    frequency: 'hourly',  project: P[1], startDate: '2026-02-02' },
  ];

  // 14 months of plausible activity
  const now = new Date();
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const push = (o) => s.transactions.push({ id: uid(), created: Date.now() - Math.random() * 1e7, method: 'Bank transfer', reference: '', ...o });

  for (let back = 13; back >= 0; back--) {
    const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const day = (n) => `${ym}-${String(n).padStart(2, '0')}`;
    const growth = 1 + (13 - back) * 0.035;

    push({ type: 'income', date: day(4),  amount: Math.round(rand(26000, 40000) * growth), category: cat('Retainers'),      project: P[2], description: 'Harbor Group — monthly retainer' });
    push({ type: 'income', date: day(12), amount: Math.round(rand(38000, 72000) * growth), category: cat('Client revenue'), project: pick([P[0], P[1]]), description: `Invoice ${1200 + back * 3}` });
    if (back % 2 === 0) push({ type: 'income', date: day(21), amount: Math.round(rand(18000, 46000) * growth), category: cat('Client revenue'), project: pick([P[0], P[1], P[3]]), description: `Invoice ${1350 + back * 3} — milestone` });
    if (back % 3 === 0) push({ type: 'income', date: day(26), amount: Math.round(rand(4000, 12000)), category: cat('Product sales'), project: '', description: 'Template pack sales' });
    push({ type: 'income', date: day(28), amount: Math.round(rand(200, 900)), category: cat('Interest & other'), project: '', description: 'Deposit interest' });

    const payroll = Math.round(sum(s.employees.filter((e) => e.frequency !== 'hourly'), monthlyCost));
    push({ type: 'expense', date: day(28), amount: payroll, category: cat('Salaries & wages'), project: '', description: 'Monthly payroll', reference: 'Payroll Monthly' });
    push({ type: 'expense', date: day(15), amount: Math.round(rand(6000, 14000)), category: cat('Contractors'),       project: pick(P), description: 'Contract engineering' });
    push({ type: 'expense', date: day(2),  amount: Math.round(rand(1800, 3200)),  category: cat('Software & tools'),  project: '', description: 'SaaS subscriptions' });
    push({ type: 'expense', date: day(9),  amount: Math.round(rand(4500, 16000) * growth), category: cat('Marketing & ads'), project: pick([P[0], P[1]]), description: 'Paid acquisition' });
    push({ type: 'expense', date: day(1),  amount: 7400, category: cat('Rent & utilities'), project: '', description: 'Studio rent & utilities' });
    if (back % 4 === 1) push({ type: 'expense', date: day(18), amount: Math.round(rand(2200, 6800)), category: cat('Travel'), project: pick(P), description: 'Client visit & travel' });
    if (back % 5 === 2) push({ type: 'expense', date: day(20), amount: Math.round(rand(3000, 11000)), category: cat('Equipment'), project: '', description: 'Hardware refresh' });
    if (back % 3 === 1) push({ type: 'expense', date: day(23), amount: Math.round(rand(1500, 4200)), category: cat('Professional fees'), project: '', description: 'Legal & accounting' });
    if (d.getMonth() % 3 === 0) push({ type: 'expense', date: day(24), amount: Math.round(rand(9000, 22000)), category: cat('Taxes'), project: '', description: 'Quarterly tax provision' });
  }

  state = s;
  save();
}

/* ═══════════════════════════════════════════════════════
   Chrome: nav, theme, toasts, wiring
   ═══════════════════════════════════════════════════════ */
const VIEW_META = {
  overview:     ['Overview',     'Every dollar in and out, at a glance'],
  transactions: ['Transactions', 'The full ledger of money movements'],
  projects:     ['Projects',     'Profitability broken out per job'],
  employees:    ['Employees',    'Roster, salary cost and payroll'],
  categories:   ['Categories',   'How money is labelled on the way in and out'],
  settings:     ['Settings',     'Company details, backups and data'],
};

function setView(name) {
  ui.view = name;
  $$('.nav-item').forEach((b) => b.classList.toggle('is-active', b.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('is-active', v.dataset.view === name));
  const [title, sub] = VIEW_META[name] || VIEW_META.overview;
  $('#viewTitle').textContent = title;
  $('#viewSub').textContent = sub;
  $('#rangeWrap').style.display = name === 'settings' || name === 'categories' ? 'none' : '';
  closeSidebar();
  window.scrollTo({ top: 0, behavior: 'instant' });
  if (name === 'overview') requestAnimationFrame(() => { drawFlowChart(); drawCategoryChart(); drawSparkline(); });
}

$$('.nav-item').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
document.addEventListener('click', (e) => {
  const goto = e.target.closest('[data-goto]');
  if (goto) setView(goto.dataset.goto);
});

/* theme */
function applyTheme(mode) {
  if (mode === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', mode);
  localStorage.setItem(THEME_KEY, mode);
  if (ui.view === 'overview') requestAnimationFrame(() => { drawFlowChart(); drawCategoryChart(); drawSparkline(); });
}
$('#themeToggle').addEventListener('click', () => {
  const current = localStorage.getItem(THEME_KEY) || 'system';
  const prefersDark = matchMedia('(prefers-color-scheme: dark)').matches;
  const isDark = current === 'dark' || (current === 'system' && prefersDark);
  applyTheme(isDark ? 'light' : 'dark');
});
applyTheme(localStorage.getItem(THEME_KEY) || 'system');

/* sidebar (mobile) */
const openSidebar = () => { $('#sidebar').classList.add('is-open'); $('#scrim').classList.add('is-on'); };
const closeSidebar = () => { $('#sidebar').classList.remove('is-open'); $('#scrim').classList.remove('is-on'); };
$('#menuBtn').addEventListener('click', openSidebar);
$('#scrim').addEventListener('click', closeSidebar);

/* toasts */
function toast(msg, kind = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${kind === 'warn' ? 'is-warn' : kind === 'bad' ? 'is-bad' : ''}`;
  el.innerHTML = `<i></i><span>${esc(msg)}</span>`;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.classList.add('is-out'); setTimeout(() => el.remove(), 220); }, 2800);
}

/* modal close buttons */
$$('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

/* toolbar wiring */
$('#addTxBtn').addEventListener('click', () => openTx());
$('#addProjBtn').addEventListener('click', () => openProj());
$('#addEmpBtn').addEventListener('click', () => openEmp());
$('#addCatBtn').addEventListener('click', () => openCat());
$('#runPayrollBtn').addEventListener('click', openPayroll);

$('#rangeSelect').addEventListener('change', (e) => { ui.range = e.target.value; renderAll(); });
$('#txSearch').addEventListener('input', (e) => { ui.txSearch = e.target.value; renderTransactions(); });
$('#txTypeFilter').addEventListener('change', (e) => { ui.txType = e.target.value; renderTransactions(); });
$('#txCatFilter').addEventListener('change', (e) => { ui.txCat = e.target.value; renderTransactions(); });
$('#txProjFilter').addEventListener('change', (e) => { ui.txProj = e.target.value; renderTransactions(); });
$('#txExport').addEventListener('click', () => {
  const rows = filteredTx();
  if (!rows.length) return toast('Nothing to export', 'warn');
  download(`ledger-${todayISO()}.csv`, ledgerCsv(rows), 'text/csv');
  toast(`Exported ${rows.length} entries`);
});

$$('#breakdownSeg .seg-btn').forEach((b) => b.addEventListener('click', () => {
  ui.breakdownDir = b.dataset.dir;
  $$('#breakdownSeg .seg-btn').forEach((x) => { x.classList.toggle('is-on', x === b); x.setAttribute('aria-selected', x === b); });
  drawCategoryChart();
}));

/* settings */
$('#setCompany').addEventListener('input', (e) => { state.settings.company = e.target.value; save(); $('#brandCompany').textContent = e.target.value || 'My Company'; });
$('#setCurrency').addEventListener('change', (e) => { state.settings.currency = e.target.value; save(); renderAll(); });

$('#exportJson').addEventListener('click', () => {
  download(`pl-dashboard-backup-${todayISO()}.json`, JSON.stringify(state, null, 2), 'application/json');
  toast('Backup downloaded');
});
$('#exportAllCsv').addEventListener('click', () => {
  if (!state.transactions.length) return toast('Nothing to export', 'warn');
  download(`ledger-full-${todayISO()}.csv`, ledgerCsv([...state.transactions].sort((a, b) => a.date.localeCompare(b.date))), 'text/csv');
  toast('Ledger exported');
});
$('#importJson').addEventListener('click', () => $('#importFile').click());
$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    if (!Array.isArray(parsed.transactions)) throw new Error('bad shape');
    if (await confirmAction('Restore this backup?', 'It replaces everything currently in the dashboard.')) {
      state = { ...blankState(), ...parsed, settings: { ...blankState().settings, ...(parsed.settings || {}) } };
      save(); hydrateSettings(); renderAll(); toast('Backup restored');
    }
  } catch { toast('That file is not a valid backup', 'bad'); }
  e.target.value = '';
});
$('#loadDemo').addEventListener('click', async () => {
  if (await confirmAction('Load sample data?', 'This replaces anything currently in the dashboard.')) {
    seedDemo(); hydrateSettings(); renderAll(); setView('overview'); toast('Sample company loaded');
  }
});
$('#wipeData').addEventListener('click', async () => {
  if (await confirmAction('Erase everything?', 'Every entry, project and employee will be permanently deleted.')) {
    state = blankState(); save(); hydrateSettings(); renderAll(); setView('overview'); toast('All data erased');
  }
});

function hydrateSettings() {
  $('#setCompany').value = state.settings.company || '';
  $('#setCurrency').value = state.settings.currency || 'USD';
  renderStorageHint();
}

/* keyboard shortcuts */
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  if (e.key === 'n' && !e.metaKey && !e.ctrlKey && !document.querySelector('dialog[open]')) { e.preventDefault(); openTx(); }
  if (e.key === '/' && !document.querySelector('dialog[open]')) { e.preventDefault(); setView('transactions'); $('#txSearch').focus(); }
});

/* redraw charts on resize */
let resizeTimer;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (ui.view === 'overview') { drawFlowChart(); drawCategoryChart(); } }, 120);
}).observe($('#content'));
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (ui.view === 'overview') { drawFlowChart(); drawCategoryChart(); drawSparkline(); }
});

/* ── boot ──────────────────────────────────────────────── */
if (!state.transactions.length && !state.employees.length && !state.projects.length
    && !localStorage.getItem(STORE_KEY)) {
  seedDemo();           // first visit: show the dashboard with a worked example
}
hydrateSettings();
renderAll();
setView('overview');
