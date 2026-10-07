/*
 * Statement Check — reading PDF bank statements.
 *
 * A PDF has no table, only words with x/y positions. This rebuilds the rows:
 *   1. group words into lines by their y position, and words into cells by gaps
 *   2. find the column headings ("Paid out", "Paid in", "Balance"...) so each
 *      amount can be assigned to a column by where it sits on the page
 *   3. walk the lines: a date starts a new day, an amount finishes a
 *      transaction, and text-only lines are wrapped descriptions
 *   4. where there's a running balance, use it to settle whether an amount
 *      was money in or out
 *
 * Pure functions over plain { str, x, y, w } items, so they're testable
 * without pdf.js. Needs analyse.js (SC) for amount and date parsing.
 */
(function (root) {
  'use strict';

  const SC = root.SC || (typeof require === 'function' ? require('./analyse.js') : null);

  const MONEY_RE = /^\(?-?[£$€]?\s?-?\d{1,3}(?:,\d{3})*\.\d{2}\)?(?:\s?(?:CR|DR|OD|D|C|-))?$|^\(?-?[£$€]?\s?-?\d+\.\d{2}\)?(?:\s?(?:CR|DR|OD|D|C|-))?$/i;
  const SKIP_RE = /brought forward|carried forward|opening balance|closing balance|balance b\/?f|balance c\/?f|start(?:ing)? balance|end(?:ing)? balance|previous balance|balance from previous|new balance/i;
  const NOISE_RE = /^(page \d+( of \d+)?|total|totals|continued|sub-?total)\b/i;
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

  // ------------------------------------------------------- lines & cells ----

  // pages: [{ items: [{ str, x, y, w, h }] }], y measured upwards (PDF space).
  function linesFromPages(pages) {
    const lines = [];
    pages.forEach((page, p) => {
      const items = page.items.filter((it) => it.str && it.str.trim());
      items.sort((a, b) => b.y - a.y || a.x - b.x);
      const rows = [];
      for (const it of items) {
        const tol = Math.max(2, (it.h || 10) * 0.45);
        const row = rows.find((r) => Math.abs(r.y - it.y) <= tol);
        if (row) row.items.push(it); else rows.push({ y: it.y, items: [it] });
      }
      rows.sort((a, b) => b.y - a.y);
      for (const r of rows) {
        r.items.sort((a, b) => a.x - b.x);
        const cells = [];
        for (const it of r.items) {
          const last = cells[cells.length - 1];
          const gap = last ? it.x - last.x1 : Infinity;
          const space = Math.max(1.5, (it.h || 10) * 0.6);
          if (last && gap < space) {
            last.text += (gap > (it.h || 10) * 0.15 && !/\s$/.test(last.text) && !/^\s/.test(it.str) ? ' ' : '') + it.str;
            last.x1 = it.x + (it.w || 0);
          } else {
            cells.push({ text: it.str, x0: it.x, x1: it.x + (it.w || 0) });
          }
        }
        for (const c of cells) c.text = c.text.replace(/\s+/g, ' ').trim();
        lines.push({ page: p, y: r.y, cells: cells.filter((c) => c.text) });
      }
    });
    return lines;
  }

  // A cell may hold "Tesco Stores 12.00" if the PDF put them close together;
  // peel trailing amounts off into cells of their own.
  function splitMoneyCells(cells) {
    const out = [];
    for (const c of cells) {
      const parts = c.text.split(' ');
      const tail = [];
      while (parts.length > 1) {
        const last = parts[parts.length - 1];
        const withSuffix = parts.length > 2 && /^(CR|DR)$/i.test(last) ? parts[parts.length - 2] + ' ' + last : null;
        if (withSuffix && MONEY_RE.test(withSuffix)) { tail.unshift(withSuffix); parts.splice(-2, 2); }
        else if (MONEY_RE.test(last)) { tail.unshift(last); parts.pop(); }
        else break;
      }
      if (!tail.length) { out.push(c); continue; }
      // Approximate positions: share the cell's width by character count.
      const all = [parts.join(' '), ...tail];
      const total = all.join(' ').length || 1;
      let cursor = c.x0;
      const per = (c.x1 - c.x0) / total;
      all.forEach((t, i) => {
        if (!t) return;
        const x0 = cursor;
        cursor += (t.length + (i < all.length - 1 ? 1 : 0)) * per;
        out.push({ text: t, x0, x1: i === all.length - 1 ? c.x1 : cursor - per });
      });
    }
    return out;
  }

  // ------------------------------------------------------------- headers ----

  function classifyHeading(text) {
    const t = text.toLowerCase();
    if (/balance/.test(t)) return 'balance';
    if (/paid out|money out|withdraw|debits?\b|payments? out|^out\b|spent|outgoings?/.test(t)) return 'debit';
    if (/paid in|money in|deposits?|credits?\b|receipts?|^in\b|incoming/.test(t)) return 'credit';
    if (/amount|value|sum\b/.test(t)) return 'amount';
    if (/date/.test(t)) return 'date';
    if (/description|details|transaction|narrative|particulars|payee|merchant/.test(t)) return 'desc';
    return null;
  }

  function readHeader(line) {
    const roles = line.cells.map((c) => ({ role: classifyHeading(c.text), text: c.text, x0: c.x0, x1: c.x1, cx: (c.x0 + c.x1) / 2 }));
    const has = (r) => roles.some((x) => x.role === r);
    const money = ['debit', 'credit', 'balance', 'amount'].filter(has);
    if (!has('date') || !money.length) return null;
    // Some statements put "Paid out" and "Paid in" in one cell; split by text.
    return roles.filter((r) => r.role);
  }

  // ---------------------------------------------------------------- dates ----

  function findYears(lines) {
    const years = [];
    for (const l of lines) {
      for (const c of l.cells) {
        const m = c.text.match(/\b(19|20)\d{2}\b/g);
        if (m) years.push(...m.map(Number).filter((y) => y >= 1990 && y <= 2100));
      }
    }
    return years;
  }

  function monthNum(name) {
    return MONTHS[name.slice(0, 3).toLowerCase()] || 0;
  }

  // Dates at the start of a line: full ("05/03/2026", "5 Mar 2026") or
  // year-less ("05 Mar", "05/03"). Returns { date, used } where used is how
  // many cells the date took, or null.
  function leadingDate(cells, ctx) {
    const pad = (n) => String(n).padStart(2, '0');
    for (const take of [3, 2, 1]) {
      if (cells.length < take) continue;
      const text = cells.slice(0, take).map((c) => c.text).join(' ');
      // Full dates
      let m = text.match(/^(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}(?:st|nd|rd|th)?[\s-]+[A-Za-z]{3,9}[\s-,]+\d{2,4}|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})$/);
      if (m) {
        const d = SC.parseDate(m[1], ctx.order);
        if (d) { ctx.year = +d.slice(0, 4); ctx.month = +d.slice(5, 7); return { date: d, used: take }; }
      }
      // Year-less
      let day = 0;
      let mon = 0;
      if ((m = text.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]{3,9})\.?$/)) && monthNum(m[2])) { day = +m[1]; mon = monthNum(m[2]); }
      else if ((m = text.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})$/)) && monthNum(m[1])) { day = +m[2]; mon = monthNum(m[1]); }
      else if ((m = text.match(/^(\d{1,2})[/.](\d{1,2})$/))) {
        [day, mon] = ctx.order === 'MDY' ? [+m[2], +m[1]] : [+m[1], +m[2]];
      }
      if (day && mon >= 1 && mon <= 12 && day <= 31) {
        if (ctx.month && mon < ctx.month - 6) ctx.year++; // Dec -> Jan
        else if (ctx.month && mon > ctx.month + 6) ctx.year--; // statements listed newest first
        ctx.month = mon;
        const d = SC.parseDate(`${ctx.year}-${pad(mon)}-${pad(day)}`);
        if (d) return { date: d, used: take };
      }
    }
    return null;
  }

  // ------------------------------------------------------------- parsing ----

  function nearestColumn(cols, cell) {
    let best = null;
    let bestD = Infinity;
    for (const c of cols) {
      if (!['debit', 'credit', 'balance', 'amount'].includes(c.role)) continue;
      // Amounts are right-aligned under their heading; compare right edges,
      // falling back to centres for centred headings.
      const d = Math.min(Math.abs(c.x1 - cell.x1), Math.abs(c.cx - (cell.x0 + cell.x1) / 2));
      if (d < bestD) { bestD = d; best = c; }
    }
    return best ? best.role : null;
  }

  function parseStatement(pages, options) {
    const opts = options || {};
    const lines = mergeHeaderLines(linesFromPages(pages).map((l) => ({ ...l, cells: splitMoneyCells(l.cells) })));
    const textCount = lines.reduce((n, l) => n + l.cells.length, 0);
    const result = { txns: [], skipped: 0, hasBalance: false, balanceChecked: 0, balanceOk: 0, scanned: textCount < 15, columns: null };
    if (result.scanned) return result;

    const years = findYears(lines);
    const allText = lines.map((l) => l.cells.map((c) => c.text).join(' '));
    const order = opts.dateOrder || SC.detectDateOrder(allText.flatMap((t) => t.split(' ')));
    // Year-less dates ("05 Mar") take their year from the statement. The year
    // printed is usually the latest one ("15 December to 14 January 2026"),
    // so read once from there, count the New Year roll-overs, then step back.
    const thisYear = new Date().getFullYear();
    const plausible = years.filter((y) => y <= thisYear + 1);
    const latest = plausible.length ? Math.max(...plausible) : thisYear;
    const trial = classify(lines, { order, year: latest, month: 0 });
    const rows = classify(lines, { order, year: latest - (trial.endYear - latest), month: 0 }).rows;
    result.columns = rows.some((r) => r.kind === 'header');
    result.account = detectAccount(allText);
    result.statementBalance = statementBalance(lines);
    return buildTxns(rows, result);
  }

  // Which account the statement is for: a card (credit limit and minimum
  // payment, or a masked 16-digit card number) or a bank account (sort code
  // and account number). last4 tells two accounts of the same kind apart.
  function detectAccount(textLines) {
    const t = textLines.join('\n');
    const masked = t.match(/(?:[*xX•]{4}[\s-]?){3}(\d{4})\b/) || t.match(/card (?:number )?ending(?: in)?:?\s*(\d{4})\b/i);
    const sortCode = /sort code/i.test(t);
    const card = (/credit limit/i.test(t) && /minimum payment/i.test(t)) || (!!masked && !sortCode);
    let last4 = '';
    if (card && masked) last4 = masked[1];
    else {
      const acc = t.match(/account (?:number|no\.?)\s*:?\s*(\d{8})\b/i) || t.match(/\b\d{2}-\d{2}-\d{2}\s+(\d{8})\b/);
      if (acc) last4 = acc[1].slice(-4);
    }
    return { type: card ? 'card' : 'current', last4 };
  }

  // The statement's closing balance from its summary ("New balance £412.30"),
  // which is all a card statement offers. Null if there isn't one.
  function statementBalance(lines) {
    const re = /\b(?:new|closing|statement|current) balance\b[^\d£$€-]{0,20}(-?[£$€]?\s?[\d,]+\.\d{2}(?:\s?(?:CR|DR|OD|D)\b)?)/i;
    for (const l of lines) {
      const m = l.cells.map((c) => c.text).join(' ').match(re);
      const v = m ? SC.parseAmount(m[1]) : null;
      if (v !== null) return v;
    }
    return null;
  }

  // Narrow columns wrap their headings ("Paid" over "In(£)"). Fold short
  // word-only lines just above or below a heading line into it, joining
  // words that sit over each other.
  function mergeHeaderLines(lines) {
    const out = [];
    const used = new Set();
    lines.forEach((l, i) => {
      if (used.has(i)) return;
      if (!readHeader(l)) { out.push(l); return; }
      const near = (j) => {
        const n = lines[j];
        if (!n || used.has(j) || n.page !== l.page || Math.abs(n.y - l.y) > 16) return false;
        return n.cells.every((c) => c.text.length <= 14 && !MONEY_RE.test(c.text) && !/\d/.test(c.text));
      };
      const cells = l.cells.map((c) => ({ ...c }));
      for (const j of [i - 1, i + 1]) {
        if (!near(j)) continue;
        used.add(j);
        if (j === i - 1 && out[out.length - 1] === lines[j]) out.pop();
        for (const c of lines[j].cells) {
          const hit = cells.find((h) => c.x0 < h.x1 && c.x1 > h.x0);
          if (hit) {
            hit.text = j < i ? c.text + ' ' + hit.text : hit.text + ' ' + c.text;
            hit.x0 = Math.min(hit.x0, c.x0);
            hit.x1 = Math.max(hit.x1, c.x1);
          } else cells.push({ ...c });
        }
      }
      cells.sort((a, b) => a.x0 - b.x0);
      out.push({ ...l, cells });
    });
    return out;
  }

  // Pass 1: what each line is — a heading, a dated line, amounts, words.
  function classify(lines, ctx) {
    let cols = null;
    const rows = [];
    for (const l of lines) {
      const header = readHeader(l);
      if (header) { cols = header; rows.push({ kind: 'header' }); continue; }
      const text = l.cells.map((c) => c.text).join(' ');
      const dated = leadingDate(l.cells, ctx);
      let rest = dated ? l.cells.slice(dated.used) : l.cells;
      // Card statements often give two dates: when you spent and when it was
      // posted. Keep the transaction date, whichever column it's in.
      const dateCols = cols ? cols.filter((c) => c.role === 'date') : [];
      if (dated && dateCols.length >= 2) {
        const second = leadingDate(rest, { ...ctx });
        if (second) {
          rest = rest.slice(second.used);
          if (/trans/i.test(dateCols[1].text) && !/trans/i.test(dateCols[0].text)) dated.date = second.date;
        }
      }
      const money = rest.filter((c) => MONEY_RE.test(c.text));
      const words = rest.filter((c) => !MONEY_RE.test(c.text));
      rows.push({ kind: 'line', page: l.page, y: l.y, date: dated ? dated.date : null, money, words, text, cols, skip: SKIP_RE.test(text), noise: NOISE_RE.test(text) });
    }
    return { rows, endYear: ctx.year };
  }

  function buildTxns(rows, result) {
    // Which amount line does each wrapped text line belong to? Lines of one
    // description sit closer together than separate rows, so each text line
    // follows its nearer neighbouring line (and that line's owner). A date
    // marks the start of a row, so nothing attaches upwards across one.
    const isTxn = (r) => r.kind === 'line' && r.money.length > 0 && !r.skip && !r.noise;
    const txnRows = rows.filter((r) => isTxn(r) && r.words.length);
    const descX = median(txnRows.map((r) => r.words[0].x0));
    let seenDate = false;
    const isText = rows.map((r) => {
      if (r.kind === 'line' && r.date) seenDate = true;
      if (r.kind !== 'line' || r.money.length || r.skip || r.noise || !r.words.length || !seenDate) return false;
      return !(descX > 0 && r.words[0].x0 < descX - 20 && !r.date); // footers, legal text
    });
    const linkable = (j, i) => j >= 0 && j < rows.length && rows[j].kind === 'line' && !rows[j].skip && rows[j].page === rows[i].page && (isTxn(rows[j]) || isText[j]);
    const dir = rows.map((r, i) => {
      if (!isText[i]) return null;
      const canUp = !r.date && linkable(i - 1, i);
      const canDown = linkable(i + 1, i) && !(rows[i + 1].date && !(r.date && isTxn(rows[i + 1])));
      if (!canUp && !canDown) return null;
      if (!canDown) return -1;
      if (!canUp) return 1;
      const gUp = Math.abs(rows[i - 1].y - r.y);
      const gDown = Math.abs(r.y - rows[i + 1].y);
      return gUp <= gDown + 0.5 ? -1 : 1;
    });
    const owner = (i, seen) => {
      if (isTxn(rows[i])) return i;
      if (!dir[i] || seen.has(i)) return -1;
      seen.add(i);
      return owner(i + dir[i], seen);
    };
    const extra = new Map(); // row index -> { before: [], after: [] }
    rows.forEach((r, i) => {
      if (!isText[i]) return;
      const o = owner(i, new Set());
      if (o < 0) return;
      if (!extra.has(o)) extra.set(o, { before: [], after: [] });
      extra.get(o)[i < o ? 'before' : 'after'].push(r.words.map((c) => c.text).join(' '));
    });

    let date = null;
    let lastBalance = null;
    rows.forEach((r, i) => {
      if (r.kind === 'header') return;
      if (r.date) date = r.date;
      if (r.skip) {
        // "Balance brought forward" seeds the running balance.
        const v = r.money.length ? SC.parseAmount(r.money[r.money.length - 1].text) : null;
        // Only inside the table: a summary box above it ("New balance") would mislead.
        if (v !== null && r.cols) lastBalance = v;
        return;
      }
      if (r.noise || !r.money.length) return;
      const wordsText = r.words.map((c) => c.text).join(' ');
      if (!date) { result.skipped++; return; }

      // Assign each amount on the line to a column.
      let amount = null;
      let balance = null;
      let signKnown = false;
      if (r.cols && r.cols.some((c) => c.role !== 'date' && c.role !== 'desc')) {
        for (const cell of r.money) {
          const v = SC.parseAmount(cell.text);
          const role = nearestColumn(r.cols, cell);
          if (role === 'balance') balance = v;
          else if (role === 'debit') { amount = -Math.abs(v); signKnown = true; }
          else if (role === 'credit') { amount = Math.abs(v); signKnown = true; }
          else if (role === 'amount') { amount = v; signKnown = /-|\(|CR|DR/i.test(cell.text); }
        }
      } else {
        const vals = r.money.map((c) => ({ v: SC.parseAmount(c.text), t: c.text }));
        if (vals.length >= 2) { balance = vals[vals.length - 1].v; amount = vals[0].v; signKnown = /-|\(|CR|DR/i.test(vals[0].t); }
        else { amount = vals[0].v; signKnown = /-|\(|CR|DR/i.test(vals[0].t); }
      }
      if (amount === null || amount === 0) {
        if (balance !== null) lastBalance = balance; // a balance-only row
        return;
      }
      if (balance !== null) result.hasBalance = true;

      // The running balance settles in or out, and checks the reading.
      if (balance !== null && lastBalance !== null) {
        const a = Math.abs(amount);
        const asIn = Math.abs(round2(lastBalance + a) - balance) < 0.015;
        const asOut = Math.abs(round2(lastBalance - a) - balance) < 0.015;
        if (asIn !== asOut) amount = asIn ? a : -a; // the balance outranks a column guess
        result.balanceChecked++;
        if (Math.abs(round2(lastBalance + amount) - balance) < 0.015) result.balanceOk++;
      } else if (!signKnown) {
        amount = -Math.abs(amount); // no evidence: most lines are spending
      }

      const ex = extra.get(i) || { before: [], after: [] };
      const desc = [...ex.before, wordsText, ...ex.after].filter(Boolean).join(' ') || '(no description)';
      result.txns.push({ date, desc, amount: round2(amount), balance });
      lastBalance = balance !== null ? balance : lastBalance !== null ? round2(lastBalance + amount) : null;
    });
    for (const t of result.txns) t.desc = t.desc.replace(/\s+/g, ' ').trim().slice(0, 200);
    return result;
  }

  function round2(n) { return Math.round(n * 100) / 100; }

  function median(xs) {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    return s[s.length >> 1];
  }

  // pdf.js glue: turns a loaded document into the plain pages above.
  async function pagesFromPdf(doc) {
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      pages.push({
        items: tc.items.filter((it) => 'str' in it).map((it) => ({
          str: it.str,
          x: it.transform[4],
          y: it.transform[5],
          w: it.width,
          h: Math.abs(it.transform[3]) || it.height || 10,
        })),
      });
      page.cleanup();
    }
    return pages;
  }

  const api = { detectAccount, statementBalance, linesFromPages, splitMoneyCells, parseStatement, pagesFromPdf, MONEY_RE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PDFS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
