// SubSniff UI. The file is read with FileReader; nothing is sent anywhere.
(() => {
  const $ = (id) => document.getElementById(id);
  let data = null;
  const cut = new Set();
  let currency = 'USD';
  try { currency = localStorage.getItem('subsniff.cur') || 'USD'; } catch {}
  $('cur').value = currency;

  const fmt = (n, dec = 2) => new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: dec, minimumFractionDigits: dec }).format(n);
  const fmt0 = (n) => fmt(n, 0);
  const day = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------- input ----------
  const drop = $('drop');
  $('file').onchange = (e) => e.target.files[0] && readFile(e.target.files[0]);
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) readFile(e.dataTransfer.files[0]); });
  $('sample').onclick = async () => run(await (await fetch('sample-statement.csv')).text());
  $('again').onclick = () => { $('results').hidden = true; $('hero').hidden = false; cut.clear(); window.scrollTo(0, 0); };
  $('cur').onchange = (e) => { currency = e.target.value; try { localStorage.setItem('subsniff.cur', currency); } catch {} render(); };

  function readFile(f) {
    const r = new FileReader();
    r.onload = () => run(r.result);
    r.readAsText(f);
  }
  function run(text) {
    const res = SubSniff.analyze(text);
    if (res.error) { drop.querySelector('.muted').textContent = res.error + ' Try another export.'; return; }
    data = res;
    cut.clear();
    $('hero').hidden = true;
    $('results').hidden = false;
    render();
    window.scrollTo(0, 0);
  }

  // ---------- render ----------
  function row(s, i, selectable) {
    const el = document.createElement('div');
    el.className = 'item' + (cut.has(s.key + s.cadence) ? ' cut' : '');
    const badges = [`<span class="badge">${s.cadence}</span>`];
    if (s.priceUp) badges.push(`<span class="badge up">Up ${Math.round((s.priceUp.to / s.priceUp.from - 1) * 100)}% from ${fmt(s.priceUp.from)}</span>`);
    const when = s.active ? `Next around ${day(s.next)}` : `Last charged ${day(s.last)}`;
    el.innerHTML = `
      ${selectable ? `<input type="checkbox" aria-label="Mark ${esc(s.name)} to cancel" ${cut.has(s.key + s.cadence) ? 'checked' : ''}>` : '<span></span>'}
      <div><div class="nm">${esc(s.name)}</div><div class="sub">${badges.join('')}<span>${s.count} charge${s.count === 1 ? '' : 's'} since ${day(s.first)}</span><span>${when}</span></div></div>
      <div class="amt"><b>${fmt(s.amount)}</b><span>${fmt0(s.yearly)} / year</span></div>`;
    if (selectable) {
      el.querySelector('input').onchange = (e) => {
        if (e.target.checked) cut.add(s.key + s.cadence); else cut.delete(s.key + s.cadence);
        el.classList.toggle('cut', e.target.checked);
        updateSave();
      };
    }
    return el;
  }
  function groups() {
    const subs = data.subs.filter((s) => s.active && s.kind === 'sub');
    const bills = data.subs.filter((s) => s.active && s.kind === 'bill');
    const ended = data.subs.filter((s) => !s.active);
    return { subs, bills, ended };
  }
  function render() {
    if (!data) return;
    const { subs, bills, ended } = groups();
    const monthly = subs.reduce((a, s) => a + s.monthly, 0);
    const yearly = subs.reduce((a, s) => a + s.yearly, 0);
    const ups = subs.filter((s) => s.priceUp);
    $('sMonthly').textContent = fmt(monthly) + '/mo';
    $('sCount').textContent = `${subs.length} active subscription${subs.length === 1 ? '' : 's'}`;
    $('sYearly').textContent = fmt0(yearly);
    $('sRange').textContent = 'what they cost over 12 months';
    $('sUp').textContent = ups.length;
    $('sUpTxt').textContent = ups.length
      ? `+${fmt0(ups.reduce((a, s) => a + (s.priceUp.to - s.priceUp.from) * (s.yearly / s.amount), 0))} a year since they changed`
      : 'no price changes spotted';

    const list = $('list');
    list.innerHTML = '';
    if (!subs.length) list.innerHTML = '<p class="muted">No subscriptions found in this file. Try a longer date range.</p>';
    subs.forEach((s, i) => list.appendChild(row(s, i, true)));

    $('bills').innerHTML = '';
    bills.forEach((s, i) => $('bills').appendChild(row(s, i, false)));
    $('billsN').textContent = bills.length ? `(${bills.length}, ${fmt0(bills.reduce((a, s) => a + s.yearly, 0))} a year)` : '';
    $('billsWrap').hidden = !bills.length;

    $('ended').innerHTML = '';
    ended.forEach((s, i) => $('ended').appendChild(row(s, i, false)));
    $('endedN').textContent = ended.length ? `(${ended.length})` : '';
    $('endedWrap').hidden = !ended.length;

    $('meta').textContent = `Analyzed ${data.tx.length} payments from ${day(data.from)} to ${day(data.to)}. Detection looks for the same merchant charging a similar amount on a regular schedule. Double check before you cancel anything.`;
    updateSave();
  }
  function updateSave() {
    const { subs } = groups();
    const chosen = subs.filter((s) => cut.has(s.key + s.cadence));
    const yr = chosen.reduce((a, s) => a + s.yearly, 0);
    $('saveAmt').textContent = chosen.length ? `Save ${fmt0(yr)} a year` : '';
    $('save').querySelector('span').textContent = chosen.length
      ? `${chosen.length} marked to cancel`
      : 'Tick what you want to cancel';
  }

  $('export').onclick = () => {
    const lines = [['Name', 'Type', 'Cadence', 'Amount', 'Per year', 'Last charge', 'Next expected', 'Price change', 'Cancel']];
    data.subs.forEach((s) => lines.push([
      s.name, s.active ? (s.kind === 'bill' ? 'Bill' : 'Subscription') : 'Stopped', s.cadence, s.amount.toFixed(2), s.yearly.toFixed(2),
      s.last.toISOString().slice(0, 10), s.active ? s.next.toISOString().slice(0, 10) : '',
      s.priceUp ? `${s.priceUp.from.toFixed(2)} to ${s.priceUp.to.toFixed(2)}` : '', cut.has(s.key + s.cadence) ? 'yes' : '',
    ]));
    const csv = lines.map((l) => l.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = 'subscriptions.csv';
    a.click();
  };
})();
