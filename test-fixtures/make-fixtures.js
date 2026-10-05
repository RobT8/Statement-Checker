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

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const [name, make] of [['layout-a', layoutA], ['layout-b', layoutB], ['layout-c', layoutC]]) {
    const { html, expected: exp } = make();
    await page.setContent(html);
    await page.pdf({ path: path.join(__dirname, name + '.pdf'), format: 'A4', margin: { top: '15mm', bottom: '15mm', left: '12mm', right: '12mm' } });
    fs.writeFileSync(path.join(__dirname, name + '.json'), JSON.stringify(exp, null, 1));
    console.log(name, exp.length, 'transactions');
  }
  await browser.close();
})();
