const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const PDFS = require('./pdfstatement.js');

// Reads a fixture through the same bundled pdf.js the app uses.
async function readPdf(file) {
  const pdfjs = await import('./vendor/pdfjs/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = path.join(__dirname, 'vendor/pdfjs/pdf.worker.min.mjs');
  const data = new Uint8Array(fs.readFileSync(path.join(__dirname, 'test-fixtures', file)));
  const task = pdfjs.getDocument({ data, isEvalSupported: false, verbosity: 0 });
  try { return PDFS.parseStatement(await PDFS.pagesFromPdf(await task.promise)); } finally { await task.destroy(); }
}

const expected = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'test-fixtures', name + '.json'), 'utf8'));
const simple = (txns) => txns.map((t) => ({ date: t.date, desc: t.desc, amount: t.amount }));

test('PDF: money out / money in columns, date once per day, wrapped descriptions, two pages', async () => {
  const r = await readPdf('layout-a.pdf');
  assert.deepEqual(simple(r.txns), expected('layout-a'));
  assert.ok(r.balanceChecked > 50);
  assert.equal(r.balanceOk, r.balanceChecked, 'every running balance adds up');
});

test('PDF: HSBC style — balance once a day, wrapping above the amount, across New Year', async () => {
  const r = await readPdf('layout-b.pdf');
  assert.deepEqual(simple(r.txns), expected('layout-b'));
  assert.equal(r.balanceOk, r.balanceChecked);
});

test('PDF: credit card — one amount column, CR for payments, no balance', async () => {
  const r = await readPdf('layout-c.pdf');
  assert.deepEqual(r.account, { type: 'card', last4: '4321' });
  assert.deepEqual(simple(r.txns), expected('layout-c'));
  assert.equal(r.hasBalance, false);
});

test('PDF: the running balance decides in or out when the columns do not', () => {
  const page = (rows) => ({ items: rows.flatMap(([y, cells]) => cells.map(([x, str]) => ({ str, x, y, w: str.length * 5, h: 10 }))) });
  const r = PDFS.parseStatement([page([
    [700, [[40, 'Date'], [100, 'Details'], [400, 'Amount'], [500, 'Balance']]],
    [680, [[40, '01/03/2026'], [100, 'Opening balance'], [500, '100.00']]],
    [660, [[40, '02/03/2026'], [100, 'REFUND FROM SHOP'], [400, '20.00'], [500, '120.00']]],
    [640, [[40, '03/03/2026'], [100, 'TESCO'], [400, '15.50'], [500, '104.50']]],
    [620, [[40, '04/03/2026'], [100, 'GYM'], [400, '30.00'], [500, '74.50']]],
    [600, [[40, '05/03/2026'], [100, 'WAGES'], [400, '1,000.00'], [500, '1,074.50']]],
  ])]);
  assert.deepEqual(r.txns.map((t) => t.amount), [20, -15.5, -30, 1000]);
  assert.equal(r.balanceOk, 4);
});

test('PDF: a scanned statement with no text is recognised as such', () => {
  assert.equal(PDFS.parseStatement([{ items: [] }]).scanned, true);
});

test('PDF: NatWest layout — Paid In before Withdrawn, wrapped headings, type + detail lines, OD balances', async () => {
  const r = await readPdf('layout-d.pdf');
  assert.deepEqual(simple(r.txns), expected('layout-d'));
  assert.ok(r.txns.some((t) => t.balance < 0), 'an overdrawn (OD) balance was read as negative');
  assert.equal(r.balanceOk, r.balanceChecked);
});

test('PDF: card with transaction and posting dates — keeps the date you spent, finds the card and its balance', async () => {
  const r = await readPdf('layout-e.pdf');
  const exp = expected('layout-e');
  assert.deepEqual(simple(r.txns), exp.txns);
  assert.deepEqual(r.account, { type: 'card', last4: '5678' });
  assert.equal(r.statementBalance, exp.owed);
});

test('PDF: a current account is recognised by its sort code and account number', async () => {
  const r = await readPdf('layout-d.pdf');
  assert.deepEqual(r.account, { type: 'current', last4: '5678' });
});

test('PDF: front pages (summary box, small print) are skipped; the table starts on page 3', async () => {
  const r = await readPdf('layout-f.pdf');
  const exp = expected('layout-f');
  assert.equal(r.fromPage, 2);
  assert.deepEqual(simple(r.txns), exp.txns);
  assert.equal(r.statementBalance, exp.owed);
});

test('PDF: a layout can be shared without names, addresses or card numbers', () => {
  const s = PDFS.scramble;
  assert.equal(s('Mr John Smith'), 'Xx Xxxx Xxxxx');
  assert.equal(s('Transaction date'), 'Transaction date');
  assert.equal(s('03 Sep 2026'), '03 Sep 2026');
  assert.equal(s('05/03/2026'), '05/03/2026');
  assert.equal(s('£1,234.56 CR'), '£1,234.56 CR');
  assert.equal(s('Sort code 60-12-34'), 'Sort code 00-00-00');
  const card = s('4929 1234 5678 9012');
  assert.match(card, /^\d{4} \d{4} \d{4} \d{4}$/);
  assert.notEqual(card, '4929 1234 5678 9012');
  assert.match(s('TESCO STORES 3021'), /^XXXXX XXXXXX \d{4}$/);
});
