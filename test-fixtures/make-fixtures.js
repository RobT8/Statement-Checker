/*
 * Builds the fake PDF statements used by pdfstatement.test.js, in three
 * common layouts, plus the transactions each should read back as.
 *
 *   NODE_PATH=$(npm root -g) node test-fixtures/make-fixtures.js
 *
 * Needs Playwright (Chromium prints the HTML to PDF). Only rerun this when
 * changing the fixtures; the tests read the committed PDFs.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const money = (n) => Math.abs(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Overdrawn balances: a minus sign in layout A, HSBC's trailing "D" in layout B.
const bal = (n) => (n < 0 ? '-' : '') + money(n);
const balD = (n) => money(n) + (n < 0 ? ' D' : '');
const css = `body{font:10pt Arial,sans-serif;margin:0} h1{font-size:16pt} table{border-collapse:collapse;width:100%}
  th,td{padding:3px 6px;text-align:left;border-bottom:1px solid #ccc} th.n,td.n{text-align:right}
  .foot{position:fixed;bottom:0;left:0;font-size:8pt;color:#555}`;

let seed = 11;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const payees = [
  ['TESCO STORES 3021', 'LONDON'], ['DD OCTOPUS ENERGY', 'REF 88231'], ['CARD PAYMENT TO AMAZON', 'MARKETPLACE AMZN.CO.UK'],
  ['SHELL PETROL'], ['NETFLIX.COM'], ['COSTA COFFEE'], ['FASTER PAYMENT TO J SMITH', 'RENT MARCH'], ['SAINSBURYS S/MKT'],
];

function makeTxns(start, days, startBalance) {
  const out = [];
  let bal = startBalance;
  for (let d = 0; d < days; d++) {
    const date = new Date(start.getTime() + d * 86400000);
    const n = rnd() < 0.55 ? 1 + Math.floor(rnd() * 2) : 0;
    for (let i = 0; i < n; i++) {
      const p = payees[Math.floor(rnd() * payees.length)];
      const amount = -Math.round((3 + rnd() * (rnd() < 0.1 ? 1500 : 120)) * 100) / 100;
      bal = Math.round((bal + amount) * 100) / 100;
      out.push({ date, lines: p, amount, balance: bal });
    }
    if (d % 14 === 6) {
      bal = Math.round((bal + 2450) * 100) / 100;
      out.push({ date, lines: ['ACME LTD SALARY', 'BGC'], amount: 2450, balance: bal });
    }
  }
  return out;
}

const iso = (d) => d.toISOString().slice(0, 10);
const expected = (txns) => txns.map((t) => ({ date: iso(t.date), desc: t.lines.join(' '), amount: t.amount }));

// A: Money out / Money in / Balance; date once per day; amount on the first
// line of a wrapped description; thousands separators; two pages.
function layoutA() {
  const start = new Date(Date.UTC(2026, 2, 1));
  const txns = makeTxns(start, 61, 1000);
  let lastDay = '';
  const rows = txns.map((t) => {
    const day = `${String(t.date.getUTCDate()).padStart(2, '0')} ${MON[t.date.getUTCMonth()]}`;
    const show = day !== lastDay ? day : '';
    lastDay = day;
    return `<tr style="vertical-align:top"><td>${show}</td><td>${t.lines.join('<br>')}</td>
      <td class="n">${t.amount < 0 ? money(t.amount) : ''}</td><td class="n">${t.amount > 0 ? money(t.amount) : ''}</td><td class="n">${bal(t.balance)}</td></tr>`;
  }).join('');
  const html = `<style>${css}</style><h1>Example Bank — Current Account</h1>
    <p>Mr A Customer, 1 Any Street, Anytown AB1 2CD</p><p>Statement period: 1 March 2026 to 30 April 2026</p>
    <table><thead><tr><th>Date</th><th>Description</th><th class="n">Money out</th><th class="n">Money in</th><th class="n">Balance</th></tr></thead>
    <tbody><tr><td>01 Mar</td><td>Start balance</td><td></td><td></td><td class="n">1,000.00</td></tr>${rows}</tbody></table>
    <div class="foot">Example Bank plc is authorised by the Prudential Regulation Authority. Page</div>`;
  return { html, expected: expected(txns) };
}

// B: HSBC-like. Balance only on the last line of each day; description wraps
// above the amount; statement crosses New Year with year-less dates.
function layoutB() {
  const start = new Date(Date.UTC(2025, 11, 15));
  const txns = makeTxns(start, 31, 532.1);
  const byDay = new Map();
  for (const t of txns) {
    const k = iso(t.date);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(t);
  }
  let rows = '';
  for (const list of byDay.values()) {
    list.forEach((t, i) => {
      const d = t.date;
      const day = i === 0 ? `${String(d.getUTCDate()).padStart(2, '0')} ${MON[d.getUTCMonth()]}` : '';
      rows += `<tr style="vertical-align:bottom"><td style="vertical-align:top">${day}</td><td>${t.lines.join('<br>')}</td>
        <td class="n">${t.amount < 0 ? money(t.amount) : ''}</td><td class="n">${t.amount > 0 ? money(t.amount) : ''}</td>
        <td class="n">${i === list.length - 1 ? balD(t.balance) : ''}</td></tr>`;
    });
  }
  const html = `<style>${css}</style><h1>Your Statement</h1><p>15 December to 14 January 2026</p>
    <table><thead><tr><th>Date</th><th>Payment type and details</th><th class="n">Paid out</th><th class="n">Paid in</th><th class="n">Balance</th></tr></thead>
    <tbody><tr><td>15 Dec</td><td>BALANCE BROUGHT FORWARD</td><td></td><td></td><td class="n">532.10</td></tr>${rows}
    <tr><td>14 Jan</td><td>BALANCE CARRIED FORWARD</td><td></td><td></td><td class="n">${balD(txns[txns.length - 1].balance)}</td></tr></tbody></table>`;
  return { html, expected: expected(txns) };
}

// C: credit card. One Amount column, spending unsigned, payments "CR",
// full dates, no balance.
function layoutC() {
  const start = new Date(Date.UTC(2026, 4, 3));
  const txns = makeTxns(start, 28, 0).map((t) => ({ ...t, amount: t.amount > 0 ? 300 : t.amount, lines: t.amount > 0 ? ['PAYMENT RECEIVED - THANK YOU'] : t.lines }));
  const rows = txns.map((t) => {
    const d = t.date;
    const date = `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
    return `<tr><td>${date}</td><td>${t.lines.join(' ')}</td><td class="n">${money(t.amount)}${t.amount > 0 ? ' CR' : ''}</td></tr>`;
  }).join('');
  const html = `<style>${css}</style><h1>Example Card statement</h1><p>Card ending 4321</p>
    <table><thead><tr><th>Transaction date</th><th>Description</th><th class="n">Amount (£)</th></tr></thead><tbody>${rows}</tbody></table>`;
  return { html, expected: expected(txns) };
}

// D: NatWest layout (fake bank name and data). Summary box above the
// table; Paid In BEFORE Withdrawn; BROUGHT FORWARD row; two-line
// descriptions (type, then details) with the amount on the first line;
// balance on the last transaction of each day; overdrawn shown as "OD";
// legal footer on every page.
function layoutD() {
  const nw = (p, d) => {
    const ddmmmyy = `${String(d.getUTCDate()).padStart(2, '0')}${MON[d.getUTCMonth()].toUpperCase()}${String(d.getUTCFullYear()).slice(2)}`;
    const card = (m) => ['Card Transaction', `4637 ${ddmmmyy} C , ${m}`];
    return {
      'TESCO STORES 3021': card('TESCO STORES 3021 , LONDON GB'),
      'DD OCTOPUS ENERGY': ['Direct Debit', 'OCTOPUS ENERGY 12345678'],
      'CARD PAYMENT TO AMAZON': card('AMAZON* AB12C3D4E , AMAZON.CO.UK GB'),
      'SHELL PETROL': card('SHELL PETROL , READING GB'),
      'NETFLIX.COM': card('NETFLIX.COM , AMSTERDAM NL'),
      'COSTA COFFEE': card('COSTA COFFEE , LONDON GB'),
      'FASTER PAYMENT TO J SMITH': ['OnLine Transaction', 'J SMITH RENT VIA MOBILE - PYMT'],
      'SAINSBURYS S/MKT': ['Cash Withdrawal', 'LLOYDS BANK 06MAR'],
      'ACME LTD SALARY': ['Automated Credit', `ACME LTD SALARY FP ${ddmmmyy} 1234`],
    }[p[0]];
  };
  const start = new Date(Date.UTC(2026, 2, 1));
  const txns = makeTxns(start, 45, 150).map((t) => ({ ...t, lines: nw(t.lines, t.date) }));
  const byDay = new Map();
  for (const t of txns) {
    const k = iso(t.date);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(t);
  }
  const od = (n) => money(n) + (n < 0 ? ' OD' : '');
  let rows = '';
  for (const list of byDay.values()) {
    list.forEach((t, i) => {
      const d = t.date;
      const day = i === 0 ? `${String(d.getUTCDate()).padStart(2, '0')} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}` : '';
      rows += `<tr style="vertical-align:top"><td style="white-space:nowrap">${day}</td><td>${t.lines.join('<br>')}</td>
        <td class="n">${t.amount > 0 ? money(t.amount) : ''}</td><td class="n">${t.amount < 0 ? money(t.amount) : ''}</td>
        <td class="n">${i === list.length - 1 ? od(t.balance) : ''}</td></tr>`;
    });
  }
  const paidIn = txns.filter((t) => t.amount > 0).reduce((a, t) => a + t.amount, 0);
  const out = txns.filter((t) => t.amount < 0).reduce((a, t) => a - t.amount, 0);
  const html = `<style>${css}</style><h1>Example Bank</h1><p>Select Account &nbsp; Sort Code 60-00-01 &nbsp; Account No 12345678</p>
    <p>Period: 01 Mar 2026 to 14 Apr 2026</p>
    <table style="width:60%;margin-bottom:12px"><tr><td>Previous Balance</td><td class="n">£150.00</td><td>Paid In</td><td class="n">£${money(paidIn)}</td>
      <td>Withdrawn</td><td class="n">£${money(out)}</td><td>New Balance</td><td class="n">£${od(txns[txns.length - 1].balance)}</td></tr></table>
    <table><thead><tr><th>Date</th><th>Description</th><th class="n">Paid In(£)</th><th class="n">Withdrawn(£)</th><th class="n">Balance(£)</th></tr></thead>
    <tbody><tr><td>01 Mar 2026</td><td>BROUGHT FORWARD</td><td></td><td></td><td class="n">150.00</td></tr>${rows}</tbody></table>
    <div class="foot">Example Bank Plc. Registered Office: 1 Example Street, London EC2M 4AA. Registered in England and Wales No. 929027.</div>`;
  return { html, expected: expected(txns) };
}

// E: credit card with two dates per line (transaction, then posting a few
// days later), year-less dates, CR payments, no balance column, a summary
// box with credit limit, minimum payment and new balance, masked card number.
function layoutE() {
  const start = new Date(Date.UTC(2026, 4, 3));
  let owed = 250;
  const txns = makeTxns(start, 30, 0).map((t) => {
    const pay = t.amount > 0;
    const amount = pay ? 250 : t.amount;
    owed = Math.round((owed - amount) * 100) / 100;
    return { ...t, amount, lines: pay ? ['PAYMENT RECEIVED - THANK YOU'] : t.lines.slice(0, 1) };
  });
  const dm = (d) => `${String(d.getUTCDate()).padStart(2, '0')} ${MON[d.getUTCMonth()]}`;
  const rows = txns.map((t) => {
    const posted = new Date(t.date.getTime() + 2 * 86400000);
    return `<tr><td>${dm(t.date)}</td><td>${dm(posted)}</td><td>${t.lines.join(' ')}</td><td class="n">${money(t.amount)}${t.amount > 0 ? ' CR' : ''}</td></tr>`;
  }).join('');
  const html = `<style>${css}</style><h1>Example Bank Credit Card</h1><p>Card number XXXX XXXX XXXX 5678</p>
    <p>Statement date 04 Jun 2026</p>
    <table style="width:100%;margin-bottom:12px;white-space:nowrap"><tr><td>Credit limit</td><td class="n">£3,000.00</td><td>Minimum payment</td><td class="n">£25.00</td>
      <td>New balance</td><td class="n">£${money(owed)}</td></tr></table>
    <table><thead><tr><th>Transaction date</th><th>Posting date</th><th>Description</th><th class="n">Amount (£)</th></tr></thead><tbody>${rows}</tbody></table>`;
  return { html, expected: { owed, txns: expected(txns) } };
}

// F: card statement whose transactions start on page 3. Page 1 is a summary
// with a dated headings box and recent-payment lines; page 2 is interest
// rates and small print with dates and amounts. None of that is a transaction.
function layoutF() {
  const start = new Date(Date.UTC(2026, 7, 4));
  let owed = 180.25;
  const txns = makeTxns(start, 30, 0).map((t) => {
    const pay = t.amount > 0;
    const amount = pay ? 200 : t.amount;
    owed = Math.round((owed - amount) * 100) / 100;
    return { ...t, amount, lines: pay ? ['DIRECT DEBIT PAYMENT - THANK YOU'] : t.lines.slice(0, 1) };
  });
  const dm = (d) => `${String(d.getUTCDate()).padStart(2, '0')} ${MON[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`;
  const rows = txns.map((t) => {
    const posted = new Date(t.date.getTime() + 86400000);
    return `<tr><td>${dm(t.date)}</td><td>${dm(posted)}</td><td>${t.lines.join(' ')}</td><td class="n">${money(t.amount)}${t.amount > 0 ? ' CR' : ''}</td></tr>`;
  }).join('');
  const html = `<style>${css} .pb{page-break-before:always}</style>
    <h1>Example Bank Credit Card statement</h1><p>Mr A N Other, 1 Sample Road, Exampletown EX1 1AA</p><p>Account number 1234 5678 9012 3456</p>
    <table><thead><tr><th>Statement date</th><th>Payment due date</th><th class="n">New balance</th><th class="n">Minimum payment</th></tr></thead>
      <tbody><tr><td>03 Sep 2026</td><td>28 Sep 2026</td><td class="n">£${money(owed)}</td><td class="n">£25.00</td></tr></tbody></table>
    <h3>Your recent payments</h3><p>12 Aug 2026 Payment received £200.00</p>
    <table style="white-space:nowrap"><tr><td>Credit limit £4,500.00</td><td>Available credit £4,319.75</td><td>Previous balance £180.25</td></tr></table>
    <div class="pb"><h2>Interest and charges</h2>
      <table><tr><td>Purchases</td><td class="n">24.9%</td><td class="n">£0.00</td></tr><tr><td>Cash</td><td class="n">29.9%</td><td class="n">£0.00</td></tr></table>
      <p>01 Oct 2026 If you pay only the minimum each month you will pay £1,234.00 in interest.</p>
      <p>Late payment fee £12.00. Over limit fee £12.00. Returned payment fee £12.00.</p></div>
    <div class="pb"><h2>Your transactions</h2>
      <table><thead><tr><th>Transaction date</th><th>Posting date</th><th>Transaction details</th><th class="n">Amount £</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  return { html, expected: { owed, txns: expected(txns) } };
}

(async () => {
  const only = process.argv.slice(2);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const [name, make] of [['layout-a', layoutA], ['layout-b', layoutB], ['layout-c', layoutC], ['layout-d', layoutD], ['layout-e', layoutE], ['layout-f', layoutF]]) {
    if (only.length && !only.includes(name)) continue;
    const { html, expected: exp } = make();
    await page.setContent(html);
    await page.pdf({ path: path.join(__dirname, name + '.pdf'), format: 'A4', margin: { top: '15mm', bottom: '15mm', left: '12mm', right: '12mm' } });
    fs.writeFileSync(path.join(__dirname, name + '.json'), JSON.stringify(exp, null, 1));
    console.log(name, (exp.txns || exp).length, 'transactions');
  }
  await browser.close();
})();
