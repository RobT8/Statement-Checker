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

  const MONEY_RE = /^\(?-?[£$€]?\s?-?\d{1,3}(?:,\d{3})*\.\d{2}\)?(?:\s?(?:CR|DR|D|C|-))?$|^\(?-?[£$€]?\s?-?\d+\.\d{2}\)?(?:\s?(?:CR|DR|D|C|-))?$/i;
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
    const roles = line.cells.map((c) => ({ role: classifyHeading(c.text), x0: c.x0, x1: c.x1, cx: (c.x0 + c.x1) / 2 }));
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
    const lines = linesFromPages(pages).map((l) => ({ ...l, cells: splitMoneyCells(l.cells) }));
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
    return buildTxns(rows, result);
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
      const rest = dated ? l.cells.slice(dated.used) : l.cells;
      const money = rest.filter((c) => MONEY_RE.test(c.text));
      const words = rest.filter((c) => !MONEY_RE.test(c.text));
      rows.push({ kind: 'line', page: l.page, y: l.y, date: dated ? dated.date : null, money, words, text, cols, skip: SKIP_RE.test(text), noise: NOISE_RE.test(text) });
    }
    return { rows, endYear: ctx.year };
  }

  function buildTxns(rows, result) {
    // Which amount line does each wrapped text line belong to? The nearer
    // one: lines of one description sit closer together than separate rows
    // do. A date marks the start of a row, so nothing attaches across one.
    const isTxn = (r) => r.kind === 'line' && r.money.length > 0 && !r.skip && !r.noise;
    const txnRows = rows.filter((r) => isTxn(r) && r.words.length);
    const descX = median(txnRows.map((r) => r.words[0].x0));
    const extra = new Map(); // row index -> { before: [], after: [] }
    const slot = (j) => { if (!extra.has(j)) extra.set(j, { before: [], after: [] }); return extra.get(j); };
    let seenDate = false;
    rows.forEach((r, i) => {
      if (r.kind === 'line' && r.date) seenDate = true;
      if (r.kind !== 'line' || r.money.length || r.skip || r.noise || !r.words.length || !seenDate) return;
      if (descX > 0 && r.words[0].x0 < descX - 20 && !r.date) return; // footers, legal text
      const search = (step) => {
        for (let j = i + step; j >= 0 && j < rows.length; j += step) {
          const q = rows[j];
          if (q.kind !== 'line' || q.skip || q.page !== r.page) return -1;
          if (step > 0 && q.date) return isTxn(q) && r.date ? j : -1;
          if (isTxn(q)) return j;
          if (step < 0 && q.date) return -1;
        }
        return -1;
      };
      const up = r.date ? -1 : search(-1);
      const down = search(1);
      if (up < 0 && down < 0) return;
      const text = r.words.map((c) => c.text).join(' ');
      const useUp = down < 0 || (up >= 0 && Math.abs(rows[up].y - r.y) <= Math.abs(rows[down].y - r.y) + 0.5);
      if (useUp) slot(up).after.push(text); else slot(down).before.push(text);
    });

    let date = null;
    let lastBalance = null;
    rows.forEach((r, i) => {
      if (r.kind === 'header') return;
      if (r.date) date = r.date;
      if (r.skip) {
        // "Balance brought forward" seeds the running balance.
        const v = r.money.length ? SC.parseAmount(r.money[r.money.length - 1].text) : null;
        if (v !== null) lastBalance = v;
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
        if (!signKnown && (asIn || asOut)) amount = asIn && !asOut ? a : asOut && !asIn ? -a : amount;
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

  const api = { linesFromPages, splitMoneyCells, parseStatement, pagesFromPdf, MONEY_RE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PDFS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
