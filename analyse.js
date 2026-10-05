/*
 * Statement Check — parsing and anomaly detection.
 *
 * Pure functions, no DOM. Loaded by index.html in the browser and by the
 * Node tests, so everything hangs off one exported object.
 *
 * Sign convention throughout: amount < 0 is money out, amount > 0 is money in.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- CSV ----

  function detectDelimiter(text) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 15);
    let best = ',';
    let bestScore = -1;
    for (const d of [',', ';', '\t', '|']) {
      const counts = lines.map((l) => splitLine(l, d).length);
      const multi = counts.filter((c) => c > 1).length;
      const score = multi * 10 + Math.max(0, ...counts);
      if (score > bestScore) { bestScore = score; best = d; }
    }
    return best;
  }

  // Only used for delimiter sniffing; the real parser handles multi-line quotes.
  function splitLine(line, d) {
    const out = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') q = !q;
      else if (c === d && !q) { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out;
  }

  function parseCSV(text, delim) {
    text = text.replace(/^\uFEFF/, '');
    const d = delim || detectDelimiter(text);
    const rows = [];
    let row = [];
    let cell = '';
    let q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') {
          if (text[i + 1] === '"') { cell += '"'; i++; } else q = false;
        } else cell += c;
      } else if (c === '"') q = true;
      else if (c === d) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ''));
  }

  // ------------------------------------------------------------ values ----

  function parseAmount(raw) {
    if (raw == null) return null;
    let s = String(raw).trim();
    if (!s) return null;
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1).trim(); }
    const drcr = s.match(/\s*(DR|CR|D|C)\.?$/i);
    if (drcr && /\d/.test(s.slice(0, drcr.index))) {
      if (/^d/i.test(drcr[1])) neg = !neg;
      s = s.slice(0, drcr.index);
    }
    s = s.replace(/GBP|EUR|USD|AUD|CAD|NZD|[£$€¥\s\u00a0]/gi, '');
    if (/-$/.test(s)) { neg = !neg; s = s.slice(0, -1); }
    if (s.startsWith('+')) s = s.slice(1);
    if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
    // European style 1.234,56 or 12,50
    if (/,\d{1,2}$/.test(s) && s.lastIndexOf('.') < s.lastIndexOf(',')) {
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      s = s.replace(/,/g, '');
    }
    if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return null;
    const v = parseFloat(s);
    return neg ? -v : v;
  }

  const MONTHS = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  };

  function monthFromName(name) {
    const k = name.toLowerCase();
    return MONTHS[k] || MONTHS[k.slice(0, 4)] || MONTHS[k.slice(0, 3)] || 0;
  }

  function fullYear(y) {
    const n = parseInt(y, 10);
    if (y.length <= 2) return n < 70 ? 2000 + n : 1900 + n;
    return n;
  }

  function iso(y, m, d) {
    if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1970 && y <= 2100)) return null;
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCMonth() !== m - 1) return null; // 31 Feb etc.
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  // order: 'DMY' (UK default) or 'MDY' — only matters for all-numeric dates.
  function parseDate(raw, order) {
    if (raw == null) return null;
    const s = String(raw).trim();
    let m;
    if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) return iso(+m[1], +m[2], +m[3]);
    if ((m = s.match(/^(\d{4})(\d{2})(\d{2})/))) return iso(+m[1], +m[2], +m[3]); // OFX 20260131
    if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/))) {
      const y = fullYear(m[3]);
      return order === 'MDY' ? iso(y, +m[1], +m[2]) : iso(y, +m[2], +m[1]);
    }
    if ((m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s\-/.]*([A-Za-z]{3,9})[\s\-/.,]*(\d{2,4})\b/))) {
      return iso(fullYear(m[3]), monthFromName(m[2]), +m[1]);
    }
    if ((m = s.match(/^(?:[A-Za-z]{3,9},?\s+)?([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/))) {
      return iso(+m[3], monthFromName(m[1]), +m[2]);
    }
    return null;
  }

  function detectDateOrder(values) {
    let dmy = 0;
    let mdy = 0;
    for (const v of values) {
      const m = String(v || '').trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.]\d{2,4}/);
      if (!m) continue;
      if (+m[1] > 12) dmy++;
      if (+m[2] > 12) mdy++;
    }
    return mdy > dmy ? 'MDY' : 'DMY';
  }

  // ------------------------------------------------------- column guess ----

  function guessMapping(rows) {
    let headerIdx = -1;
    for (let i = 0; i < Math.min(30, rows.length); i++) {
      const r = rows[i];
      const filled = r.filter((c) => c !== '').length;
      if (filled >= 2 && r.some((c) => /date/i.test(c)) && !r.some((c) => parseDate(c, 'DMY'))) {
        headerIdx = i;
        break;
      }
    }
    if (headerIdx < 0) {
      // No "date" heading (other languages, odd exports): the all-text row
      // right before the first dated row is the header.
      const first = rows.findIndex((r) => r.some((c) => parseDate(c, 'DMY')));
      const prev = rows[first - 1];
      if (first > 0 && prev.length >= 2 && !prev.some((c) => parseDate(c, 'DMY') || parseAmount(c) !== null)) headerIdx = first - 1;
    }
    const headers = headerIdx >= 0 ? rows[headerIdx] : null;
    const body = rows.slice(headerIdx + 1);
    const ncols = Math.max(0, ...body.slice(0, 50).map((r) => r.length), headers ? headers.length : 0);
    const sample = body.slice(0, 200);
    const order = detectDateOrder(sample.flatMap((r) => r));

    const stats = [];
    for (let c = 0; c < ncols; c++) {
      const vals = sample.map((r) => r[c] || '');
      const nonEmpty = vals.filter((v) => v !== '');
      const n = nonEmpty.length || 1;
      const dates = nonEmpty.filter((v) => parseDate(v, order)).length / n;
      const nums = nonEmpty.filter((v) => parseAmount(v) !== null).length / n;
      const negs = nonEmpty.filter((v) => (parseAmount(v) || 0) < 0).length / n;
      const textLen = nonEmpty.filter((v) => parseAmount(v) === null).reduce((a, v) => a + v.length, 0) / n;
      stats.push({ dates, nums, negs, textLen, fill: nonEmpty.length / (vals.length || 1) });
    }

    const map = { date: -1, desc: -1, amount: -1, debit: -1, credit: -1, balance: -1 };
    const used = new Set();
    const take = (key, idx) => { if (idx >= 0 && !used.has(idx)) { map[key] = idx; used.add(idx); } };
    const findHeader = (re, not) => {
      if (!headers) return -1;
      return headers.findIndex((h, i) => !used.has(i) && re.test(h) && !(not && not.test(h)));
    };

    if (headers) {
      // Prefer the transaction date over a posting / value date if both exist.
      let d = findHeader(/trans.*date|date.*trans|completed/i);
      if (d < 0 || stats[d].dates < 0.5) d = findHeader(/date/i);
      take('date', d);
      take('balance', findHeader(/balance/i));
      take('debit', findHeader(/debit|paid out|money out|withdraw|spent|^out$|outgoing/i, /credit|card|type/i));
      take('credit', findHeader(/credit|paid in|money in|deposit|received|^in$|incoming/i, /card|type|debit/i));
      take('amount', findHeader(/^amount$|^amount\b|^value$|^sum$/i, /local|original|foreign/i));
      if (map.amount < 0) take('amount', findHeader(/amount|value/i, /local|original|foreign/i));
      take('desc', findHeader(/description|narrative|details|particulars/i));
      if (map.desc < 0) take('desc', findHeader(/name|payee|merchant|counter ?party|beneficiary/i));
      if (map.desc < 0) take('desc', findHeader(/memo|reference|transaction/i, /date|type|id$/i));
      // A lone debit column with a signed amount column elsewhere is not a split layout.
      if (map.amount >= 0 && (map.debit < 0 || map.credit < 0)) {
        if (map.debit >= 0) { used.delete(map.debit); map.debit = -1; }
        if (map.credit >= 0) { used.delete(map.credit); map.credit = -1; }
      }
      if (map.amount >= 0 && map.debit >= 0 && map.credit >= 0) {
        used.delete(map.amount); map.amount = -1;
      }
    }

    // Fill gaps from the content itself.
    if (map.date < 0) {
      let best = -1;
      stats.forEach((s, i) => { if (!used.has(i) && s.dates > 0.6 && (best < 0 || s.dates > stats[best].dates)) best = i; });
      take('date', best);
    }
    if (map.amount < 0 && (map.debit < 0 || map.credit < 0)) {
      const numeric = stats.map((s, i) => i).filter((i) => !used.has(i) && stats[i].nums > 0.8 && stats[i].dates < 0.5);
      const sparse = numeric.filter((i) => stats[i].fill < 0.9);
      if (map.balance < 0 && numeric.length >= 2 && sparse.length < 2) take('balance', numeric[numeric.length - 1]);
      if (sparse.length >= 2) { take('debit', sparse[0]); take('credit', sparse[1]); }
      else {
        const left = numeric.filter((i) => !used.has(i));
        const signed = left.find((i) => stats[i].negs > 0);
        take('amount', signed !== undefined ? signed : left[0] !== undefined ? left[0] : -1);
      }
    }
    if (map.desc < 0) {
      let best = -1;
      stats.forEach((s, i) => { if (!used.has(i) && s.textLen > 0 && (best < 0 || s.textLen > stats[best].textLen)) best = i; });
      take('desc', best);
    }

    return { headerIdx, headers, ncols, map, dateOrder: order, flip: false };
  }

  // ----------------------------------------------------------- mapping ----

  function applyMapping(rows, cfg) {
    const { map, dateOrder, flip, headerIdx } = cfg;
    const txns = [];
    let skipped = 0;
    rows.slice(headerIdx + 1).forEach((r) => {
      const date = map.date >= 0 ? parseDate(r[map.date], dateOrder) : null;
      let amount = null;
      if (map.amount >= 0) amount = parseAmount(r[map.amount]);
      else if (map.debit >= 0 || map.credit >= 0) {
        const dr = map.debit >= 0 ? parseAmount(r[map.debit]) : null;
        const cr = map.credit >= 0 ? parseAmount(r[map.credit]) : null;
        if (dr !== null || cr !== null) amount = (cr ? Math.abs(cr) : 0) - (dr ? Math.abs(dr) : 0);
      }
      if (!date || amount === null || amount === 0) { skipped++; return; }
      if (flip) amount = -amount;
      let desc = map.desc >= 0 ? r[map.desc] || '' : '';
      if (!desc) desc = r.filter((c, i) => i !== map.date && parseAmount(c) === null && c).join(' ') || '(no description)';
      const balance = map.balance >= 0 ? parseAmount(r[map.balance]) : null;
      txns.push({ date, desc: desc.replace(/\s+/g, ' ').trim(), amount: round2(amount), balance });
    });
    return { txns, skipped };
  }

  // ---------------------------------------------------------------- OFX ----

  function parseOFX(text) {
    const txns = [];
    const blocks = text.split(/<STMTTRN>/i).slice(1);
    for (const b of blocks) {
      const body = b.split(/<\/STMTTRN>/i)[0];
      const tag = (t) => {
        const m = body.match(new RegExp('<' + t + '>([^<\\r\\n]*)', 'i'));
        return m ? m[1].trim() : '';
      };
      const date = parseDate(tag('DTPOSTED'), 'DMY');
      const amount = parseAmount(tag('TRNAMT'));
      if (!date || amount === null || amount === 0) continue;
      const desc = [tag('NAME'), tag('MEMO')].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      txns.push({ date, desc: desc || '(no description)', amount: round2(amount), balance: null });
    }
    return txns;
  }

  function looksLikeOFX(text) {
    return /<OFX>|OFXHEADER|<STMTTRN>/i.test(text.slice(0, 5000));
  }

  // ---------------------------------------------------------------- QIF ----

  function looksLikeQIF(text) {
    return /^\s*!Type:/i.test(text);
  }

  function parseQIF(text) {
    const lines = text.split(/\r?\n/);
    const raw = [];
    let cur = {};
    for (const line of lines) {
      const code = line[0];
      const val = line.slice(1).trim();
      if (code === '^') { if (cur.D) raw.push(cur); cur = {}; }
      else if (code === 'D') cur.D = val.replace(/'/g, '/');
      else if (code === 'T' || code === 'U') cur.T = cur.T || val;
      else if (code === 'P') cur.P = val;
      else if (code === 'M') cur.M = val;
    }
    if (cur.D) raw.push(cur);
    const order = detectDateOrder(raw.map((r) => r.D));
    const txns = [];
    for (const r of raw) {
      const date = parseDate(r.D, order);
      const amount = parseAmount(r.T);
      if (!date || amount === null || amount === 0) continue;
      const desc = [r.P, r.M].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      txns.push({ date, desc: desc || '(no description)', amount: round2(amount), balance: null });
    }
    return txns;
  }

  // ------------------------------------------------------------ helpers ----

  function round2(n) { return Math.round(n * 100) / 100; }

  const PREFIXES = new RegExp(
    '^(card payment to|card purchase|card transaction|contactless payment|contactless|debit card|visa|pos|' +
    'direct debit( payment)? to|direct debit|standing order to|standing order|bill payment to|bill payment|' +
    'faster payments? (to|from|receipt from|payment to)|faster payments?|payment to|payment from|' +
    'transfer (to|from)|tfr|bacs|bgc|fpi|fpo|dd|so|bp|cpt|chq|purchase|online payment|cash withdrawal at|cash|atm)\\b[\\s:\\-*]*',
  );
  const NOISE = /\b(gb|gbr|uk|london|ltd|limited|plc|inc|llc|www|com|co|the|ref|reference|card|via|apple pay|google pay|on|at|eur|usd|gbp)\b/g;

  // A stable grouping key for "who was paid", so "AMAZON* 2K4J1 LONDON" and
  // "AMAZON* 9QQ3B" land together. Deliberately coarse.
  function merchantKey(desc) {
    let s = String(desc || '').toLowerCase();
    for (let i = 0; i < 3; i++) s = s.replace(PREFIXES, '');
    s = s.replace(/\b\d{1,2}[\s\-/](jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*([\s\-/]\d{2,4})?/g, ' ');
    s = s.replace(/[a-z]*\d[a-z\d]*/g, ' '); // ref codes, card numbers, dates
    s = s.replace(/[^a-z& ]/g, ' ').replace(NOISE, ' ');
    const words = s.split(/\s+/).filter((w) => w.length > 1).slice(0, 2);
    return words.join(' ') || String(desc || '').toLowerCase().trim().slice(0, 24) || 'unknown';
  }

  function titleCase(s) {
    return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
  }

  function daysBetween(a, b) {
    return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
  }

  function addDays(isoDate, n) {
    const d = new Date(Date.parse(isoDate) + n * 86400000);
    return d.toISOString().slice(0, 10);
  }

  function median(xs) {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function percentile(xs, p) {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
  }

  // Identity of a transaction: identical rows within one file stay distinct
  // (two £3.10 coffees on the same day), but the same row in two overlapping
  // statements collapses to one.
  function assignIds(txns) {
    const seen = new Map();
    return txns.map((t) => {
      const key = `${t.date}|${t.amount.toFixed(2)}|${t.desc.toLowerCase()}`;
      const n = (seen.get(key) || 0) + 1;
      seen.set(key, n);
      return { ...t, id: `${key}#${n}`, merchant: merchantKey(t.desc) };
    });
  }

  // ------------------------------------------------------------ analyse ----

  const SEV = { high: 3, medium: 2, low: 1 };
  const PERIODS = [
    { label: 'weekly', days: 7, min: 5, max: 9, grace: 4 },
    { label: 'fortnightly', days: 14, min: 12, max: 17, grace: 5 },
    { label: 'monthly', days: 30.44, min: 25, max: 36, grace: 8 },
    { label: 'quarterly', days: 91, min: 80, max: 100, grace: 15 },
  ];
  const FEE_RE = /\b(fee|fees|charges?|overdraft|overdrawn|o\/d|unpaid|returned|late payment|penalty|non[- ]?sterling|foreign (transaction|exchange|usage)|fx fee|commission|unarranged|interest charged|debit interest|arrangement)\b/i;
  const TINY_OK_RE = /\b(parking|park|tfl|bus|train|rail|toll|charity|round ?up|save|savings|interest|pot|vault|coin)\b/i;

  function detectRecurring(groups, dataEnd) {
    const out = [];
    for (const [key, list] of groups) {
      for (const dir of [-1, 1]) {
        const txs = list.filter((t) => Math.sign(t.amount) === dir);
        const byDay = [];
        for (const t of txs) if (!byDay.length || byDay[byDay.length - 1].date !== t.date) byDay.push(t);
        if (byDay.length < 3) continue;
        const gaps = byDay.slice(1).map((t, i) => daysBetween(byDay[i].date, t.date));
        const g = median(gaps);
        const period = PERIODS.find((p) => g >= p.min && g <= p.max);
        if (!period) continue;
        const regular = gaps.filter((x) => x >= period.min && x <= period.max).length / gaps.length;
        if (regular < 0.7) continue;
        const amts = byDay.map((t) => Math.abs(t.amount));
        const typical = median(amts.slice(-3));
        // Lots of irregular-sized payments to one place (a supermarket) is a
        // habit, not a bill.
        const similar = amts.filter((a) => Math.abs(a - typical) <= typical * 0.35).length / amts.length;
        if (similar < 0.6) continue;
        const last = byDay[byDay.length - 1];
        out.push({
          merchant: key,
          name: titleCase(key),
          direction: dir < 0 ? 'out' : 'in',
          period: period.label,
          periodDays: period.days,
          typical,
          monthly: typical * (30.44 / period.days),
          count: byDay.length,
          firstDate: byDay[0].date,
          lastDate: last.date,
          nextExpected: addDays(last.date, Math.round(period.days)),
          overdue: daysBetween(addDays(last.date, Math.round(period.days) + period.grace), dataEnd) > 0,
          txns: byDay,
        });
      }
    }
    return out.sort((a, b) => b.monthly - a.monthly);
  }

  function analyse(input, options) {
    const opts = options || {};
    const fmt = opts.format || ((n) => '£' + Math.abs(n).toFixed(2));
    const fdate = opts.formatDate || ((d) => d);
    const txns = [...input].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const result = { flags: [], patterns: [], recurring: [], stats: null };
    if (!txns.length) return result;

    const dataStart = txns[0].date;
    const dataEnd = txns[txns.length - 1].date;
    const flagMap = new Map();
    const flag = (t, rule, severity, title, detail) => {
      if (!flagMap.has(t.id)) flagMap.set(t.id, { txn: t, reasons: [] });
      const f = flagMap.get(t.id);
      if (!f.reasons.some((r) => r.rule === rule)) f.reasons.push({ rule, severity, title, detail, key: `${t.id}|${rule}` });
    };

    const groups = new Map();
    for (const t of txns) {
      if (!groups.has(t.merchant)) groups.set(t.merchant, []);
      groups.get(t.merchant).push(t);
    }
    const outAbs = txns.filter((t) => t.amount < 0).map((t) => -t.amount);
    const inAbs = txns.filter((t) => t.amount > 0).map((t) => t.amount);
    const p90 = percentile(outAbs, 0.9);
        const recurring = detectRecurring(groups, dataEnd);
    const recurringKey = new Set(recurring.map((r) => `${r.merchant}|${r.direction}`));
    result.recurring = recurring;

    // 1. Duplicate charges --------------------------------------------------
    for (const list of groups.values()) {
      const outs = list.filter((t) => t.amount < 0);
      const sameAmountCount = new Map();
      for (const t of outs) sameAmountCount.set(t.amount, (sameAmountCount.get(t.amount) || 0) + 1);
      for (let i = 0; i < outs.length; i++) {
        for (let j = i + 1; j < outs.length; j++) {
          const gap = daysBetween(outs[i].date, outs[j].date);
          if (gap > 2) break;
          if (outs[i].amount !== outs[j].amount || -outs[i].amount < 1) continue;
          if (sameAmountCount.get(outs[i].amount) >= 6) continue; // the daily coffee
          const big = -outs[j].amount >= 10;
          flag(outs[j], 'duplicate', gap === 0 && big ? 'medium' : 'low',
            'Possible duplicate charge',
            `Same amount (${fmt(outs[j].amount)}) to the same place ${gap === 0 ? 'on the same day' : gap + ' day' + (gap > 1 ? 's' : '') + ' apart'}. ` +
            'If you only bought once, ask the merchant or your bank for a refund.');
        }
      }
    }

    // 2. Unusually large for this merchant ---------------------------------
    for (const list of groups.values()) {
      const outs = list.filter((t) => t.amount < 0);
      for (let i = 4; i < outs.length; i++) {
        const prior = outs.slice(0, i).map((t) => -t.amount);
        const med = median(prior);
        const mad = median(prior.map((a) => Math.abs(a - med))) * 1.4826;
        const amt = -outs[i].amount;
        if (amt - med < 25) continue;
        if (amt > Math.max(med * 3, med + 6 * mad)) {
          const x = amt / med;
          flag(outs[i], 'merchant-spike', x >= 6 && amt >= 100 ? 'high' : 'medium',
            'Much bigger than usual here',
            `You normally spend about ${fmt(med)} here; this was ${fmt(amt)} (${x.toFixed(1)}× usual).`);
        }
      }
    }

    // 3 + 4. Big payments overall and big first payments to a new payee ---
    const enoughHistory = outAbs.length >= 20;
    for (const list of groups.values()) {
      const outs = list.filter((t) => t.amount < 0);
      outs.forEach((t, i) => {
        const amt = -t.amount;
        const isRecurring = recurringKey.has(`${t.merchant}|out`);
        const similarBefore = outs.slice(0, i).filter((p) => Math.abs(-p.amount - amt) <= amt * 0.3).length;
        if (enoughHistory && !isRecurring && similarBefore < 2 && amt >= Math.max(300, 5 * p90)) {
          flag(t, 'large', amt >= Math.max(1000, 10 * p90) ? 'high' : 'medium',
            'One of your largest payments',
            `${fmt(amt)} is far above your typical spending (90% of payments are under ${fmt(p90)}).`);
        }
        if (i === 0 && daysBetween(dataStart, t.date) >= 30 && amt >= Math.max(150, 3 * p90)) {
          const round = amt >= 500 && amt % 50 === 0;
          flag(t, 'new-payee', round ? 'high' : 'medium',
            'Large first payment to a new payee',
            `First time this payee appears, and it's ${fmt(amt)}.` +
            (round ? ' Large round-number transfers to new payees are the classic pattern of "safe account" and invoice scams — make sure you set this up yourself.' : ''));
        }
      });
    }

    // 5. Recurring payments: price rises, new subscriptions, missed ones ---
    for (const r of recurring) {
      const list = r.txns;
      // Only fixed-price bills: an energy bill that moves every month isn't a "rise".
      const repeats = list.slice(1).filter((t, i) => t.amount === list[i].amount).length;
      const fixedPrice = repeats / (list.length - 1) >= 0.5;
      for (let i = 2; fixedPrice && i < list.length; i++) {
        const a = Math.abs(list[i - 2].amount);
        const b = Math.abs(list[i - 1].amount);
        const c = Math.abs(list[i].amount);
        const steady = Math.abs(a - b) <= Math.max(0.01, a * 0.01);
        if (!steady || Math.abs(c - b) <= Math.max(0.5, b * 0.01)) continue;
        if (r.direction === 'out' && c > b) {
          flag(list[i], 'price-rise', 'medium', 'Regular payment went up',
            `${r.name} was ${fmt(b)} ${r.period}; now ${fmt(c)} (+${(((c - b) / b) * 100).toFixed(0)}%). Worth checking you agreed to this.`);
        } else if (r.direction === 'in' && c < b) {
          flag(list[i], 'income-drop', 'medium', 'Regular income was lower',
            `${r.name} usually pays ${fmt(b)}; this time ${fmt(c)}.`);
        }
      }
      if (r.direction === 'out' && daysBetween(dataStart, r.firstDate) >= 60 && daysBetween(r.firstDate, dataEnd) <= 100) {
        flag(list[0], 'new-recurring', 'low', 'New regular payment started',
          `${r.name} has charged ${fmt(r.typical)} ${r.period} since this date. Make sure it's a subscription you meant to start — free trials often roll into paid ones.`);
      }
      if (r.overdue) {
        result.patterns.push({
          id: `missed|${r.merchant}|${r.direction}|${r.nextExpected}`,
          severity: r.direction === 'in' ? 'high' : 'low',
          title: r.direction === 'in' ? `Expected income from ${r.name} hasn't arrived` : `${r.name} stopped`,
          detail: r.direction === 'in'
            ? `Usually ${fmt(r.typical)} ${r.period}; the next one was due around ${fdate(r.nextExpected)} and there's nothing up to ${fdate(dataEnd)}.`
            : `This ${r.period} ${fmt(r.typical)} payment was due around ${fdate(r.nextExpected)} but hasn't appeared. Fine if you cancelled it — otherwise a missed bill can mean late fees.`,
          merchant: r.merchant,
        });
      }
    }

    // 6. Bank fees ---------------------------------------------------------
    for (const t of txns) {
      if (t.amount < 0 && FEE_RE.test(t.desc)) {
        flag(t, 'fee', 'low', 'Bank fee or charge',
          `Looks like a fee (${fmt(t.amount)}). Banks sometimes refund fees if you ask, especially the first time.`);
      }
    }

    // 7. Tiny "test" charges ------------------------------------------------
    for (const t of txns) {
      const amt = -t.amount;
      if (amt > 0 && amt <= 2 && groups.get(t.merchant).length <= 2 && !TINY_OK_RE.test(t.desc) && !FEE_RE.test(t.desc)) {
        flag(t, 'tiny', 'low', 'Tiny charge from an unfamiliar merchant',
          'Fraudsters often test stolen card details with a small charge before a big one. If you don\'t recognise it, tell your bank.');
      }
    }

    // 8. Unexpected money in -----------------------------------------------
    for (const list of groups.values()) {
      const ins = list.filter((t) => t.amount > 0);
      if (!ins.length || recurringKey.has(`${list[0].merchant}|in`)) continue;
      const t = ins[0];
      if (inAbs.length >= 3 && daysBetween(dataStart, t.date) >= 30 && t.amount >= 200 && list.filter((x) => x.amount < 0).length === 0) {
        flag(t, 'unexpected-in', 'low', 'Money in from someone new',
          `${fmt(t.amount)} from a payer not seen before. If you weren't expecting it, don't spend or send it on — it may be a mistake or part of a scam. Ask your bank.`);
      }
    }

    // 9. Balance doesn't add up --------------------------------------------
    const byImport = new Map();
    for (const t of input) {
      if (t.balance == null || t.importId == null) continue;
      if (!byImport.has(t.importId)) byImport.set(t.importId, []);
      byImport.get(t.importId).push(t);
    }
    for (const list of byImport.values()) {
      list.sort((a, b) => a.seq - b.seq);
      if (list.length < 6) continue;
      const check = (prev, cur) => Math.abs(round2(prev.balance + cur.amount) - cur.balance) < 0.015;
      let fwd = 0;
      let rev = 0;
      for (let i = 1; i < list.length; i++) {
        if (check(list[i - 1], list[i])) fwd++;
        if (check(list[i], list[i - 1])) rev++;
      }
      const forward = fwd >= rev;
      if (Math.max(fwd, rev) / (list.length - 1) < 0.6) continue; // same-day ordering is unreliable here
      for (let i = 1; i < list.length; i++) {
        const [prev, cur] = forward ? [list[i - 1], list[i]] : [list[i], list[i - 1]];
        if (check(prev, cur)) continue;
        flag(cur, 'balance', 'medium', "Balance doesn't add up",
          `Previous balance ${fmt(prev.balance)} ${cur.amount < 0 ? '−' : '+'} ${fmt(cur.amount)} should give ${fmt(round2(prev.balance + cur.amount))}, ` +
          `but the statement shows ${fmt(cur.balance)}. A transaction may be missing from the file, or the statement was altered.`);
      }
    }

    // 10. Monthly spending spikes -------------------------------------------
    const months = new Map();
    for (const t of txns) {
      const m = t.date.slice(0, 7);
      if (!months.has(m)) months.set(m, { month: m, in: 0, out: 0, txns: [] });
      const e = months.get(m);
      if (t.amount < 0) { e.out += -t.amount; e.txns.push(t); } else e.in += t.amount;
    }
    const monthList = [...months.values()];
    if (monthList.length >= 4) {
      for (const m of monthList) {
        const others = median(monthList.filter((o) => o !== m).map((o) => o.out));
        if (others > 0 && m.out > others * 1.5 && m.out - others >= 300) {
          const top = [...m.txns].sort((a, b) => a.amount - b.amount).slice(0, 3);
          result.patterns.push({
            id: `spike|${m.month}`,
            severity: m.out > others * 2 ? 'medium' : 'low',
            title: `Spending spike in ${monthName(m.month)}`,
            detail: `You spent ${fmt(m.out)} — ${((m.out / others - 1) * 100).toFixed(0)}% more than a typical month (${fmt(others)}). Biggest: ` +
              top.map((t) => `${titleCase(t.merchant)} ${fmt(t.amount)}`).join(', ') + '.',
            month: m.month,
          });
        }
      }
    }

    result.flags = [...flagMap.values()].map((f) => ({
      ...f,
      severity: f.reasons.reduce((s, r) => (SEV[r.severity] > SEV[s] ? r.severity : s), 'low'),
    }));
    result.stats = {
      count: txns.length,
      dataStart,
      dataEnd,
      totalIn: inAbs.reduce((a, b) => a + b, 0),
      totalOut: outAbs.reduce((a, b) => a + b, 0),
      months: monthList,
      p90,
    };
    return result;
  }

  function monthName(ym) {
    const [y, m] = ym.split('-');
    return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+m - 1] + ' ' + y;
  }

  // ------------------------------------------------------- sample data ----

  // Six months of a plausible UK current account with problems planted in it,
  // emitted as a CSV so "Try sample data" runs through the real importer.
  function sampleCSV() {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const rows = [];
    const start = Date.UTC(2026, 3, 1);
    const day = (n) => new Date(start + n * 86400000).toISOString().slice(0, 10);
    const add = (n, desc, amt) => rows.push({ date: day(n), desc, amt });
    for (let mo = 0; mo < 6; mo++) {
      const b = mo * 30.4;
      if (mo < 5) add(Math.round(b + 15), 'ACME LTD SALARY', 2450); // last one never arrives
      add(Math.round(b + 1), 'DD HOMEWISE MORTGAGE', -985);
      add(Math.round(b + 3), 'DD OCTOPUS ENERGY', -(118 + Math.round(rnd() * 6)));
      add(Math.round(b + 5), 'DD COUNCIL TAX', -164);
      add(Math.round(b + 8), 'NETFLIX.COM', mo < 4 ? -10.99 : -12.99);
      add(Math.round(b + 12), 'SPOTIFY UK', -11.99);
      add(Math.round(b + 15), 'VODAFONE LTD', -24);
      if (mo >= 3) add(Math.round(b + 18), 'DISNEY PLUS', -7.99);
      for (let w = 0; w < 4; w++) {
        add(Math.round(b + w * 7 + 2), 'TESCO STORES 3021', -(45 + Math.round(rnd() * 4000) / 100));
        add(Math.round(b + w * 7 + 4), 'COSTA COFFEE', -3.45);
        if (rnd() < 0.6) add(Math.round(b + w * 7 + 5), 'SHELL PETROL', -(50 + Math.round(rnd() * 1500) / 100));
        add(Math.round(b + w * 7 + 6), 'AMAZON MARKETPLACE', -(8 + Math.round(rnd() * 2500) / 100));
      }
      add(Math.round(b + 20), 'DELIVEROO', -(18 + Math.round(rnd() * 1200) / 100));
    }
    add(48, 'AMAZON MARKETPLACE', -649.0); // spike at a known merchant
    add(64, 'DELIVEROO', -26.4);
    add(64, 'DELIVEROO', -26.4); // double charge
    add(101, 'XJPAY*VERIFY', -0.99); // card test
    add(103, 'FASTER PAYMENT TO J SMITH ACCT SAFE', -2500); // new round payee
    add(130, 'UNARRANGED OVERDRAFT FEE', -15);
    add(140, 'FASTER PAYMENT FROM UNKNOWN LTD', 480);
    rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    let bal = 1800;
    const lines = ['Date,Description,Amount,Balance'];
    rows.forEach((r, i) => {
      bal = round2(bal + r.amt);
      const shown = i === 120 ? round2(bal - 40) : bal; // a missing £40 line
      if (i === 120) bal = shown;
      const [y, m, d] = r.date.split('-');
      lines.push(`${d}/${m}/${y},"${r.desc}",${r.amt.toFixed(2)},${shown.toFixed(2)}`);
    });
    return lines.join('\n');
  }

  const api = {
    parseCSV, detectDelimiter, parseAmount, parseDate, detectDateOrder, guessMapping, applyMapping,
    parseOFX, looksLikeOFX, parseQIF, looksLikeQIF, merchantKey, titleCase, assignIds, analyse, detectRecurring, monthName,
    median, sampleCSV,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SC = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
