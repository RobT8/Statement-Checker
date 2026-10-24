/* Statement Check — bank accounts and credit cards.
 * Account: { id, name, type: 'current' | 'savings' | 'card', last4 }.
 * Every import and transaction carries an accountId. The first account is
 * 'main' and keeps plain transaction ids, so data from before accounts
 * existed (and its categories, edits and dismissals) carries straight over;
 * other accounts prefix their ids so identical rows on two cards stay apart. */
(function (root) {
  'use strict';

  const SC = root.SC || (typeof require === 'function' ? require('./analyse.js') : null);
  const TYPES = { current: 'Current account', savings: 'Savings account', card: 'Credit card' };
  const ICONS = { current: '🏦', savings: '🐷', card: '💳' };

  function defaultName(type) {
    return TYPES[type] || TYPES.current;
  }

  function label(acc) {
    return acc.name + (acc.last4 ? ' ••' + acc.last4 : '');
  }

  function icon(acc) {
    return ICONS[acc.type] || ICONS.current;
  }

  // Before accounts: everything belonged to one current account.
  function migrate(db) {
    if (!Array.isArray(db.accounts)) db.accounts = [];
    const orphan = db.imports.some((i) => !i.accountId) || db.txns.some((t) => !t.accountId);
    if (orphan && !db.accounts.some((a) => a.id === 'main')) {
      db.accounts.unshift({ id: 'main', name: TYPES.current, type: 'current', last4: '' });
    }
    for (const i of db.imports) if (!i.accountId) i.accountId = 'main';
    for (const t of db.txns) if (!t.accountId) t.accountId = 'main';
    return db;
  }

  function newId(accounts) {
    if (!accounts.some((a) => a.id === 'main')) return 'main';
    let id;
    do { id = 'a' + Math.random().toString(36).slice(2, 7); } while (accounts.some((a) => a.id === id));
    return id;
  }

  // An existing account the statement matches: same kind and last 4 digits.
  function match(accounts, detected) {
    if (!detected || !detected.last4) return null;
    const hit = accounts.find((a) => a.last4 === detected.last4 && (a.type === 'card') === (detected.type === 'card'));
    return hit ? hit.id : null;
  }

  function idsFor(txns, accountId) {
    return SC.assignIds(txns).map((t) => (accountId === 'main' ? t : { ...t, id: accountId + '|' + t.id }));
  }

  // Card exports often show spending as positive. Statements are mostly
  // spending, so if most lines are "money in", the signs are back to front.
  function cardSigns(txns) {
    const pos = txns.filter((t) => t.amount > 0).length;
    return pos > txns.length * 0.6 ? txns.map((t) => ({ ...t, amount: -t.amount })) : txns;
  }

  // The latest balance we know for an account, as { amount, date } where a
  // card's amount is what's owed (positive). A running balance on the last
  // transaction wins; otherwise the closing balance from the newest
  // statement's summary. Null when no statement gave one.
  function balance(acc, db) {
    let best = null;
    const forward = new Map();
    for (const t of db.txns) {
      if (t.accountId !== acc.id || t.balance == null) continue;
      if (!best || t.date > best.date || (t.date === best.date && later(t, best, db, forward))) best = t;
    }
    let out = best ? { amount: best.balance, date: best.date } : null;
    const imps = db.imports.filter((i) => i.accountId === acc.id && i.closing != null).sort((a, b) => (a.to < b.to ? -1 : 1));
    const last = imps[imps.length - 1];
    if (last && (!out || last.to > out.date)) out = { amount: last.closing, date: last.to };
    if (out && acc.type === 'card') out = { amount: Math.abs(out.amount), date: out.date };
    return out;
  }

  // Same day: the later line in its statement's own order (which may run
  // newest first).
  function later(a, b, db, forward) {
    if (a.importId !== b.importId) return a.importId > b.importId;
    if (!forward.has(a.importId)) {
      const list = db.txns.filter((t) => t.importId === a.importId).sort((x, y) => x.seq - y.seq);
      forward.set(a.importId, list.length < 2 || list[0].date <= list[list.length - 1].date);
    }
    return forward.get(a.importId) ? a.seq > b.seq : a.seq < b.seq;
  }

  // The two totals: money in bank accounts, and owed on cards.
  function totals(db) {
    const out = { inAccounts: 0, owedOnCards: 0, banks: 0, cards: 0, unknown: [] };
    for (const acc of db.accounts) {
      const b = balance(acc, db);
      if (!b) { out.unknown.push(acc); continue; }
      if (acc.type === 'card') { out.owedOnCards += b.amount; out.cards++; } else { out.inAccounts += b.amount; out.banks++; }
    }
    out.inAccounts = Math.round(out.inAccounts * 100) / 100;
    out.owedOnCards = Math.round(out.owedOnCards * 100) / 100;
    return out;
  }

  // Moves one statement's transactions to another account (it was put in
  // the wrong one). Ids get the new account's prefix and anything keyed by id
  // follows; moving onto or off a card turns the signs round if they'd be
  // back to front there.
  function moveImport(db, importId, target) {
    const im = db.imports.find((i) => i.id === importId);
    if (!im || im.accountId === target.id) return 0;
    const list = db.txns.filter((t) => t.importId === importId);
    const from = db.accounts.find((a) => a.id === im.accountId);
    const wasCard = !!from && from.type === 'card';
    const isCard = target.type === 'card';
    const flip = wasCard !== isCard && (isCard ? cardSigns(list) !== list : list.filter((t) => t.amount > 0).length > list.length * 0.6);
    const rekey = (map, oldId, newId, suffix) => {
      for (const k of Object.keys(map)) {
        if (k === oldId || (suffix && k.startsWith(oldId + '|'))) { map[newId + k.slice(oldId.length)] = map[k]; delete map[k]; }
      }
    };
    for (const t of list) {
      let base = im.accountId === 'main' ? t.id : t.id.slice(im.accountId.length + 1);
      if (flip) {
        t.amount = -t.amount;
        base = base.replace(/^(\d{4}-\d{2}-\d{2})\|(-?)(\d+\.\d{2})\|/, (m, d, neg, n) => `${d}|${neg ? '' : '-'}${n}|`);
      }
      const id = target.id === 'main' ? base : target.id + '|' + base;
      if (db.cats && db.cats.txnCats) rekey(db.cats.txnCats, t.id, id, false);
      if (db.dismissed) rekey(db.dismissed, t.id, id, true);
      t.id = id;
      t.accountId = target.id;
    }
    im.accountId = target.id;
    if (flip && im.closing != null) im.closing = -im.closing;
    return list.length;
  }

  const api = { moveImport, TYPES, defaultName, label, icon, migrate, newId, match, idsFor, cardSigns, balance, totals };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ACCT = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
