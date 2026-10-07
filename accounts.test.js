const test = require('node:test');
const assert = require('node:assert/strict');
const ACCT = require('./accounts.js');

const tx = (accountId, importId, seq, date, amount, balance = null) => ({ accountId, importId, seq, date, amount, balance, desc: 'X', id: `${accountId}${seq}` });

test('data from before accounts moves into one current account, keeping its ids', () => {
  const db = ACCT.migrate({ imports: [{ id: 'i1' }], txns: [{ id: '2026-03-01|-5.00|tesco#1', importId: 'i1' }] });
  assert.deepEqual(db.accounts, [{ id: 'main', name: 'Current account', type: 'current', last4: '' }]);
  assert.equal(db.imports[0].accountId, 'main');
  assert.equal(db.txns[0].accountId, 'main');
  assert.equal(db.txns[0].id, '2026-03-01|-5.00|tesco#1');
});

test('the same row on two accounts gets two ids; the first account keeps plain ids', () => {
  const rows = [{ date: '2026-03-01', desc: 'NETFLIX.COM', amount: -10.99, balance: null }];
  assert.equal(ACCT.idsFor(rows, 'main')[0].id, '2026-03-01|-10.99|netflix.com#1');
  assert.equal(ACCT.idsFor(rows, 'ab12c')[0].id, 'ab12c|2026-03-01|-10.99|netflix.com#1');
  assert.equal(ACCT.newId([]), 'main');
  assert.notEqual(ACCT.newId([{ id: 'main' }]), 'main');
});

test('a statement is matched to an existing account by kind and last 4 digits', () => {
  const accounts = [{ id: 'main', type: 'current', last4: '5678' }, { id: 'c1', type: 'card', last4: '5678' }];
  assert.equal(ACCT.match(accounts, { type: 'card', last4: '5678' }), 'c1');
  assert.equal(ACCT.match(accounts, { type: 'current', last4: '5678' }), 'main');
  assert.equal(ACCT.match(accounts, { type: 'card', last4: '9999' }), null);
  assert.equal(ACCT.match(accounts, { type: 'card', last4: '' }), null);
});

test('card exports with spending as positive are turned round', () => {
  const pos = [{ amount: 12 }, { amount: 30 }, { amount: -250 }];
  assert.deepEqual(ACCT.cardSigns(pos).map((t) => t.amount), [-12, -30, 250]);
  const ok = [{ amount: -12 }, { amount: -30 }, { amount: 250 }];
  assert.equal(ACCT.cardSigns(ok), ok);
});

test('totals: bank balances from the latest line, card owed from the statement summary', () => {
  const db = {
    accounts: [{ id: 'main', type: 'current' }, { id: 's', type: 'savings' }, { id: 'c', type: 'card' }, { id: 'n', type: 'card' }],
    imports: [
      { id: 'i1', accountId: 'main', to: '2026-03-31' },
      { id: 'i2', accountId: 'c', to: '2026-03-28', closing: 412.3 },
      { id: 'i3', accountId: 'c', to: '2026-02-28', closing: 999 },
    ],
    txns: [
      tx('main', 'i1', 0, '2026-03-30', -10, 500),
      tx('main', 'i1', 1, '2026-03-31', -20, 480),
      tx('main', 'i1', 2, '2026-03-31', -30, 450),
      tx('s', 'i9', 0, '2026-03-15', 100, 2000),
    ],
  };
  assert.deepEqual(ACCT.balance(db.accounts[0], db), { amount: 450, date: '2026-03-31' });
  assert.deepEqual(ACCT.balance(db.accounts[2], db), { amount: 412.3, date: '2026-03-28' });
  const t = ACCT.totals(db);
  assert.equal(t.inAccounts, 2450);
  assert.equal(t.owedOnCards, 412.3);
  assert.deepEqual(t.unknown.map((a) => a.id), ['n']);
});

test('a statement listed newest first still gives the latest balance', () => {
  const db = { accounts: [{ id: 'main', type: 'current' }], imports: [], txns: [
    tx('main', 'i1', 0, '2026-03-31', -30, 450),
    tx('main', 'i1', 1, '2026-03-31', -20, 480),
    tx('main', 'i1', 2, '2026-03-01', -10, 500),
  ] };
  assert.equal(ACCT.balance(db.accounts[0], db).amount, 450);
});
