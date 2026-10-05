const test = require('node:test');
const assert = require('node:assert/strict');
const SC = require('./analyse.js');

function importCSV(csv) {
  const rows = SC.parseCSV(csv);
  const cfg = SC.guessMapping(rows);
  return { cfg, ...SC.applyMapping(rows, cfg) };
}

test('amounts in the shapes banks export', () => {
  assert.equal(SC.parseAmount('£1,234.56'), 1234.56);
  assert.equal(SC.parseAmount('-12.30'), -12.3);
  assert.equal(SC.parseAmount('(45.00)'), -45);
  assert.equal(SC.parseAmount('45.00 DR'), -45);
  assert.equal(SC.parseAmount('45.00CR'), 45);
  assert.equal(SC.parseAmount('12.50-'), -12.5);
  assert.equal(SC.parseAmount('1.234,56'), 1234.56);
  assert.equal(SC.parseAmount('GBP 9.99'), 9.99);
  assert.equal(SC.parseAmount('Tesco'), null);
  assert.equal(SC.parseAmount(''), null);
});

test('dates in UK, US, ISO and written forms', () => {
  assert.equal(SC.parseDate('05/03/2026', 'DMY'), '2026-03-05');
  assert.equal(SC.parseDate('05/03/2026', 'MDY'), '2026-05-03');
  assert.equal(SC.parseDate('2026-03-05T10:00:00Z'), '2026-03-05');
  assert.equal(SC.parseDate('5 Mar 2026'), '2026-03-05');
  assert.equal(SC.parseDate('05-Mar-26'), '2026-03-05');
  assert.equal(SC.parseDate('March 5, 2026'), '2026-03-05');
  assert.equal(SC.parseDate('20260305120000[0:GMT]'), '2026-03-05');
  assert.equal(SC.parseDate('31/02/2026', 'DMY'), null);
  assert.equal(SC.detectDateOrder(['03/25/2026', '04/01/2026']), 'MDY');
  assert.equal(SC.detectDateOrder(['25/03/2026']), 'DMY');
});

test('signed amount layout (Monzo / Starling style)', () => {
  const { cfg, txns } = importCSV(
    'Transaction ID,Date,Time,Type,Name,Emoji,Category,Amount,Currency,Local amount\n' +
    'tx_1,01/03/2026,09:00,Card payment,Pret A Manger,,Eating out,-4.50,GBP,-4.50\n' +
    'tx_2,02/03/2026,10:00,Faster payment,Employer,,Income,2000.00,GBP,2000.00\n');
  assert.equal(cfg.map.date, 1);
  assert.equal(cfg.map.desc, 4);
  assert.equal(cfg.map.amount, 7);
  assert.deepEqual(txns.map((t) => t.amount), [-4.5, 2000]);
});

test('paid out / paid in layout with a preamble (Nationwide style)', () => {
  const { txns } = importCSV(
    '"Account Name:","FlexAccount ****1234"\n"Account Balance:","£1,000.00"\n\n' +
    '"Date","Transaction type","Description","Paid out","Paid in","Balance"\n' +
    '"03 Mar 2026","Visa purchase","SAINSBURYS","£23.10","","£976.90"\n' +
    '"04 Mar 2026","Bank credit","REFUND","","£10.00","£986.90"\n');
  assert.deepEqual(txns.map((t) => [t.date, t.desc, t.amount, t.balance]), [
    ['2026-03-03', 'SAINSBURYS', -23.1, 976.9],
    ['2026-03-04', 'REFUND', 10, 986.9],
  ]);
});

test('header-less file (HSBC style) and semicolons', () => {
  const a = importCSV('15/03/2026,TESCO STORES,-12.40\n16/03/2026,SALARY,1500.00\n');
  assert.deepEqual(a.txns.map((t) => t.amount), [-12.4, 1500]);
  assert.equal(a.txns[0].desc, 'TESCO STORES');
  const b = importCSV('Datum;Omschrijving;Bedrag\n15-03-2026;ALBERT HEIJN;-12,40\n');
  assert.deepEqual(b.txns.map((t) => t.amount), [-12.4]);
});

test('OFX files', () => {
  const ofx = '<OFX><BANKTRANLIST><STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260310<TRNAMT>-9.99<NAME>NETFLIX<MEMO>Monthly</STMTTRN>' +
    '<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260311120000<TRNAMT>50.00<NAME>REFUND</STMTTRN></BANKTRANLIST></OFX>';
  assert.ok(SC.looksLikeOFX(ofx));
  assert.deepEqual(SC.parseOFX(ofx).map((t) => [t.date, t.desc, t.amount]), [
    ['2026-03-10', 'NETFLIX Monthly', -9.99],
    ['2026-03-11', 'REFUND', 50],
  ]);
});

test('merchant keys group noisy descriptions together', () => {
  assert.equal(SC.merchantKey('CARD PAYMENT TO AMAZON* 2K4J1 ON 12 MAR'), SC.merchantKey('AMAZON* 9QQ3B LONDON GB'));
  assert.equal(SC.merchantKey('DD OCTOPUS ENERGY 123456'), 'octopus energy');
});

test('identical rows stay distinct within a file but match across overlapping files', () => {
  const rows = [
    { date: '2026-03-01', desc: 'COSTA', amount: -3.1, balance: null },
    { date: '2026-03-01', desc: 'COSTA', amount: -3.1, balance: null },
  ];
  const a = SC.assignIds(rows);
  assert.notEqual(a[0].id, a[1].id);
  assert.deepEqual(SC.assignIds(rows).map((t) => t.id), a.map((t) => t.id));
});

test('sample statement surfaces every planted problem and nothing else', () => {
  const { txns } = importCSV(SC.sampleCSV());
  const withIds = SC.assignIds(txns).map((t, i) => ({ ...t, importId: 'x', seq: i }));
  const r = SC.analyse(withIds);
  const rules = r.flags.flatMap((f) => f.reasons.map((x) => `${x.rule}:${f.txn.merchant}`)).sort();
  assert.deepEqual(rules, [
    'balance:tesco stores',
    'duplicate:deliveroo',
    'fee:unarranged overdraft',
    'large:smith acct',
    'merchant-spike:amazon marketplace',
    'new-payee:smith acct',
    'new-recurring:disney plus',
    'price-rise:netflix',
    'tiny:xjpay verify',
    'unexpected-in:unknown',
  ]);
  assert.ok(r.patterns.some((p) => p.id.startsWith('missed|acme salary|in')));
  assert.ok(r.recurring.some((x) => x.merchant === 'netflix' && x.period === 'monthly'));
});

test('a quiet, regular account raises nothing', () => {
  const txns = [];
  for (let m = 1; m <= 6; m++) {
    const mm = String(m).padStart(2, '0');
    txns.push({ date: `2026-${mm}-01`, desc: 'RENT', amount: -900, balance: null });
    txns.push({ date: `2026-${mm}-25`, desc: 'SALARY', amount: 2000, balance: null });
    for (const d of [3, 10, 17, 24]) txns.push({ date: `2026-${mm}-${String(d).padStart(2, '0')}`, desc: 'TESCO', amount: -(50 + d), balance: null });
  }
  const r = SC.analyse(SC.assignIds(txns));
  assert.deepEqual(r.flags, []);
  assert.deepEqual(r.patterns, []);
});

test('QIF files', () => {
  const qif = '!Type:Bank\nD03/10/2026\nT-9.99\nPNETFLIX\n^\nD03/11/2026\nT1,500.00\nPSALARY\n^\n';
  assert.ok(SC.looksLikeQIF(qif));
  assert.deepEqual(SC.parseQIF(qif).map((t) => [t.date, t.amount]), [['2026-10-03', -9.99], ['2026-11-03', 1500]]);
});
