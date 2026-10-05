const test = require('node:test');
const assert = require('node:assert/strict');
const SC = require('./analyse.js');
const CAT = require('./categorise.js');

const tx = (desc, amount, date) => ({ date: date || '2026-03-01', desc, amount, balance: null });
const build = (rows) => SC.assignIds(rows);

test('a payee rule covers every payment to that payee, past and future, one direction only', () => {
  const txns = build([tx('TESCO STORES 3021', -40), tx('TESCO STORES 3021', -55, '2026-03-08'), tx('TESCO STORES 3021', 12)]);
  const st = CAT.freshState();
  st.payeeCats[CAT.payeeKey(txns[0])] = 'groceries';
  const m = CAT.categorise(txns, st);
  assert.deepEqual([m.get(txns[0].id).cat, m.get(txns[1].id).cat], ['groceries', 'groceries']);
  assert.equal(m.get(txns[1].id).source, 'payee');
  assert.equal(m.get(txns[2].id).cat, null, 'a refund is not groceries');
});

test('a single-transaction choice beats the payee rule', () => {
  const txns = build([tx('AMAZON MARKETPLACE', -20), tx('AMAZON MARKETPLACE', -300, '2026-03-04')]);
  const st = CAT.freshState();
  st.payeeCats[CAT.payeeKey(txns[0])] = 'shopping';
  st.txnCats[txns[1].id] = 'gifts';
  const m = CAT.categorise(txns, st);
  assert.equal(m.get(txns[0].id).cat, 'shopping');
  assert.deepEqual([m.get(txns[1].id).cat, m.get(txns[1].id).source], ['gifts', 'manual']);
});

test('learns from similar descriptions it has not been told about', () => {
  const txns = build([
    tx('TESCO STORES 3021', -40), tx('SAINSBURYS S/MKTS', -32), tx('DD OCTOPUS ENERGY', -120), tx('DD THAMES WATER', -38),
    tx('TESCO EXPRESS 99', -8), tx('DD BRITISH GAS', -90), tx('VUE CINEMAS', -24),
  ]);
  const st = CAT.freshState();
  for (const [i, c] of [[0, 'groceries'], [1, 'groceries'], [2, 'bills'], [3, 'bills']]) st.payeeCats[CAT.payeeKey(txns[i])] = c;
  const m = CAT.categorise(txns, st);
  assert.deepEqual([m.get(txns[4].id).cat, m.get(txns[4].id).source], ['groceries', 'guess']);
  assert.equal(m.get(txns[5].id).cat, 'bills', 'direct debits lean towards bills');
  assert.equal(m.get(txns[6].id).cat, null, 'nothing in common, so no guess');
});

test('conflicting evidence means no guess rather than a wrong one', () => {
  const txns = build([tx('DD HOMEWISE MORTGAGE', -900), tx('DD OCTOPUS ENERGY', -120), tx('DD SOMETHING NEW', -60)]);
  const st = CAT.freshState();
  st.payeeCats[CAT.payeeKey(txns[0])] = 'housing';
  st.payeeCats[CAT.payeeKey(txns[1])] = 'bills';
  assert.equal(CAT.categorise(txns, st).get(txns[2].id).cat, null);
});

test('guesses never cross from spending into income categories', () => {
  const txns = build([tx('PAYPAL ACME', -50), tx('PAYPAL ACME', 50)]);
  const st = CAT.freshState();
  st.payeeCats[CAT.payeeKey(txns[0])] = 'shopping';
  assert.equal(CAT.categorise(txns, st).get(txns[1].id).cat, null);
});

test('deleting a category releases its transactions', () => {
  const txns = build([tx('GYM GROUP', -25)]);
  const st = CAT.freshState();
  st.payeeCats[CAT.payeeKey(txns[0])] = 'health';
  st.list = st.list.filter((c) => c.id !== 'health');
  assert.equal(CAT.categorise(txns, st).get(txns[0].id).cat, null);
});

test('the sort queue lists uncategorised payees, biggest first', () => {
  const txns = build([tx('RENT CO', -900), tx('COSTA', -3), tx('COSTA', -3, '2026-03-02'), tx('NETFLIX', -11)]);
  const st = CAT.freshState();
  st.payeeCats[CAT.payeeKey(txns[3])] = 'subscriptions';
  const q = CAT.payeesToSort(txns, st, CAT.categorise(txns, st));
  assert.deepEqual(q.map((g) => [g.merchant, g.txns.length]), [['rent', 1], ['costa', 2]]);
});
