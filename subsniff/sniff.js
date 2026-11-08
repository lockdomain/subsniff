// SubSniff core: CSV parsing, column detection and recurring charge detection.
// Pure functions so they run the same in the browser and in Node tests.
(function (root) {
  // ---------- CSV ----------
  function detectDelimiter(text) {
    const sample = text.split(/\r?\n/).slice(0, 10).join('\n');
    const cands = [',', ';', '\t', '|'];
    let best = ',', bestScore = -1;
    for (const d of cands) {
      const counts = sample.split('\n').filter(Boolean).map((l) => splitLine(l, d).length);
      if (!counts.length) continue;
      const same = counts.filter((c) => c === counts[0]).length;
      const score = counts[0] > 1 ? same * counts[0] : 0;
      if (score > bestScore) { bestScore = score; best = d; }
    }
    return best;
  }
  function splitLine(line, d) {
    const out = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === d) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  }
  function parseCSV(text) {
    text = text.replace(/^﻿/, '');
    const d = detectDelimiter(text);
    const rows = text.split(/\r?\n/).filter((l) => l.trim()).map((l) => splitLine(l, d));
    return rows;
  }

  // ---------- values ----------
  function parseAmount(s) {
    if (s == null) return NaN;
    let t = String(s).trim();
    if (!t) return NaN;
    let neg = false;
    if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
    if (/^-|-$/.test(t.replace(/[^\d\-]/g, '').trim()) || /^\s*-/.test(t) || /-\s*$/.test(t)) neg = true;
    if (/\b(?:DR|debit)\b/i.test(t)) neg = true;
    t = t.replace(/[^\d.,]/g, '');
    if (!t) return NaN;
    const lc = t.lastIndexOf(','), ld = t.lastIndexOf('.');
    if (lc > ld) {
      // comma is decimal separator if followed by 1-2 digits
      if (t.length - lc - 1 <= 2) t = t.replace(/\./g, '').replace(',', '.');
      else t = t.replace(/,/g, '');
    } else t = t.replace(/,/g, '');
    const v = parseFloat(t);
    return neg ? -v : v;
  }
  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  function parseDate(s, order) {
    if (!s) return null;
    s = String(s).trim();
    let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (m) return mk(+m[1], +m[2] - 1, +m[3]);
    m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
    if (m) {
      let a = +m[1], b = +m[2], y = +m[3];
      if (y < 100) y += 2000;
      if (order === 'dmy' || a > 12 || (order !== 'mdy!' && /^\d{1,2}\.\d{1,2}\./.test(s) && b <= 12)) return mk(y, b - 1, a);
      return mk(y, a - 1, b);
    }
    m = s.match(/^(\d{1,2})[\s-]([A-Za-z]{3})[A-Za-z]*[\s-,]+(\d{2,4})/);
    if (m && MONTHS[m[2].toLowerCase()] != null) return mk(+m[3] < 100 ? +m[3] + 2000 : +m[3], MONTHS[m[2].toLowerCase()], +m[1]);
    m = s.match(/^([A-Za-z]{3})[A-Za-z]*\s+(\d{1,2}),?\s+(\d{4})/);
    if (m && MONTHS[m[1].toLowerCase()] != null) return mk(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
    const t = Date.parse(s);
    return isNaN(t) ? null : new Date(t);
  }
  function mk(y, mo, d) {
    const dt = new Date(Date.UTC(y, mo, d));
    return isNaN(dt) || dt.getUTCMonth() !== mo ? null : dt;
  }
  // decide between month/day and day/month by looking at all dates in the column
  function guessDateOrder(values) {
    for (const v of values) {
      const m = String(v).trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.]\d{2,4}/);
      if (!m) continue;
      if (+m[1] > 12) return 'dmy';
      if (+m[2] > 12) return 'mdy';
    }
    return 'mdy';
  }

  // ---------- columns ----------
  function detectColumns(rows) {
    const header = rows[0].map((h) => h.toLowerCase());
    const find = (re) => header.findIndex((h) => re.test(h));
    let date = find(/date|posted|time|дата|datum|buchung|fecha|data/);
    let desc = find(/desc|merchant|payee|name|details|memo|narrat|reference|counterparty|описан|назнач|verwendungszweck|beschreibung|empf|auftraggeber|libell|concepto|descri/);
    let amount = find(/^amount$|amount|sum|value|сумма|betrag|montant|importe|valor|kwota/);
    let debit = find(/debit|withdraw|paid out|money out|outflow|расход|списан/);
    let credit = find(/credit|deposit|paid in|money in|inflow|приход|зачисл/);
    const hasHeader = date >= 0 || desc >= 0 || amount >= 0 || debit >= 0;
    const body = hasHeader ? rows.slice(1) : rows;
    // fall back to sniffing column content
    const cols = rows[0].length;
    const score = (fn) => {
      const s = [];
      for (let c = 0; c < cols; c++) s[c] = body.slice(0, 40).filter((r) => fn(r[c])).length;
      return s;
    };
    if (date < 0) { const s = score((v) => parseDate(v) && /\d/.test(v || '')); date = s.indexOf(Math.max(...s)); }
    if (amount < 0 && debit < 0) {
      const s = score((v) => /\d/.test(v || '') && !isNaN(parseAmount(v)) && !parseDate(v));
      s[date] = -1;
      amount = s.indexOf(Math.max(...s));
    }
    if (desc < 0) {
      const s = score((v) => /[A-Za-zА-Яа-я]{3,}/.test(v || ''));
      desc = s.indexOf(Math.max(...s));
    }
    return { date, desc, amount, debit, credit, hasHeader };
  }

  function toTransactions(rows) {
    const cols = detectColumns(rows);
    const body = cols.hasHeader ? rows.slice(1) : rows;
    const order = guessDateOrder(body.map((r) => r[cols.date]));
    let tx = body.map((r) => {
      let amt;
      if (cols.amount >= 0 && r[cols.amount]) amt = parseAmount(r[cols.amount]);
      else if (cols.debit >= 0 && r[cols.debit]) amt = -Math.abs(parseAmount(r[cols.debit]));
      else if (cols.credit >= 0 && r[cols.credit]) amt = Math.abs(parseAmount(r[cols.credit]));
      return { date: parseDate(r[cols.date], order), desc: (r[cols.desc] || '').trim(), amount: amt };
    }).filter((t) => t.date && t.desc && !isNaN(t.amount) && t.amount !== 0);
    // If the bank writes spending as positive numbers (no negatives at all), treat everything as spending.
    const anyNeg = tx.some((t) => t.amount < 0);
    tx = tx.map((t) => ({ ...t, spend: anyNeg ? -t.amount : t.amount })).filter((t) => t.spend > 0);
    return { tx, cols };
  }

  // ---------- merchant names ----------
  const NOISE = /\b(pos|purchase|card|debit|credit|payment|recurring|online|www|com|inc|llc|ltd|gmbh|bv|visa|mastercard|mc|ach|direct|dd|sepa|transaction|trx|ref|txn|auth|pending|intl|international|bill|billing|autopay|subscription)\b/g;
  function merchantKey(desc) {
    let s = desc.toLowerCase();
    s = s.replace(/^(paypal|pp|sq|sp|tst|ppl)\s*\*\s*/, '');
    s = s.replace(/\*/g, ' ');
    s = s.replace(/https?:\/\/|\.com|\.net|\.io|\.co\b/g, ' ');
    s = s.replace(/[#:]\s*\w+/g, ' ');
    s = s.replace(/\d+/g, ' ');
    s = s.replace(/[^a-zа-я&+ ]/g, ' ');
    s = s.replace(NOISE, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    const words = s.split(' ').filter((w) => w.length > 1);
    return words.slice(0, 2).join(' ') || desc.toLowerCase().slice(0, 12);
  }
  function prettyName(descs) {
    // most common original description, cleaned for display
    const f = {};
    descs.forEach((d) => (f[d] = (f[d] || 0) + 1));
    let best = Object.keys(f).sort((a, b) => f[b] - f[a])[0];
    best = best.replace(/\*\s*[A-Za-z]*\d[A-Za-z0-9]*/g, ' ').replace(/\(?\b\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}\b/g, ' ').replace(/\b\d{3}-\d{4,}\b/g, ' ').replace(/\s+[A-Z]{2}\s*$/, '')
      .replace(/^(paypal|pp|sq|sp|tst)\s*\*\s*/i, '').replace(/\*/g, ' ').replace(/[#:]?\s*\d{4,}.*$/, '').replace(/\s{2,}/g, ' ').trim();
    best = best.replace(/[\s\-]+$/, '').replace(/\s{2,}/g, ' ');
    const KEEP = new Set(['USA', 'UK', 'EU', 'TV', 'AI', 'LLC', 'TB', 'GB', 'HBO', 'AWS', 'NYC']);
    return best.replace(/[A-Za-z][\w.'&\/]*/g, (w) => {
      if (KEEP.has(w.toUpperCase())) return w.toUpperCase();
      return w.length > 1 && w === w.toUpperCase() ? w[0] + w.slice(1).toLowerCase() : w;
    });
  }

  // ---------- recurring detection ----------
  const CADENCES = [
    { name: 'Weekly', days: 7, tol: 2, perYear: 52 },
    { name: 'Every 2 weeks', days: 14, tol: 3, perYear: 26 },
    { name: 'Monthly', days: 30.4, tol: 5, perYear: 12 },
    { name: 'Quarterly', days: 91, tol: 10, perYear: 4 },
    { name: 'Yearly', days: 365, tol: 20, perYear: 1 },
  ];
  const BILL = /rent|mortgage|loan|insurance|utilit|electric|water|gas co|internet|comcast|verizon|at&t|t-mobile|tmobile|tuition|lease|hoa|payroll|transfer|zelle|venmo/i;
  function kindOf(desc, amount) { return BILL.test(desc) || amount >= 400 ? 'bill' : 'sub'; }
  const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const DAY = 86400000;

  function findRecurring(tx) {
    const groups = {};
    tx.forEach((t) => { const k = merchantKey(t.desc); (groups[k] = groups[k] || []).push(t); });
    const latest = Math.max(...tx.map((t) => t.date.getTime()));
    const out = [];
    for (const key in groups) {
      const g = groups[key].sort((a, b) => a.date - b.date);
      if (g.length < 2) continue;
      // split a merchant into price bands so a $9.99 plan and random $45 purchases are not mixed
      const bands = [];
      g.forEach((t) => {
        const b = bands.find((x) => Math.abs(t.spend - x.ref) / x.ref <= 0.25);
        if (b) b.items.push(t); else bands.push({ ref: t.spend, items: [t] });
      });
      for (const band of bands) {
        const items = band.items;
        if (items.length < 2) continue;
        const gaps = [];
        for (let i = 1; i < items.length; i++) gaps.push((items[i].date - items[i - 1].date) / DAY);
        if (gaps.some((x) => x < 3)) {
          // several charges a few days apart is shopping, not a subscription
          if (gaps.filter((x) => x < 3).length / gaps.length > 0.3) continue;
        }
        const mg = median(gaps);
        const cad = CADENCES.find((c) => Math.abs(mg - c.days) <= c.tol);
        if (!cad) continue;
        const fit = gaps.filter((x) => Math.abs(x - cad.days) <= cad.tol * 1.6).length / gaps.length;
        const amounts = items.map((t) => t.spend);
        const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
        const cv = Math.sqrt(amounts.reduce((a, b) => a + (b - mean) ** 2, 0) / amounts.length) / mean;
        const enough = cad.perYear >= 12 ? items.length >= 3 : items.length >= 2;
        if (fit < 0.6 || cv > 0.2 || !enough) continue;
        const last = items[items.length - 1];
        const typical = median(amounts);
        const firstAmt = items[0].spend;
        const changedAt = items.find((t) => t.spend > firstAmt * 1.03);
        const lastDays = (latest - last.date.getTime()) / DAY;
        const active = lastDays <= cad.days + cad.tol * 2 + 3;
        out.push({
          key,
          name: prettyName(items.map((t) => t.desc)),
          cadence: cad.name,
          count: items.length,
          amount: last.spend,
          typical,
          yearly: last.spend * cad.perYear,
          monthly: (last.spend * cad.perYear) / 12,
          first: items[0].date,
          last: last.date,
          next: new Date(last.date.getTime() + cad.days * DAY),
          priceUp: last.spend > firstAmt * 1.03 ? { from: firstAmt, to: last.spend, at: changedAt.date } : null,
          kind: kindOf(items[0].desc, last.spend),
          active,
          confidence: Math.round((fit * 0.6 + (1 - Math.min(cv / 0.2, 1)) * 0.4) * 100),
        });
      }
    }
    // single charges that say they are annual renewals
    const seenKeys = new Set(out.map((o) => o.key));
    for (const key in groups) {
      if (seenKeys.has(key)) continue;
      const g = groups[key];
      const yearly = g.filter((t) => /annual|yearly|renewal|membership|1 ?yr|12 ?mo/i.test(t.desc));
      if (!yearly.length || g.length > 3) continue;
      const last = yearly.sort((a, b) => a.date - b.date)[yearly.length - 1];
      out.push({
        key, name: prettyName([last.desc]).replace(/\s*\b(annual|yearly)\b/i, ''), cadence: 'Yearly', count: yearly.length,
        amount: last.spend, typical: last.spend, yearly: last.spend, monthly: last.spend / 12,
        first: yearly[0].date, last: last.date, next: new Date(last.date.getTime() + 365 * DAY),
        priceUp: null, active: true, confidence: 70, kind: kindOf(last.desc, last.spend),
      });
    }
    return out.sort((a, b) => (b.active - a.active) || b.yearly - a.yearly);
  }

  function analyze(text) {
    const rows = parseCSV(text);
    if (rows.length < 2) return { error: 'The file looks empty.' };
    const { tx, cols } = toTransactions(rows);
    if (tx.length < 3) return { error: 'Could not find dates, descriptions and amounts in this file.', cols };
    const subs = findRecurring(tx);
    const from = new Date(Math.min(...tx.map((t) => t.date.getTime())));
    const to = new Date(Math.max(...tx.map((t) => t.date.getTime())));
    return { subs, tx, cols, from, to };
  }

  const api = { parseCSV, parseAmount, parseDate, detectColumns, toTransactions, merchantKey, findRecurring, analyze };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SubSniff = api;
})(this);
