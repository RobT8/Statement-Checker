/* Statement Check — UI. Everything is stored in this browser's localStorage. */
(function () {
  'use strict';

  const SC = window.SC;
  const CAT = window.CAT;
  const KEY = 'statement-check.v1';
  const $ = (sel, el) => (el || document).querySelector(sel);
  const view = $('#view');
  const fileInput = $('#file-input');

  // ------------------------------------------------------------- state ----

  let db = { imports: [], txns: [], dismissed: {}, settings: { currency: 'GBP' }, cats: CAT.freshState() };
  let result = null;
  let cats = new Map(); // txn id -> { cat, source, confidence }
  let tab = 'alerts';
  const ui = { sev: 'all', showDismissed: false, q: '', txFilter: 'all', cat: '', txLimit: 300, chartTable: false };

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) db = Object.assign(db, JSON.parse(raw));
      if (!db.cats || !Array.isArray(db.cats.list)) db.cats = CAT.freshState();
    } catch { /* private mode or blocked storage: start empty */ }
    try { const t = localStorage.getItem(KEY + '.tab'); if (t) tab = t; } catch { /* ignore */ }
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(db));
      return true;
    } catch {
      toast("Couldn't save on this device — storage may be full or blocked.");
      return false;
    }
  }

  function reanalyse() {
    result = SC.analyse(db.txns, { format: money, formatDate: niceDate });
    recategorise();
    const n = visibleAlerts().length;
    const badge = $('#alert-badge');
    badge.hidden = !n;
    badge.textContent = n > 99 ? '99+' : n;
  }

  function recategorise() {
    cats = CAT.categorise(db.txns, db.cats);
  }

  // ----------------------------------------------------------- helpers ----

  let moneyFmt = null;
  function money(n, signed) {
    if (!moneyFmt || moneyFmt.cur !== db.settings.currency) {
      moneyFmt = new Intl.NumberFormat('en-GB', { style: 'currency', currency: db.settings.currency });
      moneyFmt.cur = db.settings.currency;
    }
    const s = moneyFmt.format(Math.abs(n));
    if (!signed) return s;
    return n < 0 ? '−' + s : '+' + s;
  }

  function whole(n, signed) {
    const s = new Intl.NumberFormat('en-GB', { style: 'currency', currency: db.settings.currency, maximumFractionDigits: 0 }).format(Math.abs(n));
    return signed ? (n < 0 ? '−' : '+') + s : s;
  }

  function compact(n) {
    const a = Math.abs(n);
    const sym = money(0).replace(/[\d.,\s]/g, '');
    if (a >= 1e6) return sym + (a / 1e6).toFixed(1) + 'm';
    if (a >= 1e4) return sym + Math.round(a / 1e3) + 'k';
    if (a >= 1e3) return sym + (a / 1e3).toFixed(1) + 'k';
    return sym + Math.round(a);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function niceDate(iso, withYear) {
    const d = new Date(iso + 'T00:00:00Z');
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: withYear === false ? undefined : 'numeric', timeZone: 'UTC' });
  }

  function toast(msg) {
    const old = $('.toast');
    if (old) old.remove();
    const t = document.createElement('div');
    t.className = 'toast';
    t.setAttribute('role', 'status');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3500);
  }

  const SEV_RANK = { high: 3, medium: 2, low: 1 };
  const SEV_LABEL = { high: 'High', medium: 'Medium', low: 'Low' };
  const sevTag = (s) => `<span class="sev ${s}"><i aria-hidden="true"></i>${SEV_LABEL[s]}</span>`;

  // An alert = a flagged transaction (with its reasons) or an account-level pattern.
  function allAlerts() {
    if (!result) return [];
    const out = [];
    for (const f of result.flags) {
      const live = f.reasons.filter((r) => !db.dismissed[r.key]);
      const reasons = ui.showDismissed ? f.reasons : live;
      if (!reasons.length) continue;
      const severity = reasons.reduce((s, r) => (SEV_RANK[r.severity] > SEV_RANK[s] ? r.severity : s), 'low');
      out.push({ kind: 'txn', id: f.txn.id, txn: f.txn, reasons, severity, dismissed: !live.length, date: f.txn.date });
    }
    for (const p of result.patterns) {
      const dismissed = !!db.dismissed[p.id];
      if (dismissed && !ui.showDismissed) continue;
      out.push({ kind: 'pattern', id: p.id, pattern: p, severity: p.severity, dismissed, date: result.stats.dataEnd });
    }
    return out.sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || (a.date < b.date ? 1 : -1));
  }

  function visibleAlerts() {
    return allAlerts().filter((a) => !a.dismissed);
  }

  function dismissedCount() {
    if (!result) return 0;
    return result.flags.filter((f) => f.reasons.every((r) => db.dismissed[r.key])).length +
      result.patterns.filter((p) => db.dismissed[p.id]).length;
  }

  // ----------------------------------------------------------- routing ----

  function go(t) {
    tab = t;
    try { localStorage.setItem(KEY + '.tab', t); } catch { /* ignore */ }
    render();
    window.scrollTo(0, 0);
  }

  function render() {
    document.querySelectorAll('nav.tabs button').forEach((b) => {
      if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    if (!db.txns.length && tab !== 'files') {
      view.innerHTML = welcome();
      return;
    }
    view.innerHTML = ({ alerts: renderAlerts, transactions: renderTransactions, insights: renderInsights, files: renderFiles })[tab]();
    if (tab === 'insights') wireChart();
  }

  // ----------------------------------------------------------- screens ----

  const UPLOAD_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M12 18v-6M9 15l3-3 3 3"/></svg>';

  function dropZone() {
    return `<div class="drop" id="drop">
      ${UPLOAD_ICON}
      <p style="margin:8px 0 14px"><b>Load a bank statement</b><br><span class="muted small">CSV, OFX, QFX or QIF — exported from your banking app or website</span></p>
      <button class="btn primary" data-act="pick">Choose file</button>
    </div>`;
  }

  function welcome() {
    return `<h2>Spot anything odd in your bank statements</h2>
      <p class="sub">Load a statement and Statement Check looks for duplicate charges, price rises, unusually large payments, card-testing scams, missing income, fees and balances that don't add up.</p>
      ${dropZone()}
      <p style="text-align:center"><button class="btn ghost" data-act="sample">Or try it with sample data</button></p>
      <div class="card small">
        <b>Your data stays on your phone.</b>
        <span class="muted">Files are read by this app inside your browser and saved only on this device. Nothing is uploaded — the app is blocked from making network requests at all.</span>
      </div>
      ${howToExport()}`;
  }

  function howToExport() {
    return `<details class="card small"><summary>How do I get a CSV from my bank?</summary>
      <p class="muted">Most banks don't offer this in the app's statement PDF — look for <b>Export</b> or <b>Download transactions</b> instead:</p>
      <ul class="muted" style="padding-left:18px">
        <li><b>Monzo:</b> Account → Statements → Export → CSV</li>
        <li><b>Starling:</b> Account → Statements → choose dates → CSV</li>
        <li><b>Barclays, HSBC, Lloyds, NatWest, Santander, Nationwide:</b> sign in on the website → your account → Export / Download transactions → CSV or Excel CSV</li>
        <li><b>Credit cards</b> often show spending as positive numbers — tick “Flip signs” on the import screen.</li>
      </ul>
      <p class="muted">PDF statements aren't supported: their layouts vary too much to read reliably.</p>
    </details>`;
  }

  function renderAlerts() {
    const alerts = allAlerts();
    const live = alerts.filter((a) => !a.dismissed);
    const counts = { high: 0, medium: 0, low: 0 };
    live.forEach((a) => counts[a.severity]++);
    const shown = alerts.filter((a) => ui.sev === 'all' || a.severity === ui.sev);
    const s = result.stats;
    const nDismissed = dismissedCount();

    let html = `<h2>${live.length ? `${live.length} thing${live.length === 1 ? '' : 's'} worth a look` : 'Nothing unusual found'}</h2>
      <p class="sub">${s.count.toLocaleString('en-GB')} transactions · ${niceDate(s.dataStart)} – ${niceDate(s.dataEnd)}</p>`;
    if (live.length) {
      html += `<div class="chips" role="group" aria-label="Filter by severity">
        <button class="chip" data-sev="all" aria-pressed="${ui.sev === 'all'}">All ${live.length}</button>
        ${['high', 'medium', 'low'].filter((k) => counts[k]).map((k) =>
          `<button class="chip" data-sev="${k}" aria-pressed="${ui.sev === k}">${sevTag(k)} ${counts[k]}</button>`).join('')}
      </div>`;
    }
    if (!live.length && !ui.showDismissed) {
      html += `<div class="empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-6"/></svg>
        <p>Everything looks normal. Load more months of statements to make the checks sharper — they learn what's usual for you.</p></div>`;
    }
    html += shown.map(alertCard).join('');
    if (nDismissed) {
      html += `<p style="text-align:center"><button class="btn ghost" data-act="toggle-dismissed">${ui.showDismissed ? 'Hide' : 'Show'} ${nDismissed} marked as fine</button></p>`;
    }
    if (s.dataEnd && daysSpan(s.dataStart, s.dataEnd) < 85) {
      html += `<div class="card small muted">Only ${daysSpan(s.dataStart, s.dataEnd)} days of history loaded. Three months or more lets Statement Check spot price rises, missed payments and spending that's unusual for <i>you</i>.</div>`;
    }
    return html;
  }

  function daysSpan(a, b) { return Math.round((Date.parse(b) - Date.parse(a)) / 86400000) + 1; }

  function alertCard(a) {
    if (a.kind === 'pattern') {
      const p = a.pattern;
      return `<div class="card alert ${a.severity}">
        <div class="row"><div class="grow">${sevTag(a.severity)}</div></div>
        <div style="font-weight:700;margin-top:6px">${esc(p.title)}</div>
        <p class="muted small" style="margin:6px 0 0">${esc(p.detail)}</p>
        <div class="actions">
          ${a.dismissed ? `<button class="btn small" data-undismiss="${esc(p.id)}">Undo “fine”</button>` : `<button class="btn small" data-dismiss="${esc(p.id)}">It's fine</button>`}
          ${p.merchant ? `<button class="btn small" data-merchant="${esc(p.merchant)}">See history</button>` : ''}
          ${p.month ? `<button class="btn small" data-month="${esc(p.month)}">See month</button>` : ''}
        </div>
      </div>`;
    }
    const t = a.txn;
    const keys = a.reasons.map((r) => r.key).join('\n');
    return `<div class="card alert ${a.severity}">
      <div class="row"><div class="grow">${sevTag(a.severity)}</div><div class="muted small nowrap">${niceDate(t.date)}</div></div>
      <div class="row" style="margin-top:6px">
        <div class="grow"><div style="font-weight:700" class="ellipsis">${esc(SC.titleCase(t.merchant))}</div>
          <div class="muted small ellipsis">${esc(t.desc)}</div></div>
        <div class="amt ${t.amount > 0 ? 'in' : ''}">${money(t.amount, true)}</div>
      </div>
      <ul>${a.reasons.map((r) => `<li><b>${esc(r.title)}</b><span>${esc(r.detail)}</span></li>`).join('')}</ul>
      <div class="actions">
        ${a.dismissed ? `<button class="btn small" data-undismiss="${esc(keys)}">Undo “fine”</button>` : `<button class="btn small" data-dismiss="${esc(keys)}">It's fine</button>`}
        <button class="btn small" data-merchant="${esc(t.merchant)}">See history</button>
      </div>
    </div>`;
  }

  function catById(id) {
    return db.cats.list.find((c) => c.id === id);
  }

  function catPill(t) {
    const info = cats.get(t.id);
    const c = info && info.cat ? catById(info.cat) : null;
    if (!c) return '<span class="pill none">+ Category</span>';
    if (info.source === 'guess') return `<span class="pill guess" title="Guessed from your earlier choices">${esc(c.icon)} ${esc(c.name)}?</span>`;
    return `<span class="pill">${esc(c.icon)} ${esc(c.name)}</span>`;
  }

  // How much is categorised, and by whom: a small stacked bar.
  function categoryProgress() {
    if (!db.txns.length) return '';
    let you = 0;
    let guess = 0;
    for (const v of cats.values()) {
      if (v.source === 'guess') guess++;
      else if (v.source) you++;
    }
    const n = db.txns.length;
    const none = n - you - guess;
    const pct = (x) => Math.round((x / n) * 100);
    const toSort = CAT.payeesToSort(db.txns, db.cats, cats).length;
    return `<div class="card" style="padding:12px 14px">
      <div class="row"><b class="grow">Categories</b>
        ${toSort ? `<button class="btn primary small" data-act="sort">Sort ${toSort} payee${toSort === 1 ? '' : 's'}</button>` : '<span class="small muted">All sorted ✓</span>'}</div>
      <div class="stack" role="img" aria-label="${pct(you)}% set by you, ${pct(guess)}% guessed, ${pct(none)}% not categorised">
        <div style="width:${(you / n) * 100}%;background:var(--series-in)"></div><div style="width:${(guess / n) * 100}%;background:var(--series-in-light)"></div>
      </div>
      <div class="legend" style="margin:0;flex-wrap:wrap">
        <span><i style="background:var(--series-in)"></i>Set by you ${pct(you)}%</span>
        <span><i style="background:var(--series-in-light)"></i>Learned guesses ${pct(guess)}%</span>
        <span><i style="background:var(--surface2);outline:1px solid var(--line)"></i>To do ${pct(none)}%</span>
      </div>
    </div>`;
  }

  function renderTransactions() {
    const flagged = new Set(result.flags.filter((f) => f.reasons.some((r) => !db.dismissed[r.key])).map((f) => f.txn.id));
    const q = ui.q.trim().toLowerCase();
    let list = [...db.txns].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    if (q) {
      list = list.filter((t) => t.desc.toLowerCase().includes(q) || t.merchant.includes(q) || t.date.startsWith(q) ||
        Math.abs(t.amount).toFixed(2).includes(q));
    }
    if (ui.txFilter === 'flagged') list = list.filter((t) => flagged.has(t.id));
    if (ui.txFilter === 'in') list = list.filter((t) => t.amount > 0);
    if (ui.txFilter === 'out') list = list.filter((t) => t.amount < 0);
    if (ui.cat === '__none') list = list.filter((t) => !cats.get(t.id).cat);
    else if (ui.cat === '__guess') list = list.filter((t) => cats.get(t.id).source === 'guess');
    else if (ui.cat) list = list.filter((t) => cats.get(t.id).cat === ui.cat);
    const total = list.reduce((s, t) => s + t.amount, 0);

    let html = `<h2>Transactions</h2>
      <input type="search" id="q" placeholder="Search payee, amount or date (2026-03)" value="${esc(ui.q)}" aria-label="Search transactions" style="margin:8px 0">
      <div class="chips" role="group" aria-label="Filter">
        ${[['all', 'All'], ['flagged', 'Flagged'], ['out', 'Money out'], ['in', 'Money in']].map(([k, l]) =>
          `<button class="chip" data-txf="${k}" aria-pressed="${ui.txFilter === k}">${l}</button>`).join('')}
      </div>
      <select id="cat-filter" aria-label="Filter by category" style="margin:4px 0 8px">
        <option value="">All categories</option>
        <option value="__none" ${ui.cat === '__none' ? 'selected' : ''}>Not categorised</option>
        <option value="__guess" ${ui.cat === '__guess' ? 'selected' : ''}>Guessed — needs checking</option>
        ${db.cats.list.map((c) => `<option value="${esc(c.id)}" ${ui.cat === c.id ? 'selected' : ''}>${esc(c.icon + ' ' + c.name)}</option>`).join('')}
      </select>
      ${categoryProgress()}
      <p class="muted small" style="margin:4px 0">${list.length.toLocaleString('en-GB')} transactions · net ${money(total, true)}</p>`;
    if (!list.length) return html + '<div class="empty"><p>No matching transactions.</p></div>';

    let month = '';
    let open = false;
    const monthTotals = new Map();
    for (const t of list) {
      const m = t.date.slice(0, 7);
      const e = monthTotals.get(m) || { in: 0, out: 0 };
      if (t.amount > 0) e.in += t.amount; else e.out += t.amount;
      monthTotals.set(m, e);
    }
    for (const t of list.slice(0, ui.txLimit)) {
      const m = t.date.slice(0, 7);
      if (m !== month) {
        if (open) html += '</div>';
        const e = monthTotals.get(m);
        html += `<div class="month-h"><span>${SC.monthName(m)}</span><span>in ${money(e.in)} · out ${money(e.out)}</span></div><div class="card" style="padding:0 14px">`;
        month = m;
        open = true;
      }
      const d = new Date(t.date + 'T00:00:00Z');
      html += `<div class="tx" data-cat-txn="${esc(t.id)}" role="button" tabindex="0" aria-label="Set category for ${esc(t.desc)}">
        <div class="d"><b>${d.getUTCDate()}</b>${d.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })}</div>
        <div class="grow"><div class="ellipsis">${flagged.has(t.id) ? '<span class="sev high" title="Flagged"><i aria-hidden="true"></i></span> ' : ''}${esc(t.desc)}</div>
          <div class="muted small ellipsis">${catPill(t)} ${esc(SC.titleCase(t.merchant))}${t.balance != null ? ' · bal ' + money(t.balance) : ''}</div></div>
        <div class="a ${t.amount > 0 ? 'in' : ''}">${money(t.amount, true)}</div>
      </div>`;
    }
    if (open) html += '</div>';
    if (list.length > ui.txLimit) html += `<p style="text-align:center"><button class="btn" data-act="more">Show more</button></p>`;
    return html;
  }

  function renderInsights() {
    const s = result.stats;
    const regular = result.recurring.filter((r) => r.direction === 'out');
    const regularTotal = regular.reduce((a, r) => a + r.monthly, 0);
    const spend = new Map();
    for (const t of db.txns) if (t.amount < 0) spend.set(t.merchant, (spend.get(t.merchant) || 0) - t.amount);
    const top = [...spend.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    const topMax = top.length ? top[0][1] : 1;

    return `<h2>Insights</h2>
      <p class="sub">${niceDate(s.dataStart)} – ${niceDate(s.dataEnd)}</p>
      <div class="tiles">
        <div class="tile"><div class="k">Money in</div><div class="v">${whole(s.totalIn)}</div></div>
        <div class="tile"><div class="k">Money out</div><div class="v">${whole(s.totalOut)}</div></div>
        <div class="tile"><div class="k">Net</div><div class="v">${whole(s.totalIn - s.totalOut, true)}</div></div>
      </div>

      <h3>Money in and out by month</h3>
      <div class="legend"><span><i style="background:var(--series-in)"></i>In</span><span><i style="background:var(--series-out)"></i>Out</span></div>
      ${ui.chartTable ? monthTable(s.months) : monthChart(s.months)}
      <button class="btn ghost small" data-act="chart-table">${ui.chartTable ? 'Show as chart' : 'Show as table'}</button>

      ${categoryBreakdown()}

      <h3>Regular payments</h3>
      ${regular.length ? `<p class="muted small" style="margin:0 0 4px">About <b>${money(regularTotal)}</b> a month goes out on things that repeat.</p>
      <div class="card" style="padding:4px 14px">${regular.map((r) => `
        <div class="tx" data-merchant="${esc(r.merchant)}" style="cursor:pointer">
          <div class="grow"><div class="ellipsis">${esc(r.name)}</div>
            <div class="muted small">${r.period} · ${r.count} payments · last ${niceDate(r.lastDate, false)}${r.overdue ? ' · <b>missed?</b>' : ''}</div></div>
          <div class="a">${money(r.typical)}</div>
        </div>`).join('')}</div>` : '<p class="muted small">None spotted yet — needs at least three payments to the same place at a steady interval.</p>'}

      <h3>Where the money went</h3>
      <div class="card">${top.map(([m, v]) => `
        <div class="hbar" data-merchant="${esc(m)}" style="cursor:pointer">
          <span class="ellipsis">${esc(SC.titleCase(m))}</span><b class="nowrap">${money(v)}</b>
          <div class="bar"><div style="width:${Math.max(2, (v / topMax) * 100).toFixed(1)}%"></div></div>
        </div>`).join('')}</div>`;
  }

  function categoryBreakdown() {
    const months = Math.max(1, result.stats.months.length);
    const spend = new Map();
    const income = new Map();
    let moved = 0;
    for (const t of db.txns) {
      const id = cats.get(t.id).cat || '__none';
      const c = catById(id);
      if (c && c.type === 'both') { if (t.amount < 0) moved -= t.amount; continue; }
      const m = t.amount < 0 ? spend : income;
      m.set(id, (m.get(id) || 0) + Math.abs(t.amount));
    }
    const bars = (m) => {
      const rows = [...m.entries()].sort((a, b) => b[1] - a[1]);
      const max = rows.length ? rows[0][1] : 1;
      return rows.map(([id, v]) => {
        const c = catById(id);
        const label = c ? `${c.icon} ${c.name}` : 'Not categorised';
        return `<div class="hbar" data-catfilter="${esc(id)}" style="cursor:pointer">
          <span class="ellipsis">${esc(label)}</span><span class="nowrap"><b>${money(v)}</b> <span class="muted small">· ${whole(v / months)}/mo</span></span>
          <div class="bar"><div style="width:${Math.max(2, (v / max) * 100).toFixed(1)}%${c ? '' : ';background:var(--text3)'}"></div></div>
        </div>`;
      }).join('');
    };
    const hasAny = [...cats.values()].some((v) => v.cat);
    return `<h3>Spending by category</h3>
      ${hasAny ? '' : '<p class="muted small" style="margin:0 0 6px">Nothing categorised yet. <button class="btn ghost small" data-act="sort">Sort your payees</button> and this fills in.</p>'}
      <div class="card">${bars(spend) || '<p class="muted small">No spending.</p>'}
        ${moved ? `<p class="muted small" style="margin:8px 0 0">Plus ${money(moved)} in transfers and savings, not counted as spending.</p>` : ''}</div>
      ${income.size ? `<h3>Income by category</h3><div class="card">${bars(income)}</div>` : ''}`;
  }

  function monthTable(months) {
    return `<div class="card" style="overflow-x:auto"><table class="data"><thead><tr><th>Month</th><th>In</th><th>Out</th><th>Net</th></tr></thead><tbody>
      ${months.map((m) => `<tr><td>${SC.monthName(m.month)}</td><td>${money(m.in)}</td><td>${money(m.out)}</td><td>${money(m.in - m.out, true)}</td></tr>`).join('')}
      </tbody></table></div>`;
  }

  function monthChart(months) {
    const W = 340;
    const H = 190;
    const L = 40;
    const B = 22;
    const T = 8;
    const max = Math.max(1, ...months.map((m) => Math.max(m.in, m.out)));
    const step = niceStep(max / 4);
    const top = Math.ceil(max / step) * step;
    const y = (v) => T + (H - T - B) * (1 - v / top);
    const slot = (W - L) / months.length;
    const bw = Math.max(3, Math.min(16, slot * 0.32));
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Money in and out per month">`;
    for (let v = 0; v <= top + 1e-9; v += step) {
      svg += `<line class="grid" x1="${L}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${compact(v)}</text>`;
    }
    const labelEvery = Math.ceil(months.length / 8);
    months.forEach((m, i) => {
      const cx = L + slot * i + slot / 2;
      svg += `<rect class="hit" data-i="${i}" x="${L + slot * i}" y="${T}" width="${slot}" height="${H - T}" rx="4"/>`;
      svg += bar(cx - bw - 1, bw, y(m.in), y(0), 'var(--series-in)');
      svg += bar(cx + 1, bw, y(m.out), y(0), 'var(--series-out)');
      if (i % labelEvery === 0) svg += `<text class="axis" x="${cx}" y="${H - 6}" text-anchor="middle">${SC.monthName(m.month).slice(0, 3)}</text>`;
    });
    return `<div class="card chart" id="chart">${svg}</svg></div>`;
  }

  // Rounded at the data end only, square on the baseline.
  function bar(x, w, yTop, yBase, fill) {
    const h = yBase - yTop;
    if (h <= 0.5) return '';
    const r = Math.min(4, w / 2, h);
    return `<path pointer-events="none" fill="${fill}" d="M${x},${yBase}V${yTop + r}q0,-${r} ${r},-${r}h${w - 2 * r}q${r},0 ${r},${r}V${yBase}z"/>`;
  }

  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    const n = raw / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
  }

  function wireChart() {
    const chart = $('#chart');
    if (!chart) return;
    const months = result.stats.months;
    const svg = $('svg', chart);
    let tip = null;
    const show = (rect) => {
      chart.querySelectorAll('.hit.on').forEach((r) => r.classList.remove('on'));
      rect.classList.add('on');
      const m = months[+rect.dataset.i];
      if (!tip) { tip = document.createElement('div'); tip.className = 'tip'; chart.appendChild(tip); }
      tip.innerHTML = `${SC.monthName(m.month)}<br>In <b>${money(m.in)}</b> · Out <b>${money(m.out)}</b>`;
      const box = rect.getBoundingClientRect();
      const host = chart.getBoundingClientRect();
      const x = Math.min(Math.max(box.left - host.left + box.width / 2, 90), host.width - 90);
      tip.style.left = x + 'px';
      tip.style.top = (svg.getBoundingClientRect().top - host.top + 4) + 'px';
    };
    chart.querySelectorAll('.hit').forEach((r) => {
      r.addEventListener('pointerenter', () => show(r));
      r.addEventListener('click', () => show(r));
    });
    chart.addEventListener('pointerleave', (e) => {
      if (e.pointerType !== 'mouse') return;
      if (tip) { tip.remove(); tip = null; }
      chart.querySelectorAll('.hit.on').forEach((r) => r.classList.remove('on'));
    });
  }

  function renderFiles() {
    const currencies = ['GBP', 'EUR', 'USD', 'AUD', 'CAD', 'NZD', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'ZAR', 'INR', 'JPY'];
    return `<h2>Statements</h2>
      <p class="sub">Load several months — or several accounts. Overlapping statements are de-duplicated automatically.</p>
      ${dropZone()}
      ${db.txns.length ? '' : '<p style="text-align:center"><button class="btn ghost" data-act="sample">Try it with sample data</button></p>'}
      ${db.imports.length ? `<h3>Loaded</h3>${db.imports.map((im) => `
        <div class="card row">
          <div class="grow"><div class="ellipsis"><b>${esc(im.name)}</b></div>
            <div class="muted small">${im.count} transactions${im.dupes ? ` · ${im.dupes} already loaded` : ''}${im.from ? ` · ${niceDate(im.from)} – ${niceDate(im.to)}` : ''}</div></div>
          <button class="btn small" data-remove="${esc(im.id)}" aria-label="Remove ${esc(im.name)}">Remove</button>
        </div>`).join('')}` : ''}
      ${howToExport()}

      <h3>Settings</h3>
      <div class="card">
        <label class="small muted" for="currency">Currency</label>
        <select id="currency" style="margin-top:4px">${currencies.map((c) => `<option ${c === db.settings.currency ? 'selected' : ''}>${c}</option>`).join('')}</select>
        <div class="row" style="margin-top:14px;flex-wrap:wrap">
          <button class="btn small" data-act="backup" ${db.txns.length ? '' : 'disabled'}>Save a backup</button>
          <button class="btn small" data-act="restore">Restore backup</button>
          <button class="btn small" data-act="export-csv" ${db.txns.length ? '' : 'disabled'}>Export to spreadsheet (CSV)</button>
        </div>
      </div>
      ${categoryManager()}
      <div class="card small">
        <b>Privacy</b>
        <p class="muted" style="margin:4px 0 0">Statements are read and analysed inside this app and stored only in this browser on this device. The app is locked down so it cannot send anything over the internet. Clearing your browser's site data — or removing the app — deletes everything.</p>
      </div>
      ${db.txns.length ? '<button class="btn danger block" data-act="wipe" style="margin:18px 0 8px">Delete all data</button>' : ''}`;
  }

  function categoryManager() {
    const counts = new Map();
    for (const v of cats.values()) if (v.cat) counts.set(v.cat, (counts.get(v.cat) || 0) + 1);
    const rules = Object.keys(db.cats.payeeCats).length + Object.keys(db.cats.txnCats).length;
    const icons = ['🏷️', '🐶', '🚲', '🎓', '⛽', '🍷', '💇', '🏋️', '🧹', '📚', '🎮', '👶', '🌱', '⚽', '🏥', '💳'];
    const group = (type, title) => {
      const list = db.cats.list.filter((c) => c.type === type);
      if (!list.length) return '';
      return `<div class="small muted" style="margin:10px 0 2px">${title}</div>` + list.map((c) => `
        <div class="row" style="padding:4px 0">
          <span class="grow ellipsis">${esc(c.icon)} ${esc(c.name)} <span class="muted small">${counts.get(c.id) ? '· ' + counts.get(c.id) : ''}</span></span>
          <button class="btn ghost small" data-delcat="${esc(c.id)}" aria-label="Delete ${esc(c.name)}">Delete</button>
        </div>`).join('');
    };
    return `<h3>Categories</h3>
      <div class="card">
        <p class="muted small" style="margin:0">You've taught it ${rules} rule${rules === 1 ? '' : 's'}. Tap any transaction to change its category.</p>
        ${group('out', 'Spending')}${group('in', 'Income')}${group('both', 'Either way')}
        <div class="small muted" style="margin:14px 0 4px">Add a category</div>
        <div class="row" style="flex-wrap:wrap">
          <select id="new-cat-icon" aria-label="Icon" style="width:72px">${icons.map((i) => `<option>${i}</option>`).join('')}</select>
          <input id="new-cat-name" placeholder="Name, e.g. Pets" maxlength="40" aria-label="Category name" style="flex:1;min-width:120px;border:1px solid var(--line);background:var(--surface);border-radius:10px;padding:10px 12px">
          <select id="new-cat-type" aria-label="Type" style="width:auto"><option value="out">Spending</option><option value="in">Income</option><option value="both">Either</option></select>
          <button class="btn primary small" data-act="add-cat">Add</button>
        </div>
        ${rules ? '<button class="btn ghost small" data-act="reset-learning" style="margin-top:8px">Forget everything it has learned</button>' : ''}
      </div>`;
  }

  // ------------------------------------------------------------ import ----

  async function handleFiles(files) {
    for (const file of files) {
      const name = file.name || 'statement';
      if (/\.(pdf)$/i.test(name)) { toast("PDFs can't be read — export a CSV from your bank instead."); continue; }
      if (/\.(xlsx?|numbers)$/i.test(name)) { toast('Save the spreadsheet as CSV first, then load that.'); continue; }
      if (file.size > 20 * 1024 * 1024) { toast(`${name} is too big (over 20 MB).`); continue; }
      const text = await file.text();
      if (SC.looksLikeOFX(text)) { commit(name, SC.parseOFX(text)); continue; }
      if (SC.looksLikeQIF(text)) { commit(name, SC.parseQIF(text)); continue; }
      const rows = SC.parseCSV(text);
      if (!rows.length) { toast(`${name} looks empty.`); continue; }
      await mappingSheet(name, rows);
    }
  }

  function mappingSheet(name, rows) {
    return new Promise((resolve) => {
      const cfg = SC.guessMapping(rows);
      const ncols = Math.max(cfg.ncols, ...rows.slice(0, 50).map((r) => r.length));
      const example = (i) => { const r = rows.slice(cfg.headerIdx + 1, cfg.headerIdx + 60).find((x) => x[i]); return r ? ` — e.g. “${r[i]}”` : ''; };
      const colName = (i) => (cfg.headers && cfg.headers[i] ? cfg.headers[i] : `Column ${i + 1}`) + example(i);
      const opts = (sel) => `<option value="-1">(none)</option>` +
        Array.from({ length: ncols }, (_, i) => `<option value="${i}" ${i === sel ? 'selected' : ''}>${esc(colName(i))}</option>`).join('');
      const bg = document.createElement('div');
      bg.className = 'sheet-bg';
      bg.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="map-title">
        <h2 id="map-title">Check the columns</h2>
        <p class="sub ellipsis">${esc(name)}</p>
        <div class="map-grid">
          <label for="m-date">Date</label><select id="m-date">${opts(cfg.map.date)}</select>
          <label for="m-desc">Description</label><select id="m-desc">${opts(cfg.map.desc)}</select>
          <label for="m-amount">Amount (±)</label><select id="m-amount">${opts(cfg.map.amount)}</select>
          <label for="m-debit">…or Money out</label><select id="m-debit">${opts(cfg.map.debit)}</select>
          <label for="m-credit">…and Money in</label><select id="m-credit">${opts(cfg.map.credit)}</select>
          <label for="m-balance">Balance</label><select id="m-balance">${opts(cfg.map.balance)}</select>
          <label for="m-order">Date format</label><select id="m-order">
            <option value="DMY" ${cfg.dateOrder === 'DMY' ? 'selected' : ''}>Day / Month / Year</option>
            <option value="MDY" ${cfg.dateOrder === 'MDY' ? 'selected' : ''}>Month / Day / Year</option></select>
        </div>
        <label class="check"><input type="checkbox" id="m-flip"> Flip signs (credit cards that show spending as positive)</label>
        <div id="m-preview" class="preview"></div>
        <div class="row">
          <button class="btn grow" data-x="cancel">Cancel</button>
          <button class="btn primary grow" data-x="ok">Import</button>
        </div>
      </div>`;
      document.body.appendChild(bg);
      const sheet = $('.sheet', bg);
      const read = () => {
        const v = (id) => +$('#' + id, sheet).value;
        cfg.map = { date: v('m-date'), desc: v('m-desc'), amount: v('m-amount'), debit: v('m-debit'), credit: v('m-credit'), balance: v('m-balance') };
        cfg.dateOrder = $('#m-order', sheet).value;
        cfg.flip = $('#m-flip', sheet).checked;
        return SC.applyMapping(rows, cfg);
      };
      const preview = () => {
        const { txns, skipped } = read();
        const outs = txns.filter((t) => t.amount < 0).length;
        $('#m-preview', sheet).innerHTML = txns.length
          ? `<p class="small muted" style="margin:0 0 6px"><b>${txns.length}</b> transactions found${skipped ? `, ${skipped} rows skipped` : ''}. ${outs} money out, ${txns.length - outs} money in — if that's back to front, tick “Flip signs”.</p>
            <table class="data"><tbody>${txns.slice(0, 5).map((t) => `<tr><td>${niceDate(t.date)}</td><td style="text-align:left;max-width:150px" class="ellipsis">${esc(t.desc)}</td><td>${money(t.amount, true)}</td></tr>`).join('')}</tbody></table>`
          : '<p class="small"><b>No transactions recognised.</b> Pick the date and amount columns above.</p>';
        $('[data-x="ok"]', sheet).disabled = !txns.length;
      };
      sheet.addEventListener('change', preview);
      preview();
      const close = () => { bg.remove(); popBack = null; resolve(); };
      popBack = close;
      sheet.addEventListener('click', (e) => {
        const x = e.target.closest('[data-x]');
        if (!x) return;
        if (x.dataset.x === 'ok') commit(name, read().txns);
        close();
      });
      bg.addEventListener('click', (e) => { if (e.target === bg) close(); });
    });
  }

  // ------------------------------------------------------- categories ----

  function openSheet(html) {
    const bg = document.createElement('div');
    bg.className = 'sheet-bg';
    bg.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${html}</div>`;
    document.body.appendChild(bg);
    const close = () => { bg.remove(); popBack = null; render(); };
    popBack = close;
    bg.addEventListener('click', (e) => { if (e.target === bg) close(); });
    return { el: $('.sheet', bg), close };
  }

  function catGrid(dir, current, suggested) {
    return `<div class="cat-grid">${db.cats.list.filter((c) => CAT.allows(c, dir)).map((c) =>
      `<button class="chip${c.id === suggested ? ' suggested' : ''}" data-pick="${esc(c.id)}" aria-pressed="${c.id === current}">${esc(c.icon)} ${esc(c.name)}</button>`).join('')}
      <button class="chip" data-newcat="1">+ New</button></div>`;
  }

  function addCategoryPrompt(dir) {
    const name = (prompt('Name for the new category') || '').trim().slice(0, 40);
    if (!name) return null;
    const existing = db.cats.list.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (existing) return existing.id;
    const c = { id: CAT.slug(name), name, icon: '🏷️', type: dir };
    db.cats.list.push(c);
    save();
    return c.id;
  }

  // Tap a transaction: choose its category, for this payment or the payee.
  function openPicker(id) {
    const t = db.txns.find((x) => x.id === id);
    if (!t) return;
    const dir = CAT.direction(t);
    const key = CAT.payeeKey(t);
    const info = cats.get(t.id);
    const samePayee = db.txns.filter((x) => CAT.payeeKey(x) === key).length;
    const name = SC.titleCase(t.merchant);
    const guessCat = info.source === 'guess' ? catById(info.cat) : null;
    const sh = openSheet(`
      <h2 style="margin-bottom:2px">${esc(name)}</h2>
      <p class="sub">${esc(t.desc)} · ${niceDate(t.date)} · <b>${money(t.amount, true)}</b></p>
      ${guessCat ? `<div class="card small" style="margin-top:0">🧠 <b>Learned guess: ${esc(guessCat.icon + ' ' + guessCat.name)}</b> <span class="muted">(${Math.round(info.confidence * 100)}% sure, from payments you've already categorised). Tap it to confirm.</span></div>` : ''}
      ${catGrid(dir, info.source !== 'guess' ? info.cat : null, guessCat ? guessCat.id : null)}
      <label class="check"><input type="checkbox" id="always" checked> Use for all ${samePayee > 1 ? samePayee + ' ' : ''}${dir === 'out' ? 'payments to' : 'money from'} ${esc(name)} — and future ones</label>
      <div class="row" style="margin-top:8px">
        ${info.source === 'manual' || info.source === 'payee' ? '<button class="btn grow" data-x="clear">Clear category</button>' : ''}
        <button class="btn grow" data-x="close">Close</button>
      </div>`);
    sh.el.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const always = $('#always', sh.el).checked;
      let pick = b.dataset.pick;
      if (b.dataset.newcat) pick = addCategoryPrompt(dir);
      if (pick) {
        if (always) { db.cats.payeeCats[key] = pick; delete db.cats.txnCats[t.id]; }
        else db.cats.txnCats[t.id] = pick;
        save(); recategorise();
        const c = catById(pick);
        toast(always ? `${name} → ${c.name}. Similar payments will be guessed too.` : `Set to ${c.name}.`);
        sh.close();
      } else if (b.dataset.x === 'clear') {
        delete db.cats.txnCats[t.id];
        if (always) delete db.cats.payeeCats[key];
        save(); recategorise(); sh.close();
      } else if (b.dataset.x === 'close') sh.close();
    });
  }

  // Walk through uncategorised payees, biggest first. Each answer retrains
  // the guesses, so later suggestions get better as you go.
  function openSort() {
    const skipped = new Set();
    let done = 0;
    const sh = openSheet('<div id="sort-body"></div>');
    const body = $('#sort-body', sh.el);
    const step = () => {
      const queue = CAT.payeesToSort(db.txns, db.cats, cats).filter((g) => !skipped.has(g.key));
      if (!queue.length) {
        body.innerHTML = `<div class="empty" style="padding:20px 0"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-6"/></svg>
          <p><b>${done ? `${done} payee${done === 1 ? '' : 's'} sorted.` : 'Nothing left to sort.'}</b><br>New statements will be categorised automatically from what you've taught it.</p></div>
          <button class="btn primary block" data-x="close">Done</button>`;
        return;
      }
      const g = queue[0];
      const sample = g.txns[0];
      const guess = cats.get(sample.id);
      const gc = guess.source === 'guess' ? catById(guess.cat) : null;
      body.innerHTML = `<p class="small muted" style="margin:0">${done} sorted · ${queue.length} to go · each answer teaches the app</p>
        <div class="card">
          <div class="small muted">${g.dir === 'out' ? 'Money out to' : 'Money in from'}</div>
          <div style="font-size:20px;font-weight:700">${esc(SC.titleCase(g.merchant))}</div>
          <div class="muted small">${g.txns.length} payment${g.txns.length === 1 ? '' : 's'} · ${money(g.total)} total · e.g. “${esc(sample.desc)}”</div>
          ${gc ? `<div class="small" style="margin-top:8px">🧠 Suggested: <b>${esc(gc.icon + ' ' + gc.name)}</b> <span class="muted">(${Math.round(guess.confidence * 100)}% sure)</span></div>` : ''}
        </div>
        ${catGrid(g.dir, null, gc ? gc.id : null)}
        <div class="row" style="margin-top:12px">
          <button class="btn grow" data-x="skip">Skip</button>
          <button class="btn grow" data-x="close">Finish later</button>
        </div>`;
      body.dataset.key = g.key;
      body.dataset.dir = g.dir;
    };
    sh.el.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      let pick = b.dataset.pick;
      if (b.dataset.newcat) pick = addCategoryPrompt(body.dataset.dir);
      if (pick) {
        db.cats.payeeCats[body.dataset.key] = pick;
        done++;
        save(); recategorise(); step();
      } else if (b.dataset.x === 'skip') { skipped.add(body.dataset.key); step(); }
      else if (b.dataset.x === 'close') sh.close();
    });
    step();
  }

  function exportCSV() {
    const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const lines = ['Date,Description,Payee,Amount,Balance,Category,Category source'];
    for (const t of [...db.txns].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))) {
      const info = cats.get(t.id);
      const c = info.cat ? catById(info.cat) : null;
      const src = { manual: 'you (this payment)', payee: 'you (payee rule)', guess: 'learned guess' }[info.source] || '';
      lines.push([t.date, q(t.desc), q(SC.titleCase(t.merchant)), t.amount.toFixed(2), t.balance == null ? '' : t.balance.toFixed(2), q(c ? c.name : ''), q(src)].join(','));
    }
    download(lines.join('\n'), 'text/csv', `statement-check-transactions-${new Date().toISOString().slice(0, 10)}.csv`);
    toast('Transactions exported.');
  }

  function download(text, type, filename) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  let popBack = null;
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && popBack) popBack();
    const row = e.target.closest && e.target.closest('[data-cat-txn]');
    if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openPicker(row.dataset.catTxn); }
  });

  function commit(name, parsed) {
    if (!parsed.length) { toast(`No transactions found in ${name}.`); return; }
    const importId = 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const existing = new Set(db.txns.map((t) => t.id));
    const fresh = [];
    SC.assignIds(parsed).forEach((t, seq) => {
      if (!existing.has(t.id)) fresh.push({ ...t, importId, seq });
    });
    const dupes = parsed.length - fresh.length;
    const dates = parsed.map((t) => t.date).sort();
    db.imports.push({ id: importId, name, count: fresh.length, dupes, from: dates[0], to: dates[dates.length - 1], added: new Date().toISOString() });
    db.txns.push(...fresh);
    save();
    reanalyse();
    toast(`Loaded ${fresh.length} transaction${fresh.length === 1 ? '' : 's'}${dupes ? ` (${dupes} already loaded)` : ''}.`);
    go('alerts');
  }

  function restore(file) {
    file.text().then((text) => {
      let data;
      try { data = JSON.parse(text); } catch { data = null; }
      if (!data || data.app !== 'statement-check' || !Array.isArray(data.txns)) {
        toast("That isn't a Statement Check backup.");
        return;
      }
      if (db.txns.length && !confirm('Replace everything on this device with the backup?')) return;
      db = { imports: data.imports || [], txns: data.txns, dismissed: data.dismissed || {}, settings: data.settings || { currency: 'GBP' },
        cats: data.cats && Array.isArray(data.cats.list) ? data.cats : CAT.freshState() };
      save();
      reanalyse();
      toast('Backup restored.');
      go('alerts');
    });
  }

  function backup() {
    const data = JSON.stringify({ app: 'statement-check', version: 1, saved: new Date().toISOString(), ...db });
    download(data, 'application/json', `statement-check-backup-${new Date().toISOString().slice(0, 10)}.json`);
    toast('Backup saved. It contains your transactions — keep it somewhere private.');
  }

  // ------------------------------------------------------------ events ----

  let restoring = false;

  document.addEventListener('click', (e) => {
    const t = e.target.closest('button, [data-merchant], [data-cat-txn], [data-catfilter]');
    if (!t) return;
    const d = t.dataset;
    if (d.tab) return go(d.tab);
    if (d.sev) { ui.sev = d.sev; return render(); }
    if (d.txf) { ui.txFilter = d.txf; ui.txLimit = 300; return render(); }
    if (d.dismiss) {
      d.dismiss.split('\n').forEach((k) => { db.dismissed[k] = Date.now(); });
      save(); reanalyse(); render();
      return toast('Marked as fine.');
    }
    if (d.undismiss) {
      d.undismiss.split('\n').forEach((k) => { delete db.dismissed[k]; });
      save(); reanalyse(); return render();
    }
    if (d.catTxn) return openPicker(d.catTxn);
    if (d.catfilter) { ui.cat = d.catfilter === '__none' ? '__none' : d.catfilter; ui.q = ''; ui.txFilter = 'all'; return go('transactions'); }
    if (d.delcat) {
      const c = catById(d.delcat);
      if (!c || !confirm(`Delete the category “${c.name}”? Payments in it become uncategorised.`)) return;
      db.cats.list = db.cats.list.filter((x) => x.id !== c.id);
      for (const m of [db.cats.payeeCats, db.cats.txnCats]) for (const k of Object.keys(m)) if (m[k] === c.id) delete m[k];
      save(); recategorise(); return render();
    }
    if (d.merchant) { ui.q = d.merchant; ui.txFilter = 'all'; return go('transactions'); }
    if (d.month) { ui.q = d.month; ui.txFilter = 'out'; return go('transactions'); }
    if (d.remove) {
      const im = db.imports.find((x) => x.id === d.remove);
      if (!im || !confirm(`Remove ${im.name} and its ${im.count} transactions?`)) return;
      db.txns = db.txns.filter((x) => x.importId !== d.remove);
      db.imports = db.imports.filter((x) => x.id !== d.remove);
      save(); reanalyse(); return render();
    }
    switch (d.act) {
      case 'pick': restoring = false; fileInput.accept = '.csv,.ofx,.qfx,.qif,.txt,text/csv'; fileInput.multiple = true; fileInput.click(); break;
      case 'restore': restoring = true; fileInput.accept = '.json,application/json'; fileInput.multiple = false; fileInput.click(); break;
      case 'sample': commit('Sample current account.csv', SC.applyMapping(SC.parseCSV(SC.sampleCSV()), SC.guessMapping(SC.parseCSV(SC.sampleCSV()))).txns); break;
      case 'toggle-dismissed': ui.showDismissed = !ui.showDismissed; reanalyse(); render(); break;
      case 'more': ui.txLimit += 300; render(); break;
      case 'chart-table': ui.chartTable = !ui.chartTable; render(); break;
      case 'backup': backup(); break;
      case 'sort': openSort(); break;
      case 'export-csv': exportCSV(); break;
      case 'add-cat': {
        const name = ($('#new-cat-name').value || '').trim().slice(0, 40);
        if (!name) return toast('Type a name first.');
        db.cats.list.push({ id: CAT.slug(name), name, icon: $('#new-cat-icon').value, type: $('#new-cat-type').value });
        save(); render(); toast(`Added ${name}.`);
        break;
      }
      case 'reset-learning':
        if (!confirm('Forget every category you have set? Your categories list stays.')) return;
        db.cats.txnCats = {};
        db.cats.payeeCats = {};
        save(); recategorise(); render();
        break;
      case 'wipe':
        if (!confirm('Delete every statement and setting from this device? This cannot be undone.')) return;
        db = { imports: [], txns: [], dismissed: {}, settings: db.settings, cats: CAT.freshState() };
        save(); reanalyse(); render(); toast('All data deleted.');
        break;
    }
  });

  document.addEventListener('input', (e) => {
    if (e.target.id === 'q') {
      ui.q = e.target.value;
      ui.txLimit = 300;
      const pos = e.target.selectionStart;
      render();
      const q = $('#q');
      q.focus();
      q.setSelectionRange(pos, pos);
    }
  });

  document.addEventListener('change', (e) => {
    if (e.target.id === 'cat-filter') { ui.cat = e.target.value; ui.txLimit = 300; return render(); }
    if (e.target.id === 'currency') { db.settings.currency = e.target.value; save(); reanalyse(); render(); }
  });

  fileInput.addEventListener('change', () => {
    const files = [...fileInput.files];
    fileInput.value = '';
    if (!files.length) return;
    if (restoring) restore(files[0]); else handleFiles(files);
  });

  // Drag and drop for desktop use.
  document.addEventListener('dragover', (e) => { e.preventDefault(); const z = $('#drop'); if (z) z.classList.add('over'); });
  document.addEventListener('dragleave', () => { const z = $('#drop'); if (z) z.classList.remove('over'); });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const z = $('#drop');
    if (z) z.classList.remove('over');
    if (e.dataTransfer && e.dataTransfer.files.length) handleFiles([...e.dataTransfer.files]);
  });

  // Files shared to the installed app from another app (Android share target).
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (params) => {
      if (!params.files || !params.files.length) return;
      handleFiles(await Promise.all(params.files.map((h) => h.getFile())));
    });
  }

  // ------------------------------------------------------------- start ----

  load();
  reanalyse();
  render();

  // Ask the browser not to evict our data under storage pressure.
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
