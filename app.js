/* Statement Check — UI. Everything is stored in this browser's localStorage. */
(function () {
  'use strict';

  const SC = window.SC;
  const CAT = window.CAT;
  const PDFS = window.PDFS;
  const LOCK = window.LOCK;
  const REMIND = window.REMIND;
  const ENC_KEY = 'statement-check.v1.enc';
  const META_KEY = 'statement-check.v1.lock';
  const KEY = 'statement-check.v1';
  // Reminder settings sit outside the (possibly encrypted) data so the
  // service worker can read a copy. They hold only the day, hour and when a
  // statement was last loaded — no statement contents.
  const REMIND_KEY = KEY + '.remind';
  const REMIND_CACHE = 'statement-check-remind';
  const REMIND_URL = './__remind.json';
  const $ = (sel, el) => (el || document).querySelector(sel);
  const view = $('#view');
  const fileInput = $('#file-input');

  // ------------------------------------------------------------- state ----

  const blank = () => ({ imports: [], txns: [], dismissed: {}, mutes: {}, aliases: {}, deleted: {}, settings: { currency: 'GBP' }, cats: CAT.freshState() });
  let db = blank();
  let result = null;
  let cats = new Map(); // txn id -> { cat, source, confidence }
  let tab = 'alerts';
  const ui = { sev: 'all', showDismissed: false, q: '', txFilter: 'all', cat: '', txLimit: 300, chartTable: false, notify: '' };

  function adopt(data) {
    db = Object.assign(blank(), data || {});
    if (!db.cats || !Array.isArray(db.cats.list)) db.cats = CAT.freshState();
    for (const k of ['mutes', 'aliases', 'deleted']) if (!db[k]) db[k] = {};
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      adopt(raw ? JSON.parse(raw) : null);
    } catch { adopt(null); /* private mode or blocked storage: start empty */ }
    try { const t = localStorage.getItem(KEY + '.tab'); if (t) tab = t; } catch { /* ignore */ }
  }

  // With the app lock on, only the encrypted copy is ever written.
  let cryptoKey = null;
  let lockMeta = readMeta();
  let saving = Promise.resolve();

  function save() {
    if (lockMeta) {
      if (!cryptoKey) return false;
      const text = JSON.stringify(db);
      const key = cryptoKey;
      saving = saving
        .then(() => LOCK.encryptText(key, text))
        .then((blob) => localStorage.setItem(ENC_KEY, JSON.stringify(blob)))
        .catch(() => toast("Couldn't save on this device — storage may be full or blocked."));
      return true;
    }
    try {
      localStorage.setItem(KEY, JSON.stringify(db));
      return true;
    } catch {
      toast("Couldn't save on this device — storage may be full or blocked.");
      return false;
    }
  }

  function readMeta() {
    try {
      const m = JSON.parse(localStorage.getItem(META_KEY) || 'null');
      return m && m.salt ? m : null;
    } catch { return null; }
  }

  function writeMeta() {
    try {
      if (lockMeta) localStorage.setItem(META_KEY, JSON.stringify(lockMeta));
      else localStorage.removeItem(META_KEY);
    } catch { /* ignore */ }
  }

  let remind = readRemind();

  function readRemind() {
    try {
      const r = JSON.parse(localStorage.getItem(REMIND_KEY) || 'null');
      if (r && typeof r === 'object') return Object.assign({ day: null, hour: 9, lastImport: 0, snoozeUntil: 0, notified: '' }, r);
    } catch { /* ignore */ }
    return { day: null, hour: 9, lastImport: 0, snoozeUntil: 0, notified: '' };
  }

  function writeRemind() {
    try { localStorage.setItem(REMIND_KEY, JSON.stringify(remind)); } catch { /* ignore */ }
    syncRemind();
  }

  // Copy the settings where the service worker can see them, keeping the
  // month it last notified for (it records that on its side).
  async function syncRemind() {
    if (!('caches' in window)) return;
    try {
      const cache = await caches.open(REMIND_CACHE);
      const old = await cache.match(REMIND_URL);
      const theirs = old ? await old.json() : null;
      if (theirs && (theirs.notified || '') > (remind.notified || '')) {
        remind.notified = theirs.notified;
        try { localStorage.setItem(REMIND_KEY, JSON.stringify(remind)); } catch { /* ignore */ }
      }
      await cache.put(REMIND_URL, new Response(JSON.stringify(remind), { headers: { 'Content-Type': 'application/json' } }));
    } catch { /* ignore: the in-app banner still works */ }
  }

  // Ask for notifications and the twice-a-day background wake-up. Sets
  // ui.notify to what the phone allows: on, ask, blocked, no-install or unsupported.
  async function setupNotifications(ask) {
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
    if (!reg || !('periodicSync' in reg) || !('Notification' in window)) { ui.notify = 'unsupported'; return; }
    if (remind.day == null) {
      ui.notify = '';
      try { await reg.periodicSync.unregister('statement-reminder'); } catch { /* ignore */ }
      return;
    }
    if (Notification.permission === 'default' && ask) await Notification.requestPermission();
    if (Notification.permission === 'default') { ui.notify = 'ask'; return; }
    if (Notification.permission !== 'granted') { ui.notify = 'blocked'; return; }
    let state = 'denied';
    try { state = (await navigator.permissions.query({ name: 'periodic-background-sync' })).state; } catch { /* ignore */ }
    if (state !== 'granted') { ui.notify = 'no-install'; return; }
    try {
      await reg.periodicSync.register('statement-reminder', { minInterval: 12 * 60 * 60 * 1000 });
      ui.notify = 'on';
    } catch { ui.notify = 'no-install'; }
  }

  function reanalyse() {
    result = SC.analyse(db.txns, { format: money, formatDate: niceDate });
    result.basePatterns = result.patterns;
    recategorise();
  }

  // Categories feed the alerts, so any category change re-runs that part.
  function recategorise() {
    cats = CAT.categorise(db.txns, db.cats);
    if (!result) return;
    result.patterns = result.basePatterns.concat(CAT.categorySpikes(db.txns, cats, db.cats.list,
      { format: money, monthName: SC.monthName, titleCase: SC.titleCase }));
    const n = visibleAlerts().length;
    const badge = $('#alert-badge');
    badge.hidden = !n;
    badge.textContent = n > 99 ? '99+' : n;
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
      const live = f.reasons.filter((r) => !isOff(r, f.txn));
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

  // Marked fine once, or "never flag this payee for this" (a mute).
  function isOff(r, t) {
    return !!(db.dismissed[r.key] || db.mutes[r.rule + '|' + t.merchant]);
  }

  function visibleAlerts() {
    return allAlerts().filter((a) => !a.dismissed);
  }

  function dismissedCount() {
    if (!result) return 0;
    return result.flags.filter((f) => f.reasons.every((r) => isOff(r, f.txn))).length +
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
    const badge = $('#lock-badge');
    if (badge) {
      badge.dataset.act = lockMeta ? 'lock-now' : '';
      badge.title = lockMeta ? 'Lock the app now' : 'Your statements never leave this device';
      $('span', badge).textContent = lockMeta ? 'Lock' : 'On this device only';
    }
    document.querySelectorAll('nav.tabs button').forEach((b) => {
      if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    if (!db.txns.length && tab !== 'files') {
      view.innerHTML = reminderBanner() + welcome();
      return;
    }
    view.innerHTML = reminderBanner() + ({ alerts: renderAlerts, transactions: renderTransactions, insights: renderInsights, files: renderFiles })[tab]();
    if (tab === 'insights') wireChart();
  }

  // ----------------------------------------------------------- screens ----

  const UPLOAD_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M12 18v-6M9 15l3-3 3 3"/></svg>';

  function dropZone() {
    return `<div class="drop" id="drop">
      ${UPLOAD_ICON}
      <p style="margin:8px 0 14px"><b>Load a bank statement</b><br><span class="muted small">PDF, CSV, OFX, QFX or QIF — downloaded from your banking app or website</span></p>
      <button class="btn primary" data-act="pick">Choose files</button>
      <p class="small muted" style="margin:10px 0 0">Several months at once? Long-press a file in the picker, then tap the others.</p>
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

  function reminderBanner() {
    const now = Date.now();
    if (!REMIND.isDue(remind, now)) return '';
    // Seen in the app, so the phone needn't notify about this month as well.
    const month = REMIND.monthKey(REMIND.lastDue(remind, now));
    if (remind.notified !== month) { remind.notified = month; writeRemind(); }
    return `<div class="card remind-banner" id="remind-banner" role="status">
      <p style="margin:0 0 10px">📅 <b>Time to load your bank statement</b><br>
        <span class="small muted">Download this month's statement from your bank, then load it here.</span></p>
      <div class="row" style="flex-wrap:wrap"><button class="btn primary small" data-act="pick">Load statement</button>
        <button class="btn small" data-act="remind-snooze">Remind me tomorrow</button></div>
    </div>`;
  }

  function reminderCard() {
    const r = remind;
    const days = [['', 'Off']].concat(Array.from({ length: 28 }, (_, i) => [String(i + 1), REMIND.ordinal(i + 1)]), [['last', 'Last day']]);
    const hours = [7, 8, 9, 12, 17, 18, 20, 21];
    const cur = r.day == null ? '' : String(r.day);
    const note = {
      on: '🔔 Your phone will show a notification on the day. Chrome decides exactly when to check, so it can arrive a few hours late.',
      blocked: "🔕 Notifications are blocked for this app, so you'll see the reminder when you open it. To allow them: long-press the app icon → App info → Notifications.",
      'no-install': "You'll see the reminder when you open the app. For a notification too, use the app from your home screen (installed) — or add it to your calendar below.",
      unsupported: "This browser can't show notifications for this app, so you'll see the reminder when you open it — or add it to your calendar below.",
      ask: "You'll see the reminder when you open the app. <button class=\"btn ghost small\" data-act=\"remind-notify\">Also notify me on my phone</button>",
    }[ui.notify] || '';
    return `<h3>Monthly reminder</h3>
      <div class="card">
        <p class="small muted" style="margin:0 0 10px">A nudge each month to download your statement and load it here. It goes away once you've loaded one.</p>
        <div class="row">
          <div class="grow"><label class="small muted" for="remind-day">Day</label>
            <select id="remind-day" style="margin-top:4px">${days.map(([v, l]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          <div class="grow"><label class="small muted" for="remind-hour">Time</label>
            <select id="remind-hour" style="margin-top:4px" ${r.day == null ? 'disabled' : ''}>${hours.map((h) => `<option value="${h}" ${h === +r.hour ? 'selected' : ''}>${REMIND.hourLabel(h)}</option>`).join('')}</select></div>
        </div>
        ${r.day == null ? '' : `<p class="small" style="margin:12px 0 0">Next: <b>${REMIND.nextDue(r, Date.now()).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}, ${REMIND.hourLabel(r.hour)}</b> <span class="muted">— ${REMIND.describe(r)}</span></p>
          ${note ? `<p class="small muted" style="margin:8px 0 0">${note}</p>` : ''}
          <button class="btn small" data-act="remind-ics" style="margin-top:10px">Add to my calendar</button>`}
      </div>`;
  }

  function howToExport() {
    return `<details class="card small"><summary>How do I get a CSV from my bank?</summary>
      <p class="muted">Look for <b>Export</b> or <b>Download transactions</b>:</p>
      <ul class="muted" style="padding-left:18px">
        <li><b>Monzo:</b> Account → Statements → Export → CSV</li>
        <li><b>Starling:</b> Account → Statements → choose dates → CSV</li>
        <li><b>NatWest:</b> in the app, open your account → <b>Statements</b> → pick a month → download the <b>PDF</b> and load it here. For a CSV, sign in to online banking on the website → <b>Statements</b> → <b>Download or export transactions</b> → choose dates → CSV.</li>
        <li><b>Barclays, HSBC, Lloyds, Santander, Nationwide:</b> sign in on the website → your account → Export / Download transactions → CSV or Excel CSV</li>
        <li><b>Credit cards</b> often show spending as positive numbers — tick “Flip signs” on the import screen.</li>
      </ul>
      <p class="muted"><b>PDF statements</b> work too — the same PDF you'd download from online banking. CSV is the most reliable, and scanned or photographed statements can't be read.</p>
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

  function shortName(merchant) {
    const n = SC.titleCase(merchant);
    return n.length > 16 ? n.slice(0, 15) + '…' : n;
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
          ${p.cat ? `<button class="btn small" data-catmonth="${esc(p.cat + '|' + p.month)}">See payments</button>`
            : p.month ? `<button class="btn small" data-month="${esc(p.month)}">See month</button>` : ''}
        </div>
      </div>`;
    }
    const t = a.txn;
    const keys = a.reasons.map((r) => r.key).join('\n');
    const mutes = a.reasons.map((r) => r.rule + '|' + t.merchant).join('\n');
    return `<div class="card alert ${a.severity}">
      <div class="row"><div class="grow">${sevTag(a.severity)}</div><div class="muted small nowrap">${niceDate(t.date)}</div></div>
      <div class="row" style="margin-top:6px">
        <div class="grow"><div style="font-weight:700" class="ellipsis">${esc(SC.titleCase(t.merchant))}</div>
          <div class="muted small ellipsis">${esc(t.desc)}</div></div>
        <div class="amt ${t.amount > 0 ? 'in' : ''}">${money(t.amount, true)}</div>
      </div>
      <div class="small" style="margin-top:4px"><button class="linkish" data-cat-txn="${esc(t.id)}" aria-label="Change category">${catPill(t)}</button>
      </div>
      <ul>${a.reasons.map((r) => `<li><b>${esc(r.title)}</b><span>${esc(r.detail)}</span></li>`).join('')}</ul>
      <div class="actions">
        ${a.dismissed ? `<button class="btn small" data-undismiss="${esc(keys)}" data-unmute="${esc(mutes)}">Undo “fine”</button>` : `<button class="btn small" data-dismiss="${esc(keys)}">It's fine</button>
        <button class="btn small" data-mute="${esc(mutes)}" title="Stop flagging ${esc(SC.titleCase(t.merchant))} for this">Never for ${esc(shortName(t.merchant))}</button>`}
        <button class="btn small" data-merchant="${esc(t.merchant)}">History</button>
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
    const toReview = CAT.guessesToReview(db.txns, cats).length;
    return `<div class="card" style="padding:12px 14px">
      <div class="row"><b class="grow">Categories</b>
        ${toSort ? `<button class="btn primary small" data-act="sort">Sort ${toSort} payee${toSort === 1 ? '' : 's'}</button>` : '<span class="small muted">All sorted ✓</span>'}</div>
      ${toReview ? `<button class="btn small block" data-act="review" style="margin-top:8px">Check ${toReview} guessed payee${toReview === 1 ? '' : 's'}</button>` : ''}
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
        <div class="grow"><div class="ellipsis">${flagged.has(t.id) ? '<span class="sev high" title="Flagged"><i aria-hidden="true"></i></span> ' : ''}${esc(SC.titleCase(t.merchant))}</div>
          <div class="muted small ellipsis">${catPill(t)} ${esc(t.desc)}</div></div>
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
      ${reminderCard()}
      ${lockCard()}
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

  // One file: its own review screen. Several: read them all, then one
  // screen for the batch.
  let pendingFiles = null;
  async function handleFiles(files) {
    if (lockMeta && !cryptoKey) { pendingFiles = files; return; } // opened via "Open with" while locked
    if (files.length > 1) return batchImport(files);
    if (/\.pdf$/i.test(files[0].name || '')) toast(`Reading ${files[0].name}…`);
    const e = await readFile(files[0]);
    const t = $('.toast');
    if (t && t.textContent.startsWith('Reading ')) t.remove();
    if (e.status === 'error') return toast(`${e.name}: ${e.note}`);
    let txns = e.txns;
    if (e.kind === 'pdf') txns = await pdfSheet(e.name, e.parsed);
    else if (e.kind === 'csv') txns = await mappingSheet(e.name, e.rows);
    if (txns) commit(e.name, txns);
  }

  // Reads and parses a file without any screens (bar a PDF password prompt).
  // status: ok (verified), info (looks right, can't be verified), warn
  // (something doesn't add up), error (can't be used).
  async function readFile(file) {
    const name = file.name || 'statement';
    const e = { name, kind: '', status: 'error', note: '', txns: [] };
    if (/\.(xlsx?|numbers)$/i.test(name)) { e.note = 'save the spreadsheet as CSV first'; return e; }
    if (file.size > 20 * 1024 * 1024) { e.note = 'too big (over 20 MB)'; return e; }
    if (/\.pdf$/i.test(name) || file.type === 'application/pdf') {
      e.kind = 'pdf';
      const pages = await readPdfPages(file, name);
      if (pages === 'cancelled') { e.note = 'password not entered'; return e; }
      if (!pages) { e.note = "couldn't be opened as a PDF"; return e; }
      const parsed = PDFS.parseStatement(pages);
      e.parsed = parsed;
      if (parsed.scanned) { e.note = 'a scanned image with no text, so it can’t be read'; return e; }
      if (!parsed.txns.length) { e.note = 'no transactions found'; return e; }
      e.txns = parsed.txns;
      if (!parsed.balanceChecked) { e.status = 'info'; e.note = 'no running balance to check against'; }
      else if (parsed.balanceOk === parsed.balanceChecked) { e.status = 'ok'; e.note = `all ${parsed.balanceChecked} balances add up`; }
      else { e.status = 'warn'; e.note = `${parsed.balanceChecked - parsed.balanceOk} of ${parsed.balanceChecked} balances don't add up`; }
      return e;
    }
    const text = await file.text();
    if (SC.looksLikeOFX(text) || SC.looksLikeQIF(text)) {
      e.kind = 'ofx';
      e.txns = SC.looksLikeOFX(text) ? SC.parseOFX(text) : SC.parseQIF(text);
      e.status = e.txns.length ? 'ok' : 'error';
      e.note = e.txns.length ? 'read directly from the file' : 'no transactions found';
      return e;
    }
    e.kind = 'csv';
    e.rows = SC.parseCSV(text);
    if (!e.rows.length) { e.note = 'looks empty'; return e; }
    const res = SC.applyMapping(e.rows, SC.guessMapping(e.rows));
    e.txns = res.txns;
    if (!e.txns.length) { e.status = 'warn'; e.note = "columns not recognised — tap Check to pick them"; return e; }
    e.status = 'info';
    e.note = `columns detected automatically${res.skipped ? `, ${res.skipped} rows skipped` : ''}`;
    return e;
  }

  const STATUS_ICON = { ok: '✅', info: 'ℹ️', warn: '⚠️', error: '❌' };

  async function batchImport(files) {
    const entries = [];
    const bg = document.createElement('div');
    bg.className = 'sheet-bg';
    bg.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="batch-title">
      <h2 id="batch-title">Import ${files.length} statements</h2><div id="batch-body"><p class="muted">Reading…</p></div></div>`;
    document.body.appendChild(bg);
    const sheet = $('.sheet', bg);
    const body = $('#batch-body', sheet);
    let closed = false;
    const close = () => { closed = true; bg.remove(); popBack = null; };
    popBack = close;

    for (let i = 0; i < files.length; i++) {
      body.innerHTML = `<p class="muted">Reading ${i + 1} of ${files.length}: ${esc(files[i].name)}…</p>`;
      const e = await readFile(files[i]);
      e.include = e.status !== 'error' && e.txns.length > 0;
      entries.push(e);
      if (closed) return;
    }

    const draw = () => {
      // What would be new: skip what's already loaded, and overlaps within the batch.
      const seen = new Set(db.txns.map((t) => t.id));
      let fresh = 0;
      let dupes = 0;
      const dates = [];
      for (const e of entries) {
        e.fresh = 0;
        if (!e.include) continue;
        for (const t of SC.assignIds(e.txns)) {
          if (db.deleted[t.id]) continue;
          if (seen.has(t.id)) dupes++; else { seen.add(t.id); fresh++; e.fresh++; dates.push(t.date); }
        }
      }
      dates.sort();
      const n = entries.filter((e) => e.include).length;
      body.innerHTML = `
        <div class="card" style="padding:4px 14px">${entries.map((e, i) => {
          const d = e.txns.map((t) => t.date).sort();
          return `<div class="tx" style="align-items:flex-start">
            <div style="font-size:20px;line-height:1.2" aria-hidden="true">${STATUS_ICON[e.status]}</div>
            <div class="grow"><div class="ellipsis"><b>${esc(e.name)}</b></div>
              <div class="small muted">${e.txns.length ? `${e.txns.length} transactions · ${niceDate(d[0])} – ${niceDate(d[d.length - 1])} · ` : ''}${esc(e.note)}${e.checked ? ' · checked by you' : ''}${e.include && e.txns.length && !e.fresh ? ' · <b>all already loaded</b>' : ''}</div>
              ${e.status !== 'error' ? `<div class="row" style="margin-top:6px;gap:12px">
                <label class="small" style="display:flex;gap:6px;align-items:center"><input type="checkbox" data-include="${i}" ${e.include ? 'checked' : ''} ${e.txns.length ? '' : 'disabled'}> Include</label>
                ${e.kind === 'pdf' || e.kind === 'csv' ? `<button class="btn small" data-check="${i}">${e.kind === 'csv' ? 'Check columns' : 'Check'}</button>` : ''}
              </div>` : ''}
            </div>
          </div>`;
        }).join('')}</div>
        <p class="small" style="margin:10px 0">${fresh
          ? `<b>${fresh} new transactions</b>${dates.length ? ` · ${niceDate(dates[0])} – ${niceDate(dates[dates.length - 1])}` : ''}${dupes ? ` · ${dupes} already loaded or overlapping, will be skipped` : ''}`
          : 'Nothing new to import.'}</p>
        ${entries.some((e) => e.include && e.status === 'warn') ? '<p class="small muted" style="margin:0 0 10px">⚠️ Files with balances that don’t add up can still be imported — the lines involved show up as alerts, and you can fix them with Edit details.</p>' : ''}
        <div class="row">
          <button class="btn grow" data-x="cancel">Cancel</button>
          <button class="btn primary grow" data-x="ok" ${fresh ? '' : 'disabled'}>Import ${n} file${n === 1 ? '' : 's'}</button>
        </div>`;
    };
    draw();

    sheet.addEventListener('change', (ev) => {
      const i = ev.target.dataset.include;
      if (i !== undefined) { entries[+i].include = ev.target.checked; draw(); }
    });
    sheet.addEventListener('click', async (ev) => {
      const b = ev.target.closest('button');
      if (!b) return;
      if (b.dataset.check !== undefined) {
        const e = entries[+b.dataset.check];
        const txns = e.kind === 'pdf' ? await pdfSheet(e.name, e.parsed) : await mappingSheet(e.name, e.rows);
        popBack = close;
        if (txns) { e.txns = txns; e.include = txns.length > 0; e.checked = true; if (e.status === 'warn' && e.kind === 'csv') e.status = 'info'; }
        return draw();
      }
      if (b.dataset.x === 'cancel') return close();
      if (b.dataset.x === 'ok') {
        const chosen = entries.filter((e) => e.include && e.txns.length).map((e) => ({ name: e.name, txns: e.txns }));
        close();
        commitMany(chosen);
      }
    });
    bg.addEventListener('click', (ev) => { if (ev.target === bg) close(); });
  }

  // ---------------------------------------------------------------- PDF ----

  let pdfjsLib = null;
  async function loadPdfjs() {
    if (!pdfjsLib) {
      pdfjsLib = await import('./vendor/pdfjs/pdf.min.mjs');
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.mjs';
    }
    return pdfjsLib;
  }

  async function readPdfPages(file, name) {
    try {
      const pdfjs = await loadPdfjs();
      const data = new Uint8Array(await file.arrayBuffer());
      let password;
      for (;;) {
        const task = pdfjs.getDocument({ data: data.slice(), password, isEvalSupported: false, verbosity: 0 });
        try {
          const pages = await PDFS.pagesFromPdf(await task.promise);
          await task.destroy();
          return pages;
        } catch (err) {
          await task.destroy();
          if (err && err.name === 'PasswordException') {
            password = prompt(err.code === 2 ? `Wrong password for ${name} — try again:` : `${name} is password protected. Enter its password (it stays on this device):`);
            if (password === null) return 'cancelled';
            continue;
          }
          throw err;
        }
      }
    } catch {
      return null;
    }
  }

  // What was read, and how sure we are: a statement with a running balance
  // can be checked line by line.
  function pdfSheet(name, parsed) {
    return new Promise((resolve) => {
      let flip = false;
      const dates = parsed.txns.map((t) => t.date).sort();
      const ok = parsed.balanceChecked > 0 && parsed.balanceOk === parsed.balanceChecked;
      const check = !parsed.balanceChecked
        ? `<div class="card small">ℹ️ <b>This statement has no running balance</b>, so the reading can't be double-checked automatically. Compare a few rows below with your statement.</div>`
        : ok
          ? `<div class="card small">✅ <b>All ${parsed.balanceChecked} running balances add up</b> — the amounts and in/out were read correctly.</div>`
          : `<div class="card small">⚠️ <b>${parsed.balanceChecked - parsed.balanceOk} of ${parsed.balanceChecked} balances don't add up.</b> Some lines may have been misread. After importing they'll show as “Balance doesn't add up” alerts, and you can fix them with Edit details.</div>`;
      const bg = document.createElement('div');
      bg.className = 'sheet-bg';
      bg.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="pdf-title">
        <h2 id="pdf-title">Check the PDF reading</h2>
        <p class="sub ellipsis">${esc(name)}</p>
        <p class="small" style="margin:0 0 8px"><b>${parsed.txns.length} transactions</b> · ${niceDate(dates[0])} – ${niceDate(dates[dates.length - 1])}</p>
        ${check}
        <label class="check"><input type="checkbox" id="p-flip"> Flip signs (if spending shows as money in)</label>
        <div id="p-preview" class="preview"></div>
        <div class="row">
          <button class="btn grow" data-x="cancel">Cancel</button>
          <button class="btn primary grow" data-x="ok">Import</button>
        </div>
      </div>`;
      document.body.appendChild(bg);
      const sheet = $('.sheet', bg);
      const current = () => parsed.txns.map((t) => (flip ? { ...t, amount: -t.amount } : t));
      const preview = () => {
        const list = current();
        const outs = list.filter((t) => t.amount < 0).length;
        const rows = list.length > 10 ? [...list.slice(0, 7), null, ...list.slice(-2)] : list;
        $('#p-preview', sheet).innerHTML = `<p class="small muted" style="margin:0 0 6px">${outs} money out, ${list.length - outs} money in.</p>
          <table class="data"><tbody>${rows.map((t) => t
            ? `<tr><td>${niceDate(t.date)}</td><td style="text-align:left;max-width:150px" class="ellipsis">${esc(t.desc)}</td><td>${money(t.amount, true)}</td></tr>`
            : '<tr><td colspan="3" style="text-align:center" class="muted">⋯</td></tr>').join('')}</tbody></table>`;
      };
      $('#p-flip', sheet).addEventListener('change', (e) => { flip = e.target.checked; preview(); });
      preview();
      let result = null;
      const prevBack = popBack;
      const close = () => { bg.remove(); popBack = prevBack; resolve(result); };
      popBack = close;
      sheet.addEventListener('click', (e) => {
        const x = e.target.closest('[data-x]');
        if (!x) return;
        if (x.dataset.x === 'ok') result = current();
        close();
      });
      bg.addEventListener('click', (e) => { if (e.target === bg) close(); });
    });
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
      let result = null;
      const prevBack = popBack;
      const close = () => { bg.remove(); popBack = prevBack; resolve(result); };
      popBack = close;
      sheet.addEventListener('click', (e) => {
        const x = e.target.closest('[data-x]');
        if (!x) return;
        if (x.dataset.x === 'ok') result = read().txns;
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
        <button class="btn grow" data-x="edit">Edit details</button>
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
      } else if (b.dataset.x === 'edit') { sh.close(); openEditor(t.id); }
      else if (b.dataset.x === 'close') sh.close();
    });
  }

  // Fix what the statement or the app got wrong. The id is left alone, so
  // importing the same statement again doesn't bring the original back.
  function openEditor(id) {
    const t = db.txns.find((x) => x.id === id);
    if (!t) return;
    const name = SC.titleCase(t.merchant);
    const same = db.txns.filter((x) => x.merchant === t.merchant).length;
    const out = t.amount < 0;
    const sh = openSheet(`
      <h2>Edit transaction</h2>
      <p class="sub">Fix anything that's wrong. Your changes stick, even if you load the same statement again.</p>
      <div class="map-grid">
        <label for="e-date">Date</label><input type="date" id="e-date" class="field" value="${esc(t.date)}">
        <label for="e-desc">Description</label><input id="e-desc" class="field" maxlength="200" value="${esc(t.desc)}">
        <label for="e-amt">Amount</label>
        <div class="row"><select id="e-dir" class="field" style="width:auto" aria-label="Direction">
            <option value="out" ${out ? 'selected' : ''}>Out</option><option value="in" ${out ? '' : 'selected'}>In</option></select>
          <input id="e-amt" class="field grow" type="number" inputmode="decimal" step="0.01" min="0.01" value="${Math.abs(t.amount).toFixed(2)}"></div>
        <label for="e-payee">Payee</label><input id="e-payee" class="field" maxlength="60" value="${esc(name)}">
      </div>
      <p class="small muted">The payee groups payments for alerts, history and categories. Rename it to merge payees the app split up — e.g. give “Amzn Mktp” the name “Amazon Marketplace”.</p>
      ${same > 1 ? `<label class="check"><input type="checkbox" id="e-all" checked> Rename all ${same} payments from ${esc(name)}, and future imports</label>` : ''}
      <div class="row" style="margin-top:10px">
        <button class="btn danger" data-x="delete">Delete</button>
        <button class="btn grow" data-x="close">Cancel</button>
        <button class="btn primary grow" data-x="save">Save</button>
      </div>`);
    sh.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-x]');
      if (!b) return;
      if (b.dataset.x === 'close') return sh.close();
      if (b.dataset.x === 'delete') {
        if (!confirm('Delete this transaction? It stays deleted if you import the statement again.')) return;
        db.deleted[t.id] = Date.now();
        db.txns = db.txns.filter((x) => x.id !== t.id);
        save(); reanalyse(); sh.close();
        return toast('Transaction deleted.');
      }
      const date = $('#e-date', sh.el).value;
      const amt = parseFloat($('#e-amt', sh.el).value);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return toast('Enter a valid date.');
      if (!(amt > 0)) return toast('Enter an amount above zero.');
      t.date = date;
      t.amount = Math.round(amt * 100) / 100 * ($('#e-dir', sh.el).value === 'out' ? -1 : 1);
      t.desc = $('#e-desc', sh.el).value.trim().replace(/\s+/g, ' ') || t.desc;
      t.edited = true;
      const newKey = $('#e-payee', sh.el).value.trim().toLowerCase().replace(/\s+/g, ' ');
      if (newKey && newKey !== t.merchant) renamePayee(t, newKey, same === 1 || $('#e-all', sh.el).checked);
      save(); reanalyse(); sh.close();
      toast('Saved.');
    });
  }

  // Renaming everywhere carries the payee's category rules and "never flag"
  // choices across, and records an alias so future imports follow it.
  function renamePayee(t, newKey, all) {
    const old = t.merchant;
    if (!all) { t.merchant = newKey; return; }
    for (const x of db.txns) if (x.merchant === old) x.merchant = newKey;
    for (const k of Object.keys(db.aliases)) if (db.aliases[k] === old) db.aliases[k] = newKey;
    db.aliases[old] = newKey;
    for (const k of Object.keys(db.aliases)) if (db.aliases[k] === k) delete db.aliases[k];
    for (const dir of ['out', 'in']) {
      const from = dir + '|' + old;
      const to = dir + '|' + newKey;
      if (db.cats.payeeCats[from]) {
        if (!db.cats.payeeCats[to]) db.cats.payeeCats[to] = db.cats.payeeCats[from];
        delete db.cats.payeeCats[from];
      }
    }
    for (const k of Object.keys(db.mutes)) {
      const i = k.indexOf('|');
      if (k.slice(i + 1) === old) { db.mutes[k.slice(0, i + 1) + newKey] = db.mutes[k]; delete db.mutes[k]; }
    }
  }

  // Walk through uncategorised payees, biggest first. Each answer retrains
  // the guesses, so later suggestions get better as you go.
  function openSort(mode) {
    const review = mode === 'review';
    const skipped = new Set();
    let done = 0;
    const sh = openSheet('<div id="sort-body"></div>');
    const body = $('#sort-body', sh.el);
    const step = () => {
      const queue = (review ? CAT.guessesToReview(db.txns, cats) : CAT.payeesToSort(db.txns, db.cats, cats)).filter((g) => !skipped.has(g.key));
      if (!queue.length) {
        body.innerHTML = `<div class="empty" style="padding:20px 0"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-6"/></svg>
          <p><b>${done ? `${done} payee${done === 1 ? '' : 's'} ${review ? 'checked' : 'sorted'}.` : `Nothing left to ${review ? 'check' : 'sort'}.`}</b><br>New statements will be categorised automatically from what you've taught it.</p></div>
          <button class="btn primary block" data-x="close">Done</button>`;
        return;
      }
      const g = queue[0];
      const sample = g.txns[0];
      const guess = cats.get(sample.id);
      const gc = guess.source === 'guess' ? catById(guess.cat) : null;
      body.innerHTML = `<p class="small muted" style="margin:0">${review ? 'Checking the app’s guesses' : 'Sorting payees'} · ${done} done · ${queue.length} to go · each answer teaches the app</p>
        <div class="card">
          <div class="small muted">${g.dir === 'out' ? 'Money out to' : 'Money in from'}</div>
          <div style="font-size:20px;font-weight:700">${esc(SC.titleCase(g.merchant))}</div>
          <div class="muted small">${g.txns.length} payment${g.txns.length === 1 ? '' : 's'} · ${money(g.total)} total · e.g. “${esc(sample.desc)}”</div>
          ${gc ? `<div class="small" style="margin-top:8px">🧠 Suggested: <b>${esc(gc.icon + ' ' + gc.name)}</b> <span class="muted">(${Math.round(guess.confidence * 100)}% sure)</span></div>` : ''}
        </div>
        ${review && gc ? `<button class="btn primary block" data-pick="${esc(gc.id)}" style="margin-top:4px">✓ Yes, ${esc(gc.name)}</button>
          <p class="small muted" style="margin:12px 0 0">Wrong? Pick the right one:</p>` : ''}
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
    commitMany([{ name, txns: parsed }]);
  }

  // Adds files' transactions, skipping any already loaded (overlapping
  // statements) or deleted by you, then reports once.
  function commitMany(files) {
    let added = 0;
    let dupes = 0;
    let filesAdded = 0;
    for (const f of files) {
      if (!f.txns.length) continue;
      const importId = 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const existing = new Set(db.txns.map((t) => t.id));
      const fresh = [];
      let removed = 0;
      SC.assignIds(f.txns).forEach((t, seq) => {
        if (db.deleted[t.id]) { removed++; return; }
        if (!existing.has(t.id)) fresh.push({ ...t, merchant: db.aliases[t.merchant] || t.merchant, importId, seq });
      });
      const d = f.txns.length - fresh.length - removed;
      dupes += d;
      if (!fresh.length) continue; // nothing new: don't list an empty import
      const dates = f.txns.map((t) => t.date).sort();
      db.imports.push({ id: importId, name: f.name, count: fresh.length, dupes: d, from: dates[0], to: dates[dates.length - 1], added: new Date().toISOString() });
      db.txns.push(...fresh);
      added += fresh.length;
      filesAdded++;
    }
    if (!files.some((f) => f.txns.length)) { toast('No transactions found.'); return; }
    remind.lastImport = Date.now();
    remind.snoozeUntil = 0;
    writeRemind();
    save();
    reanalyse();
    toast(`Loaded ${added} transaction${added === 1 ? '' : 's'}${filesAdded > 1 ? ` from ${filesAdded} files` : ''}${dupes ? ` (${dupes} already loaded, skipped)` : ''}.`);
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
      db = Object.assign(blank(), data);
      delete db.app; delete db.version; delete db.saved;
      if (!db.cats || !Array.isArray(db.cats.list)) db.cats = CAT.freshState();
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
    if (d.mute) {
      d.mute.split('\n').forEach((k) => { db.mutes[k] = Date.now(); });
      save(); recategorise(); render();
      return toast("Won't flag this payee for that again. Undo at the bottom of Alerts.");
    }
    if (d.catmonth) {
      const [c, m] = d.catmonth.split('|');
      ui.cat = c; ui.q = m; ui.txFilter = 'out';
      return go('transactions');
    }
    if (d.undismiss) {
      d.undismiss.split('\n').forEach((k) => { delete db.dismissed[k]; });
      (d.unmute || '').split('\n').forEach((k) => { delete db.mutes[k]; });
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
      case 'pick': restoring = false; fileInput.accept = '.pdf,.csv,.ofx,.qfx,.qif,.txt,application/pdf,text/csv'; fileInput.multiple = true; fileInput.click(); break;
      case 'restore': restoring = true; fileInput.accept = '.json,application/json'; fileInput.multiple = false; fileInput.click(); break;
      case 'sample': commit('Sample current account.csv', SC.applyMapping(SC.parseCSV(SC.sampleCSV()), SC.guessMapping(SC.parseCSV(SC.sampleCSV()))).txns); break;
      case 'toggle-dismissed': ui.showDismissed = !ui.showDismissed; reanalyse(); render(); break;
      case 'more': ui.txLimit += 300; render(); break;
      case 'chart-table': ui.chartTable = !ui.chartTable; render(); break;
      case 'backup': backup(); break;
      case 'lock-now': lockNow(); break;
      case 'lock-on': setupCode(); break;
      case 'lock-change': changeCode(); break;
      case 'lock-off': turnOffCode(); break;
      case 'sort': openSort(); break;
      case 'review': openSort('review'); break;
      case 'export-csv': exportCSV(); break;
      case 'remind-snooze':
        remind.snoozeUntil = REMIND.snoozeTime(remind, Date.now());
        writeRemind(); render();
        toast(`OK — I'll remind you tomorrow at ${REMIND.hourLabel(remind.hour)}.`);
        break;
      case 'remind-notify': setupNotifications(true).then(render); break;
      case 'remind-ics':
        download(REMIND.icsEvent(remind, Date.now()), 'text/calendar', 'statement-reminder.ics');
        toast('Open the downloaded file to add it to your calendar.');
        break;
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
        db = Object.assign(blank(), { settings: db.settings });
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
    if (e.target.id === 'lock-timeout') { lockMeta.timeout = +e.target.value; writeMeta(); return toast('Saved.'); }
    if (e.target.id === 'remind-day' || e.target.id === 'remind-hour') {
      const wasOff = remind.day == null;
      const v = $('#remind-day').value;
      remind.day = v === '' ? null : v === 'last' ? 'last' : +v;
      remind.hour = +$('#remind-hour').value;
      // Count from now, so switching it on doesn't nag about last month.
      if (wasOff && remind.day != null) remind.lastImport = Math.max(remind.lastImport, Date.now());
      remind.snoozeUntil = 0;
      writeRemind();
      render();
      if (remind.day == null) { setupNotifications(false); return toast('Reminder off.'); }
      toast(`I'll remind you on ${REMIND.describe(remind)}.`);
      setupNotifications(wasOff).then(() => { if (tab === 'files' && $('#remind-day')) render(); });
      return;
    }
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

  // --------------------------------------------------------------- lock ----

  // A 6-dot code entry with an on-screen keypad (and keyboard support).
  // onComplete(code) resolves true to finish, or a message to show and retry.
  function codePad(host, { title, sub, onComplete, footer }) {
    let code = '';
    let busy = false;
    host.innerHTML = `<div class="pad">
      <h2 class="pad-title">${esc(title)}</h2>
      <p class="sub pad-sub">${esc(sub || '')}</p>
      <div class="dots" aria-hidden="true">${'<i></i>'.repeat(6)}</div>
      <p class="pad-msg" role="alert"></p>
      <div class="keys">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button data-k="${n}">${n}</button>`).join('')}
        <span></span><button data-k="0">0</button><button data-k="del" aria-label="Delete">⌫</button></div>
      ${footer || ''}
    </div>`;
    const dots = host.querySelectorAll('.dots i');
    const msg = $('.pad-msg', host);
    const paint = () => dots.forEach((d, i) => d.classList.toggle('on', i < code.length));
    const press = async (k) => {
      if (busy) return;
      if (k === 'del') code = code.slice(0, -1);
      else if (code.length < 6) code += k;
      paint();
      if (code.length < 6) return;
      busy = true;
      msg.textContent = '';
      host.classList.add('busy');
      const r = await onComplete(code);
      host.classList.remove('busy');
      busy = false;
      if (r === true) return;
      code = '';
      paint();
      msg.textContent = r || '';
      if (!r) return; // a step done (e.g. first entry of a new code), not a mistake
      const d = $('.dots', host);
      d.classList.remove('shake');
      void d.offsetWidth;
      d.classList.add('shake');
    };
    host.addEventListener('click', (e) => {
      const b = e.target.closest('[data-k]');
      if (b) press(b.dataset.k);
    });
    const onKey = (e) => {
      if (!host.isConnected) return document.removeEventListener('keydown', onKey);
      if (/^\d$/.test(e.key)) { e.preventDefault(); press(e.key); }
      else if (e.key === 'Backspace') { e.preventDefault(); press('del'); }
    };
    document.addEventListener('keydown', onKey);
    return { setTitle: (t, sb) => { $('.pad-title', host).textContent = t; $('.pad-sub', host).textContent = sb || ''; }, setMsg: (m) => { msg.textContent = m; } };
  }

  function showLockScreen() {
    if ($('#lockscreen')) return;
    const el = document.createElement('div');
    el.id = 'lockscreen';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'Unlock Statement Check');
    document.body.appendChild(el);
    document.body.classList.add('locked');
    let timer = null;
    const pad = codePad(el, {
      title: 'Statement Check',
      sub: 'Enter your 6-digit code',
      footer: '<button class="btn ghost small" data-forgot="1" style="margin-top:18px">Forgot your code?</button>',
      onComplete: async (code) => {
        const wait = (lockMeta.until || 0) - Date.now();
        if (wait > 0) return waitMessage(wait);
        pad.setMsg('Unlocking…');
        try {
          const key = await LOCK.deriveKey(code, lockMeta.salt, lockMeta.iter);
          const blob = JSON.parse(localStorage.getItem(ENC_KEY) || 'null');
          const data = blob ? JSON.parse(await LOCK.decryptText(key, blob)) : null;
          cryptoKey = key;
          lockMeta.fails = 0;
          lockMeta.until = 0;
          writeMeta();
          adopt(data);
          try { const t = localStorage.getItem(KEY + '.tab'); if (t) tab = t; } catch { /* ignore */ }
          clearInterval(timer);
          el.remove();
          document.body.classList.remove('locked');
          reanalyse();
          render();
          if (pendingFiles) { const f = pendingFiles; pendingFiles = null; handleFiles(f); }
          return true;
        } catch {
          lockMeta.fails = (lockMeta.fails || 0) + 1;
          const ms = LOCK.lockoutMs(lockMeta.fails);
          lockMeta.until = ms ? Date.now() + ms : 0;
          writeMeta();
          if (ms) { tick(); return waitMessage(ms); }
          const left = LOCK.MAX_FREE_TRIES - lockMeta.fails;
          return `Wrong code. ${left} ${left === 1 ? 'try' : 'tries'} before a short wait.`;
        }
      },
    });
    function waitMessage(ms) {
      const sec = Math.ceil(ms / 1000);
      return `Too many wrong codes. Try again in ${sec >= 60 ? Math.ceil(sec / 60) + ' min' : sec + 's'}.`;
    }
    function tick() {
      clearInterval(timer);
      timer = setInterval(() => {
        const left = (lockMeta.until || 0) - Date.now();
        if (left <= 0) { clearInterval(timer); pad.setMsg(''); return; }
        pad.setMsg(waitMessage(left));
      }, 1000);
    }
    if ((lockMeta.until || 0) > Date.now()) { pad.setMsg(waitMessage(lockMeta.until - Date.now())); tick(); }
    el.addEventListener('click', (e) => {
      if (!e.target.closest('[data-forgot]')) return;
      if (!confirm('There is no way to recover the code — it is the key that unlocks your data.\n\nYou can delete everything in this app and start again. Restore a backup afterwards if you saved one.')) return;
      if (!confirm('Delete all statements, categories and settings on this phone?')) return;
      try { [KEY, ENC_KEY, META_KEY].forEach((k) => localStorage.removeItem(k)); } catch { /* ignore */ }
      lockMeta = null;
      cryptoKey = null;
      clearInterval(timer);
      el.remove();
      document.body.classList.remove('locked');
      load(); reanalyse(); go('files');
      toast('Everything was deleted. You can set a new code in Statements → App lock.');
    });
  }

  async function lockNow() {
    if (!lockMeta || !cryptoKey) return;
    await saving; // finish writing before the key is dropped
    cryptoKey = null;
    adopt(null);
    result = null;
    cats = new Map();
    document.querySelectorAll('.sheet-bg, .toast').forEach((x) => x.remove());
    popBack = null;
    view.innerHTML = '';
    $('#alert-badge').hidden = true;
    showLockScreen();
  }

  // Ask for the current code, resolving with its key (or null if cancelled).
  function askCurrentCode(title) {
    return new Promise((resolve) => {
      const sh = openSheet('<div class="pad-host"></div><button class="btn block" data-x="close" style="margin-top:8px">Cancel</button>');
      let done = false;
      codePad($('.pad-host', sh.el), {
        title,
        sub: 'Enter your current code',
        onComplete: async (code) => {
          try {
            const key = await LOCK.deriveKey(code, lockMeta.salt, lockMeta.iter);
            await LOCK.decryptText(key, JSON.parse(localStorage.getItem(ENC_KEY)));
            done = true;
            sh.close();
            resolve(key);
            return true;
          } catch { return 'Wrong code.'; }
        },
      });
      sh.el.addEventListener('click', (e) => { if (e.target.closest('[data-x="close"]')) { sh.close(); } });
      const obs = new MutationObserver(() => { if (!sh.el.isConnected) { obs.disconnect(); if (!done) resolve(null); } });
      obs.observe(document.body, { childList: true });
    });
  }

  // Choose a new code (twice), then encrypt everything with it.
  function chooseNewCode(title) {
    return new Promise((resolve) => {
      const sh = openSheet('<div class="pad-host"></div><button class="btn block" data-x="close" style="margin-top:8px">Cancel</button>');
      let first = null;
      let done = false;
      const pad = codePad($('.pad-host', sh.el), {
        title,
        sub: 'Choose a 6-digit code',
        onComplete: async (code) => {
          if (!first) {
            if (LOCK.isWeakCode(code)) return 'Too easy to guess — avoid repeated or sequential digits.';
            first = code;
            pad.setTitle(title, 'Enter the same code again');
            return '';
          }
          if (code !== first) { first = null; pad.setTitle(title, 'Choose a 6-digit code'); return "Codes didn't match — start again."; }
          pad.setMsg('Encrypting your data…');
          const salt = LOCK.randomSalt();
          const key = await LOCK.deriveKey(code, salt, LOCK.ITERATIONS);
          const blob = await LOCK.encryptText(key, JSON.stringify(db));
          JSON.parse(await LOCK.decryptText(key, blob)); // check before relying on it
          try { localStorage.setItem(ENC_KEY, JSON.stringify(blob)); } catch { return "Couldn't save — storage may be full."; }
          const timeout = lockMeta ? lockMeta.timeout : 60000;
          lockMeta = { v: 1, salt, iter: LOCK.ITERATIONS, timeout, fails: 0, until: 0 };
          writeMeta();
          cryptoKey = key;
          try { localStorage.removeItem(KEY); } catch { /* ignore */ }
          done = true;
          sh.close();
          resolve(true);
          return true;
        },
      });
      sh.el.addEventListener('click', (e) => { if (e.target.closest('[data-x="close"]')) sh.close(); });
      const obs = new MutationObserver(() => { if (!sh.el.isConnected) { obs.disconnect(); if (!done) resolve(false); } });
      obs.observe(document.body, { childList: true });
    });
  }

  async function setupCode() {
    if (await chooseNewCode('Set an app code')) { render(); toast('Code set. Your data is now encrypted on this phone.'); }
  }

  async function changeCode() {
    if (!(await askCurrentCode('Change code'))) return;
    await saving;
    if (await chooseNewCode('Change code')) { render(); toast('Code changed.'); }
  }

  async function turnOffCode() {
    if (!(await askCurrentCode('Turn off app lock'))) return;
    await saving;
    try { localStorage.setItem(KEY, JSON.stringify(db)); } catch { return toast("Couldn't save — storage may be full."); }
    try { localStorage.removeItem(ENC_KEY); } catch { /* ignore */ }
    lockMeta = null;
    cryptoKey = null;
    writeMeta();
    render();
    toast('App lock turned off. Your data is no longer encrypted.');
  }

  function lockCard() {
    const t = lockMeta ? lockMeta.timeout : 60000;
    const opt = (v, l) => `<option value="${v}" ${t === v ? 'selected' : ''}>${l}</option>`;
    return `<h3>App lock</h3>
      <div class="card">
        ${lockMeta
          ? `<p class="small" style="margin:0 0 10px">🔒 <b>On.</b> <span class="muted">Your data is encrypted with your 6-digit code. Without it, what's saved on this phone is unreadable.</span></p>
            <label class="small muted" for="lock-timeout">Lock when I leave the app</label>
            <select id="lock-timeout" style="margin:4px 0 12px">${opt(0, 'Immediately')}${opt(60000, 'After 1 minute')}${opt(300000, 'After 5 minutes')}${opt(900000, 'After 15 minutes')}</select>
            <div class="row" style="flex-wrap:wrap"><button class="btn small" data-act="lock-change">Change code</button><button class="btn small" data-act="lock-off">Turn off</button></div>`
          : `<p class="small muted" style="margin:0 0 10px">Ask for a 6-digit code each time the app opens. Your data is also encrypted with it, so it can't be read without the code.</p>
            <button class="btn primary small" data-act="lock-on">Set a code</button>`}
        <p class="small muted" style="margin:10px 0 0">There's no way to recover a forgotten code. Keep a backup (above) somewhere safe — backups are <b>not</b> encrypted.</p>
      </div>`;
  }

  // Leaving the app: hide the contents from the app switcher, and lock
  // after the chosen time away.
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      document.body.classList.add('privacy');
      hiddenAt = Date.now();
      if (lockMeta && cryptoKey && !lockMeta.timeout) lockNow();
    } else {
      document.body.classList.remove('privacy');
      if (lockMeta && cryptoKey && Date.now() - hiddenAt >= lockMeta.timeout) lockNow();
      else if ((!lockMeta || cryptoKey) && !$('#remind-banner') && REMIND.isDue(remind, Date.now())) render();
    }
  });

  // ------------------------------------------------------------- start ----

  if (lockMeta) showLockScreen();
  else { load(); reanalyse(); render(); }

  // Ask the browser not to evict our data under storage pressure.
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js')
      .then(() => { syncRemind(); return setupNotifications(false); })
      .then(() => { if (tab === 'files' && $('#remind-day') && (!lockMeta || cryptoKey)) render(); })
      .catch(() => {});
  }
})();
