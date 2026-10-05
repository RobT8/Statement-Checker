/*
 * Statement Check — categories that learn.
 *
 * Three layers, most specific first:
 *   1. manual — the user set this one transaction's category
 *   2. payee  — the user said "always use X for this payee" (money in and
 *               money out from the same payee are separate rules: an Amazon
 *               refund is not Shopping)
 *   3. guess  — a naive Bayes model trained on every transaction covered by
 *               1 or 2, so a new "TESCO EXPRESS" inherits what you taught it
 *               about "TESCO STORES", and "DD ..." leans towards your bills.
 *
 * Pure functions, shared by the page and the Node tests.
 */
(function (root) {
  'use strict';

  const DEFAULT_CATEGORIES = [
    { id: 'housing', name: 'Housing', icon: '🏠', type: 'out' },
    { id: 'bills', name: 'Bills & utilities', icon: '💡', type: 'out' },
    { id: 'groceries', name: 'Groceries', icon: '🛒', type: 'out' },
    { id: 'eating-out', name: 'Eating out', icon: '🍽️', type: 'out' },
    { id: 'transport', name: 'Transport', icon: '🚗', type: 'out' },
    { id: 'shopping', name: 'Shopping', icon: '🛍️', type: 'out' },
    { id: 'subscriptions', name: 'Subscriptions', icon: '📺', type: 'out' },
    { id: 'entertainment', name: 'Entertainment', icon: '🎟️', type: 'out' },
    { id: 'health', name: 'Health & fitness', icon: '💊', type: 'out' },
    { id: 'family', name: 'Kids & family', icon: '🧸', type: 'out' },
    { id: 'holidays', name: 'Holidays & travel', icon: '✈️', type: 'out' },
    { id: 'cash', name: 'Cash', icon: '💷', type: 'out' },
    { id: 'fees', name: 'Fees & charges', icon: '🧾', type: 'out' },
    { id: 'gifts', name: 'Gifts & donations', icon: '🎁', type: 'out' },
    { id: 'other-out', name: 'Other spending', icon: '📦', type: 'out' },
    { id: 'salary', name: 'Salary', icon: '💼', type: 'in' },
    { id: 'benefits', name: 'Benefits', icon: '🏛️', type: 'in' },
    { id: 'refunds', name: 'Refunds', icon: '↩️', type: 'in' },
    { id: 'interest', name: 'Interest', icon: '📈', type: 'in' },
    { id: 'other-in', name: 'Other income', icon: '💰', type: 'in' },
    { id: 'transfers', name: 'Transfers', icon: '🔁', type: 'both' },
    { id: 'savings', name: 'Savings', icon: '🐷', type: 'both' },
  ];

  // How sure a guess must be before it's shown.
  const MIN_CONFIDENCE = 0.6;

  const STOP = new Set(['the', 'and', 'ltd', 'limited', 'plc', 'www', 'com', 'co', 'card', 'payment', 'payments',
    'to', 'from', 'on', 'at', 'gb', 'gbr', 'uk', 'ref', 'reference', 'via', 'purchase', 'of', 'for']);

  function freshState() {
    return { list: DEFAULT_CATEGORIES.map((c) => ({ ...c })), txnCats: {}, payeeCats: {} };
  }

  function direction(t) {
    return t.amount < 0 ? 'out' : 'in';
  }

  function payeeKey(t) {
    return direction(t) + '|' + t.merchant;
  }

  function allows(cat, dir) {
    return cat.type === 'both' || cat.type === dir;
  }

  // Words of the raw description (bank prefixes like "DD" and "FPI" are
  // useful evidence, so they stay), the grouped payee, and a coarse size.
  function features(t) {
    const f = new Set();
    for (const w of String(t.desc).toLowerCase().replace(/[^a-z&]+/g, ' ').split(' ')) {
      if (w.length >= 2 && !STOP.has(w)) f.add('w:' + w);
    }
    f.add('m:' + t.merchant);
    const a = Math.abs(t.amount);
    f.add('a:' + (a < 5 ? 0 : a < 20 ? 1 : a < 100 ? 2 : a < 500 ? 3 : 4));
    return [...f];
  }

  function train(labelled) {
    const model = { docs: 0, cats: new Map(), vocab: new Set() };
    for (const [t, cat] of labelled) {
      if (!model.cats.has(cat)) model.cats.set(cat, { n: 0, total: 0, counts: new Map() });
      const c = model.cats.get(cat);
      c.n++;
      model.docs++;
      for (const f of features(t)) {
        c.counts.set(f, (c.counts.get(f) || 0) + 1);
        c.total++;
        model.vocab.add(f);
      }
    }
    return model;
  }

  function predict(model, t, allowed) {
    const feats = features(t).filter((f) => model.vocab.has(f));
    // Amount size alone is no basis for a guess; it needs a shared word or payee.
    if (!feats.some((f) => f[0] !== 'a')) return null;
    const V = model.vocab.size;
    const K = model.cats.size;
    const scores = [];
    for (const [cat, c] of model.cats) {
      if (!allowed(cat)) continue;
      let s = Math.log((c.n + 1) / (model.docs + K));
      let evidence = 0;
      for (const f of feats) {
        const n = c.counts.get(f) || 0;
        if (f[0] !== 'a') evidence += n;
        s += Math.log((n + 1) / (c.total + V));
      }
      scores.push({ cat, s, evidence });
    }
    if (!scores.length) return null;
    const max = Math.max(...scores.map((x) => x.s));
    const sum = scores.reduce((a, x) => a + Math.exp(x.s - max), 0);
    const best = scores.reduce((a, x) => (x.s > a.s ? x : a));
    // A category that never saw any of these words can't win on its prior alone.
    if (!best.evidence) return null;
    // With only one candidate the posterior is trivially 1; temper it by how
    // much evidence there is.
    const p = scores.length === 1 ? best.evidence / (best.evidence + 1) : Math.exp(best.s - max) / sum;
    return { cat: best.cat, confidence: p };
  }

  // Returns Map(txn id -> { cat: id|null, source: 'manual'|'payee'|'guess'|null, confidence }).
  function categorise(txns, state) {
    const st = state || freshState();
    const byId = new Map(st.list.map((c) => [c.id, c]));
    const ok = (id, t) => id && byId.has(id) && allows(byId.get(id), direction(t));
    const out = new Map();
    const labelled = [];
    for (const t of txns) {
      const manual = st.txnCats[t.id];
      const payee = st.payeeCats[payeeKey(t)];
      if (ok(manual, t)) { out.set(t.id, { cat: manual, source: 'manual', confidence: 1 }); labelled.push([t, manual]); }
      else if (ok(payee, t)) { out.set(t.id, { cat: payee, source: 'payee', confidence: 1 }); labelled.push([t, payee]); }
    }
    const model = train(labelled);
    for (const t of txns) {
      if (out.has(t.id)) continue;
      const dir = direction(t);
      const g = labelled.length ? predict(model, t, (id) => byId.has(id) && allows(byId.get(id), dir)) : null;
      out.set(t.id, g && g.confidence >= MIN_CONFIDENCE
        ? { cat: g.cat, source: 'guess', confidence: g.confidence }
        : { cat: null, source: null, confidence: 0 });
    }
    return out;
  }

  // Payees with at least one transaction you haven't categorised yourself,
  // biggest money first — the order the quick-sort screen walks through.
  function payeesToSort(txns, state, catMap) {
    const groups = new Map();
    for (const t of txns) {
      const key = payeeKey(t);
      const info = catMap.get(t.id);
      if (info.source === 'manual' || info.source === 'payee') continue;
      if (!groups.has(key)) groups.set(key, { key, merchant: t.merchant, dir: direction(t), txns: [], total: 0 });
      const g = groups.get(key);
      g.txns.push(t);
      g.total += Math.abs(t.amount);
    }
    return [...groups.values()].sort((a, b) => b.total - a.total);
  }

  function median(xs) {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function monthsBetween(first, last) {
    const out = [];
    let [y, m] = first.split('-').map(Number);
    const [ly, lm] = last.split('-').map(Number);
    while (y < ly || (y === ly && m <= lm)) {
      out.push(`${y}-${String(m).padStart(2, '0')}`);
      if (++m > 12) { m = 1; y++; }
    }
    return out;
  }

  // A spending category's month compared with its usual month. "Usual" is the
  // median of every other month in the data, counting months with nothing in
  // that category as zero — so a category you rarely use never looks "usual".
  function categorySpikes(txns, catMap, list, options) {
    const opts = options || {};
    const fmt = opts.format || ((n) => '£' + Math.abs(n).toFixed(2));
    const monthName = opts.monthName || ((m) => m);
    const titleCase = opts.titleCase || ((x) => x);
    if (!txns.length) return [];
    const dates = txns.map((t) => t.date).sort();
    const months = monthsBetween(dates[0].slice(0, 7), dates[dates.length - 1].slice(0, 7));
    if (months.length < 3) return [];
    const byId = new Map(list.map((c) => [c.id, c]));
    const spend = new Map();
    for (const t of txns) {
      if (t.amount >= 0) continue;
      const info = catMap.get(t.id);
      const c = info && info.cat ? byId.get(info.cat) : null;
      if (!c || c.type !== 'out') continue;
      if (!spend.has(c.id)) spend.set(c.id, new Map());
      const m = t.date.slice(0, 7);
      const cell = spend.get(c.id).get(m) || { total: 0, txns: [], guessed: 0 };
      cell.total += -t.amount;
      cell.txns.push(t);
      if (info.source === 'guess') cell.guessed++;
      spend.get(c.id).set(m, cell);
    }
    const out = [];
    for (const [id, byMonth] of spend) {
      const c = byId.get(id);
      const totals = months.map((m) => (byMonth.get(m) || { total: 0 }).total);
      months.forEach((m, i) => {
        const v = totals[i];
        const typical = median(totals.filter((_, j) => j !== i));
        if (typical <= 0 || v < typical * 1.5 || v - typical < 50) return;
        const cell = byMonth.get(m);
        const top = [...cell.txns].sort((a, b) => a.amount - b.amount).slice(0, 3);
        out.push({
          id: `catspike|${id}|${m}`,
          severity: v >= typical * 2.5 ? 'medium' : 'low',
          title: `${c.icon} ${c.name} up in ${monthName(m)}`,
          detail: `${fmt(v)} on ${c.name.toLowerCase()} — ${Math.round((v / typical - 1) * 100)}% more than your usual ${fmt(typical)} a month. ` +
            `Biggest: ${top.map((t) => `${titleCase(t.merchant)} ${fmt(t.amount)}`).join(', ')}.` +
            (cell.guessed ? ` ${cell.guessed} of these ${cell.guessed === 1 ? 'was' : 'were'} categorised by a learned guess — check them if this looks wrong.` : ''),
          cat: id,
          month: m,
        });
      });
    }
    return out;
  }

  // Payees whose category is only a learned guess, for the review screen.
  function guessesToReview(txns, catMap) {
    const groups = new Map();
    for (const t of txns) {
      const info = catMap.get(t.id);
      if (info.source !== 'guess') continue;
      const key = payeeKey(t);
      if (!groups.has(key)) groups.set(key, { key, merchant: t.merchant, dir: direction(t), txns: [], total: 0, cat: info.cat, confidence: info.confidence });
      const g = groups.get(key);
      g.txns.push(t);
      g.total += Math.abs(t.amount);
    }
    return [...groups.values()].sort((a, b) => b.total - a.total);
  }

  function slug(name) {
    return 'c-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) + '-' + Math.random().toString(36).slice(2, 6);
  }

  const api = { DEFAULT_CATEGORIES, MIN_CONFIDENCE, freshState, direction, payeeKey, allows, features, train, predict, categorise, payeesToSort, categorySpikes, guessesToReview, slug };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CAT = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
