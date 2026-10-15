import { fmt, pct, HTF_FOR } from './analysis.js';
import { TIMEFRAMES, fetchPrices, fetchMinuteCandlesSince, fetchTicker } from './data.js';
import * as J from './journal.js';
import { ask, money } from './coach.js';
import { parse, readMarket, cached, ticket, HELP, UNKNOWN, GOLD } from './bot.js';
import { loadCalendar, upcoming, conditions, fmtIn } from './news.js';

const $ = sel => document.querySelector(sel);
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
};

const state = {
  symbol: GOLD,
  calendar: null,
  scan: {},
  seen: new Set((() => { try { return JSON.parse(store.get('blue-trading.seen', '[]')); } catch { return []; } })()),
  warned: new Set(),
  tf: store.get('blue-trading.tf', '15m'),
  settings: J.loadSettings(),
  trades: J.loadTrades(),
  prices: {},
  tickets: new Map(),
  last: null,
  busy: false,
};

/* ---------- theme ---------- */
$('#theme-toggle').addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  store.set('blue-trading.theme', next);
});

/* ---------- composer ---------- */
function buildComposer() {
  const tf = $('#tf');
  tf.innerHTML = TIMEFRAMES.map(t => `<button type="button" data-tf="${t}" aria-pressed="${t === state.tf}">${t}</button>`).join('');
  tf.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (b) setTf(b.dataset.tf);
  });

  const suggestions = ['Give me a position', 'What’s gold doing on the 4h?', 'What news is coming?', 'Why this call?', 'What is an FVG?', 'Best time to trade gold?', 'Am I within my risk today?'];
  $('#suggest').innerHTML = suggestions.map(s => `<button type="button" class="chip">${s}</button>`).join('');
  $('#suggest').addEventListener('click', e => {
    const b = e.target.closest('.chip');
    if (b) handle(b.textContent);
  });

  $('#composer').addEventListener('submit', e => {
    e.preventDefault();
    const q = $('#q').value.trim();
    $('#q').value = '';
    handle(q || `Gold ${state.tf} position`);
  });
}

function setTf(tf) {
  state.tf = tf;
  store.set('blue-trading.tf', tf);
  $('#tf').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x.dataset.tf === tf));
}

/* ---------- conversation ---------- */
function say(html, who = 'bot') {
  const el = document.createElement('div');
  el.className = `msg ${who}`;
  el.innerHTML = html;
  $('#thread').append(el);
  el.scrollIntoView({ behavior: 'smooth', block: 'end' });
  return el;
}

function sayLines(m) {
  return say(`<div class="note"><h3>${esc(m.title)}</h3><ul>${m.lines.map(l => `<li data-tone="${l.tone}">${esc(l.text)}</li>`).join('')}</ul></div>`);
}

async function handle(text) {
  if (state.busy) return;
  say(esc(text), 'me');
  const q = parse(text);
  if (q.tf) setTf(q.tf);

  if (q.intent === 'help') { sayLines(HELP); return; }
  if (q.intent === 'topic') { sayLines(q.topic); return; }
  if (q.intent === 'unknown') { sayLines(UNKNOWN); return; }
  if (q.intent === 'price') { await priceReply(); return; }
  if (q.intent === 'why') { whyReply(); return; }
  if (q.intent === 'market') { await marketReply(state.tf); return; }
  if (q.intent === 'news') { sayLines(newsReply()); return; }
  if (q.intent === 'review') { sayLines(ask('review', ctx())); return; }
  if (q.intent === 'risk') { sayLines(ask('risk', ctx())); return; }
  if (q.intent === 'invalid') {
    const read = state.last && cached(state.last.symbol, state.last.tf);
    if (!read) { sayLines({ title: 'Ask for a position first', lines: [{ tone: 'info', text: 'Get a position on a market, then ask what invalidates it.' }] }); return; }
    sayLines(ask('invalid', { ...ctx(), analysis: read.analysis }));
    return;
  }
  if (!state.settings.configured) {
    state.pendingTf = state.tf;
    askBalance('Before I give you a trade, I need your account balance so I can tell you what each position risks.');
    return;
  }
  await position(state.tf);
}

async function priceReply() {
  const tk = await fetchTicker(GOLD);
  if (!tk) { sayLines({ title: 'Live price unavailable', lines: [{ tone: 'warn', text: 'I couldn’t reach the price feed from this network. Try again in a moment.' }] }); return; }
  sayLines({ title: `Gold is at ${fmt(tk.price)}`, lines: [
    { tone: tk.changePct >= 0 ? 'good' : 'bad', text: `${tk.changePct >= 0 ? 'Up' : 'Down'} ${pct(Math.abs(tk.changePct))} over the last 24 hours.` },
    { tone: 'info', text: 'This is the PAXG price, which tracks spot XAU/USD closely. Your broker may differ by a few dollars.' },
  ] });
}

function whyReply() {
  const t = state.lastTicket;
  if (!t) { sayLines({ title: 'No ticket yet', lines: [{ tone: 'info', text: 'Ask for a position first, then ask me why.' }] }); return; }
  const lines = [];
  lines.push({ tone: 'info', text: t.dir ? `I called ${t.dir > 0 ? 'long' : 'short'} on the ${t.tf} with a “${{ go: 'Take it', wait: 'Wait', skip: 'Skip' }[t.verdict]}” verdict.` : `I said stand aside on the ${t.tf}. ${t.note}` });
  for (const w of t.warnings) lines.push({ tone: w.tone, text: w.text });
  for (const c of t.checks) lines.push(c);
  for (const r of t.reasons) lines.push({ tone: r.dir > 0 ? 'good' : r.dir < 0 ? 'bad' : 'info', text: r.text });
  if (t.waitingFor) lines.push({ tone: 'warn', text: `Still waiting for ${t.waitingFor}.` });
  sayLines({ title: 'Why I made that call', lines });
}

async function marketReply(tf) {
  const wait = say(`<div class="thinking"><span></span><span></span><span></span> Reading gold on the ${tf}…</div>`);
  try {
    const read = await readMarket(tf);
    wait.remove();
    const m = ask('setup', { ...ctx(), analysis: read.analysis, symbol: 'Gold', tf });
    m.lines.push({ tone: 'info', text: 'Want levels? Ask “give me a position”.' });
    sayLines(m);
  } catch (err) {
    wait.remove();
    sayLines({ title: 'I couldn’t read the gold market', lines: [{ tone: 'bad', text: err.message }] });
  }
}

function askBalance(reason) {
  const open = [...document.querySelectorAll('form[data-setup]')].find(f => !f.dataset.saved);
  if (open) {
    sayLines({ title: 'Account balance needed', lines: [{ tone: 'warn', text: 'Fill in the account setup above first, then I’ll give you the position.' }] });
    open.querySelector('input').focus({ preventScroll: true });
    return;
  }
  const s = state.settings;
  say(`<form class="note setup" data-setup>
    <h3>Set up your account</h3>
    <p>${esc(reason)} It stays in this browser only.</p>
    <div class="setup-fields">
      <label>Account balance ($)<input name="balance" type="number" step="any" min="1" required inputmode="decimal" placeholder="e.g. 1000" value="${s.balance || ''}"></label>
      <label>Lot size per trade<input name="lots" type="number" step="0.01" min="0.01" required inputmode="decimal" value="${s.lots}"></label>
      <label>Max risk per trade (%)<input name="riskPct" type="number" step="0.1" min="0.1" required inputmode="decimal" value="${s.riskPct}"></label>
    </div>
    <button class="btn-primary" type="submit">Save and continue</button>
  </form>`);
}

$('#thread').addEventListener('submit', e => {
  const f = e.target.closest('form[data-setup]');
  if (!f) return;
  e.preventDefault();
  const v = name => parseFloat(f.elements[name].value);
  if (!(v('balance') > 0)) { toast('Enter your account balance'); return; }
  state.settings = { ...state.settings, balance: v('balance'), lots: v('lots') || 0.03, riskPct: v('riskPct') || 2, sizing: 'fixed', configured: true };
  J.saveSettings(state.settings);
  buildAccount();
  renderToday();
  f.dataset.saved = '1';
  f.querySelectorAll('input, button').forEach(el => { el.disabled = true; });
  f.querySelector('button').textContent = 'Saved';
  sayLines({ title: 'All set', lines: [
    { tone: 'good', text: `Balance ${money(state.settings.balance)}, ${state.settings.lots} lots per trade, max ${state.settings.riskPct}% risk per trade.` },
    { tone: 'info', text: `At ${state.settings.lots} lots, every $1 gold moves is ${money(state.settings.lots * 100)} on your account.` },
    { tone: 'info', text: 'Now press Get position, or ask me anything about gold.' },
  ] });
  if (state.pendingTf) { const tf = state.pendingTf; state.pendingTf = null; position(tf); }
});

async function position(tf) {
  const symbol = GOLD;
  state.busy = true;
  $('#ask-btn').disabled = true;
  setFeed('loading', `Reading ${symbol}`);
  const wait = say(`<div class="thinking"><span></span><span></span><span></span> Reading gold on the ${tf} and ${HTF_FOR[tf]} charts…</div>`);
  try {
    const read = await readMarket(tf);
    const t = ticket(read, state.settings, state.trades, state.calendar);
    const id = `t${Date.now()}`;
    state.tickets.set(id, t);
    state.last = { symbol, tf };
    state.lastTicket = t;
    wait.remove();
    say(renderTicket(t, id));
    setFeed(read.source === 'live' ? 'live' : 'demo', read.source === 'live' ? 'Live prices' : 'Demo prices');
    if (read.source === 'demo') {
      $('#gold-price').textContent = fmt(t.price);
      $('#gold-change').textContent = 'demo';
      $('#gold-change').className = 'num fine';
    }
  } catch (err) {
    wait.remove();
    sayLines({ title: 'I couldn’t read the gold market', lines: [{ tone: 'bad', text: err.message }, { tone: 'info', text: 'Try again in a moment.' }] });
    setFeed('error', 'Price feed error');
  } finally {
    state.busy = false;
    $('#ask-btn').disabled = false;
  }
}

const VERDICT = { go: 'Take it', wait: 'Wait', skip: 'Skip' };

function renderTicket(t, id) {
  const dirKey = t.dir > 0 ? 'up' : t.dir < 0 ? 'down' : 'flat';
  const r = t.record;
  const time = new Date(t.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const demo = t.source === 'demo' ? '<p class="demo">Live prices could not be reached from this network. These levels come from demo data, so don’t trade them.</p>' : '';
  const warn = t.warnings.length ? `<ul class="alerts">${t.warnings.map(w => `<li data-tone="${w.tone}">${esc(w.text)}</li>`).join('')}</ul>` : '';
  const why = list => list.map(x => `<li data-dir="${x.dir}">${esc(x.text)}</li>`).join('');
  const reasons = t.reasons.map(x => ({ dir: x.dir > 0 ? 'up' : x.dir < 0 ? 'down' : 'flat', text: x.text }));
  const recordHtml = r.n
    ? `<div class="rec">
        <span class="label">Same rules, last ${r.n} signal${r.n === 1 ? '' : 's'} on gold ${t.tf}</span>
        <div class="rec-stats">
          <span><b class="num">${pct(r.winRate)}</b> win rate</span>
          <span><b class="num ${r.avgR > 0 ? 'up' : 'down'}">${r.avgR > 0 ? '+' : ''}${r.avgR.toFixed(2)}R</b> avg</span>
          <span><b class="num ${r.totalR > 0 ? 'up' : 'down'}">${r.totalR > 0 ? '+' : ''}${r.totalR.toFixed(1)}R</b> total</span>
        </div>
        ${r.n < 20 ? '<p class="fine">Small sample. Treat it as a hint, not proof.</p>' : ''}
      </div>`
    : `<div class="rec"><span class="label">Track record</span><p class="fine">These rules produced no completed signals in the recent ${esc(t.tf)} history, so there is no record yet.</p></div>`;

  if (!t.dir) {
    return `<article class="ticket" data-dir="flat">
      <header class="t-head">
        <div class="t-id"><span class="t-sym">XAU/USD</span><span class="t-tf">${t.tf} · ${time}</span></div>
        <span class="verdict" data-v="skip">No trade</span>
      </header>
      <div class="t-side flat">Stand aside</div>
      ${warn}
      <p class="t-lead">Price <b class="num">${fmt(t.price)}</b>. ${esc(t.note)}</p>
      ${t.waitingFor ? `<p class="t-wait"><span class="label">Waiting for</span>${esc(t.waitingFor)}</p>` : ''}
      <ul class="why">${why(reasons)}</ul>
      ${demo}
      <footer class="t-actions"><button type="button" class="btn-quiet" data-act="refresh" data-id="${id}">Check again</button></footer>
    </article>`;
  }

  const levels = [
    ['Entry', t.entry, '', 'market'],
    ['Stop loss', t.stop, 'down', usd(t.stop - t.entry)],
    ['Take profit 1', t.tp1, 'up', `1R · ${usd(t.tp1 - t.entry)}`],
    ['Take profit 2', t.tp2, 'up', `${t.rr.toFixed(1)}R · ${usd(t.tp2 - t.entry)}`],
  ];
  const checks = t.checks.map(c => ({ dir: c.tone === 'good' ? 'up' : c.tone === 'bad' ? 'down' : 'warn', text: c.text }));
  return `<article class="ticket" data-dir="${dirKey}">
    <header class="t-head">
      <div class="t-id"><span class="t-sym">XAU/USD</span><span class="t-tf">${t.tf} · ${time}</span></div>
      <span class="verdict" data-v="${t.verdict}">${VERDICT[t.verdict]}</span>
    </header>
    <div class="t-side ${dirKey}">${t.dir > 0 ? 'Long' : 'Short'}</div>
    ${warn}
    <div class="levels">
      ${levels.map(([k, v, d, sub]) => `<div class="lv"><span class="label">${k}</span><b class="num ${d}">${fmt(v)}</b><span class="dist num">${sub}</span></div>`).join('')}
    </div>
    <div class="sizing">
      <div><span class="label">Size</span><b class="num">${lotFmt(t.lots)} lots</b><span class="fine num">${t.fixed ? 'your fixed size · ' : ''}${t.qty.toFixed(2)} oz · ${money(t.qty)} per $1 move</span></div>
      <div><span class="label">Risk if stopped</span><b class="num down">${money(-t.riskAmt)}</b><span class="fine">${t.riskPctOfBalance == null ? 'set your balance' : `${t.riskPctOfBalance.toFixed(1)}% of balance`}</span></div>
      <div><span class="label">Reward at TP 2</span><b class="num up">${money(t.rewardAmt)}</b><span class="fine">before fees</span></div>
    </div>
    ${t.waitingFor ? `<p class="t-wait"><span class="label">Before entering, wait for</span>${esc(t.waitingFor)}</p>` : ''}
    <details class="why-wrap">
      <summary>Why this position</summary>
      <ul class="why">${why(checks)}${why(reasons)}</ul>
      <p class="fine">Stop ${esc(t.stopReason)}. Take profit 2 is ${esc(t.targetReason)}. Close part of the position at take profit 1 and move the stop to entry.</p>
    </details>
    ${recordHtml}
    ${demo}
    <footer class="t-actions">
      <button type="button" class="btn-primary" data-act="take" data-id="${id}">I took it</button>
      <button type="button" class="btn-quiet" data-act="copy" data-id="${id}">Copy levels</button>
      <button type="button" class="btn-quiet" data-act="refresh" data-id="${id}">Refresh</button>
    </footer>
  </article>`;
}

$('#thread').addEventListener('click', async e => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const t = state.tickets.get(b.dataset.id);
  if (!t) return;
  if (b.dataset.act === 'refresh') { await position(t.tf); return; }
  if (b.dataset.act === 'copy') {
    const text = `XAU/USD ${t.dir > 0 ? 'BUY' : 'SELL'} (${t.tf})\nEntry ${fmt(t.entry)}\nSL ${fmt(t.stop)} (${usd(t.stop - t.entry)})\nTP1 ${fmt(t.tp1)} (${usd(t.tp1 - t.entry)})\nTP2 ${fmt(t.tp2)} (${usd(t.tp2 - t.entry)})\nSize ${lotFmt(t.lots)} lots / ${t.qty.toFixed(2)} oz (${money(t.riskAmt)} risk)`;
    try { await navigator.clipboard.writeText(text); toast('Levels copied'); } catch { toast('Copy is blocked in this browser'); }
    return;
  }
  if (b.dataset.act === 'take') {
    const trade = {
      id: crypto.randomUUID(), date: localNow(), openedAt: Date.now(), symbol: t.symbol,
      side: t.dir > 0 ? 'long' : 'short', setup: t.setup, tf: t.tf,
      entry: t.entry, stop: t.stop, tp1: t.tp1, target: t.tp2, exit: null,
      qty: +t.qty.toPrecision(6), fees: 0, notes: '', followedPlan: t.verdict === 'go',
      status: 'open', demo: t.source === 'demo',
    };
    state.trades.push(trade);
    J.saveTrades(state.trades);
    b.disabled = true; b.textContent = 'Tracking';
    renderRail();
    toast(t.verdict === 'go' ? 'Position tracked' : 'Tracked, and marked as taken before the rules said go');
    sync();
  }
});

/* ---------- positions ---------- */
function renderRail() {
  renderToday();
  const open = state.trades.filter(t => J.tradeResult(t).open).sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0));
  const closed = state.trades.filter(t => !J.tradeResult(t).open).sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 6);
  $('#positions').innerHTML = open.length || closed.length
    ? [...open.map(posRow), ...closed.map(posRow)].join('')
    : '<p class="empty">No positions yet. Ask for a position and press “I took it” to track it here.</p>';
  const s = J.stats(state.trades);
  $('#record').innerHTML = `
    <div><span class="label">Closed</span><b class="num">${s.closed}</b></div>
    <div><span class="label">Win rate</span><b class="num">${s.winRate == null ? '–' : pct(s.winRate)}</b></div>
    <div><span class="label">Net</span><b class="num ${s.net > 0 ? 'up' : s.net < 0 ? 'down' : ''}">${money(s.net)}</b></div>
    <div><span class="label">Avg R</span><b class="num ${s.avgR > 0 ? 'up' : s.avgR < 0 ? 'down' : ''}">${s.avgR == null ? '–' : `${s.avgR.toFixed(2)}R`}</b></div>`;
}

function posRow(t) {
  const r = J.tradeResult(t);
  const dir = t.side === 'short' ? -1 : 1;
  const now = state.prices[t.symbol];
  let pnl = r.pnl, rr = r.r;
  if (r.open && now) { pnl = (now - t.entry) * dir * t.qty; rr = ((now - t.entry) * dir) / Math.abs(t.entry - t.stop); }
  const status = r.open ? (t.demo ? 'Demo' : 'Open') : t.status === 'tp' ? 'Target hit' : t.status === 'sl' ? 'Stopped' : 'Closed';
  const showPnl = !r.open || now;
  return `<div class="pos" data-open="${r.open}">
    <div class="pos-top">
      <span class="pos-sym">${t.symbol === GOLD ? 'XAU/USD' : esc(t.symbol)}</span>
      <span class="pos-side ${dir > 0 ? 'up' : 'down'}">${dir > 0 ? 'Long' : 'Short'}</span>
      <span class="pos-status" data-s="${r.open ? 'open' : t.status || 'manual'}">${status}</span>
    </div>
    <div class="pos-mid num">
      <span>${fmt(t.entry)} → ${r.open ? (now ? fmt(now) : '…') : fmt(t.exit)}</span>
      <b class="${showPnl && pnl > 0 ? 'up' : showPnl && pnl < 0 ? 'down' : ''}">${showPnl ? `${money(pnl)}${rr == null ? '' : ` · ${rr > 0 ? '+' : ''}${rr.toFixed(2)}R`}` : '–'}</b>
    </div>
    <div class="pos-lv num">SL ${fmt(t.stop)} · TP ${fmt(t.target)}</div>
    <div class="pos-act">
      ${r.open ? `<input type="number" step="any" aria-label="Exit price for ${esc(t.symbol)}" placeholder="Exit price" value="${now ? +now.toPrecision(8) : ''}" data-exit="${t.id}">
      <button type="button" class="btn-quiet" data-close="${t.id}">Close</button>` : ''}
      <button type="button" class="link" data-remove="${t.id}">Remove</button>
    </div>
  </div>`;
}

$('#positions').addEventListener('click', e => {
  const close = e.target.closest('[data-close]');
  const remove = e.target.closest('[data-remove]');
  if (close) {
    const t = state.trades.find(x => x.id === close.dataset.close);
    const exit = parseFloat(document.querySelector(`[data-exit="${t.id}"]`).value);
    if (!(exit > 0)) { toast('Enter the price you closed at'); return; }
    Object.assign(t, { exit, status: 'manual' });
    J.saveTrades(state.trades);
    renderRail();
    toast(`Closed ${t.symbol} at ${fmt(exit)}`);
  } else if (remove) {
    if (!remove.dataset.armed) {
      remove.dataset.armed = '1'; remove.textContent = 'Confirm remove';
      setTimeout(() => { if (remove.isConnected) { delete remove.dataset.armed; remove.textContent = 'Remove'; } }, 3000);
      return;
    }
    state.trades = state.trades.filter(x => x.id !== remove.dataset.remove);
    J.saveTrades(state.trades);
    renderRail();
  }
});

// Checks open positions against live prices. A position closes at its stop or
// final target, whichever the 1-minute candles reached first (the stop if both).
let syncing = false;
async function sync() {
  if (syncing) return;
  const open = state.trades.filter(t => J.tradeResult(t).open && !t.demo && t.openedAt);
  if (!open.length) { $('#pos-sync').textContent = ''; return; }
  syncing = true;
  try {
    state.prices = { ...state.prices, ...await fetchPrices([...new Set(open.map(t => t.symbol))]) };
    let changed = false;
    for (const t of open) {
      const candles = await fetchMinuteCandlesSince(t.symbol, t.openedAt);
      if (!candles) continue;
      const dir = t.side === 'short' ? -1 : 1;
      for (const c of candles) {
        // Ignore any candle that started before the position was opened.
        if (c.time * 1000 < t.openedAt) continue;
        const hitStop = dir > 0 ? c.low <= t.stop : c.high >= t.stop;
        const hitTarget = dir > 0 ? c.high >= t.target : c.low <= t.target;
        if (hitStop || hitTarget) {
          t.exit = hitStop ? t.stop : t.target;
          t.status = hitStop ? 'sl' : 'tp';
          changed = true;
          notify(`${t.symbol} ${t.side} ${hitStop ? 'hit its stop' : 'hit its target'} at ${fmt(t.exit)}.`);
          break;
        }
      }
    }
    if (changed) J.saveTrades(state.trades);
    $('#pos-sync').textContent = Object.keys(state.prices).length
      ? `Live · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : 'Live prices unavailable';
    renderRail();
  } finally { syncing = false; }
}

/* ---------- news ---------- */
async function refreshCalendar() {
  state.calendar = await loadCalendar();
  $('#news-src').textContent = state.calendar.source === 'live' ? 'USD · high & medium impact' : 'Fixed-schedule events only';
  renderNews();
}

function renderNews() {
  if (!state.calendar) return;
  const now = Date.now();
  const list = upcoming(state.calendar, now).slice(0, 8);
  const fmtDay = ms => new Date(ms).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  $('#news').innerHTML = list.length ? list.map(e => {
    const mins = (e.time - now) / 60000;
    return `<li data-impact="${e.impact}">
      <span class="imp" aria-label="${e.impact} impact"></span>
      <div><b>${esc(e.title)}</b><span class="fine">${fmtDay(e.time)}${e.forecast ? ` · forecast ${esc(e.forecast)}` : ''}</span></div>
      <span class="num when">${mins <= 0 ? 'now' : `in ${fmtIn(mins)}`}</span>
    </li>`;
  }).join('') : '<li class="empty">No high-impact USD events on the calendar.</li>';
  if (state.calendar.source !== 'live') {
    $('#news').insertAdjacentHTML('beforeend', '<li class="fine">The live calendar could not be reached, so CPI, PCE and Fed speeches are missing. Check a full economic calendar before trading.</li>');
  }

  const nextHigh = list.find(e => e.impact === 'high' && e.time > now - 30 * 60000);
  const bar = $('#news-next');
  if (nextHigh) {
    const mins = (nextHigh.time - now) / 60000;
    bar.dataset.level = mins <= 60 ? 'bad' : mins <= 240 ? 'warn' : 'ok';
    $('#news-next-text').textContent = mins <= 0 ? `${nextHigh.title} just released` : `${nextHigh.title} in ${fmtIn(mins)}`;
    // One heads-up 30 minutes before each high-impact release.
    const key = `${nextHigh.title}@${nextHigh.time}`;
    if (mins > 0 && mins <= 30 && !state.warned.has(key)) {
      state.warned.add(key);
      notify(`Heads up: ${nextHigh.title} in ${Math.round(mins)} minutes. Gold can move fast. Tighten or close open positions.`);
    }
  } else {
    bar.dataset.level = 'none';
    $('#news-next-text').textContent = 'No high-impact news coming up';
  }

  const cond = conditions(state.calendar, null, now).filter(c => !/in \d+ min|in \d+h|released/.test(c.text));
  if (cond.length) $('#news-next-text').textContent += ` · ${cond[0].text.split('.')[0]}`;
}

function newsReply() {
  if (!state.calendar) return { title: 'Loading the calendar', lines: [{ tone: 'info', text: 'Give me a second and ask again.' }] };
  const now = Date.now();
  const list = upcoming(state.calendar, now).slice(0, 6);
  const lines = list.map(e => ({
    tone: e.impact === 'high' ? ((e.time - now) / 60000 <= 240 ? 'bad' : 'warn') : 'info',
    text: `${e.title}: ${new Date(e.time).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })} (${e.time > now ? `in ${fmtIn((e.time - now) / 60000)}` : 'just released'})${e.impact === 'high' ? ', high impact' : ''}.`,
  }));
  if (!lines.length) lines.push({ tone: 'good', text: 'No high-impact USD events coming up.' });
  for (const c of conditions(state.calendar, null, now)) if (!lines.some(l => l.text === c.text)) lines.push({ tone: c.tone, text: c.text });
  lines.push({ tone: 'info', text: 'Rule of thumb: no new gold entries 60 minutes before high-impact USD news, and wait for the first 15-minute candle after it.' });
  if (state.calendar.source !== 'live') lines.push({ tone: 'warn', text: 'The live calendar is unreachable, so CPI, PCE and Fed speeches are missing from this list.' });
  return { title: 'News that can move gold', lines };
}

async function refreshQuote() {
  const tk = await fetchTicker(GOLD);
  if (!tk) return;
  $('#gold-price').textContent = fmt(tk.price);
  const ch = $('#gold-change');
  ch.textContent = `${tk.changePct >= 0 ? '+' : ''}${pct(tk.changePct)} 24h`;
  ch.className = `num ${tk.changePct >= 0 ? 'up' : 'down'}`;
  setFeed('live', 'Live prices');
}

/* ---------- auto-scanner ---------- */
// Re-reads gold on several timeframes each minute. A setup is posted to the chat
// only when its ticket says "Take it" (all rules pass, no news block, risk within max),
// and only once per setup.
const SCAN_TFS = ['5m', '15m', '1h', '4h'];
const VERDICT_SHORT = { go: 'Take it', wait: 'Wait', skip: 'No trade' };
let scanning = false;
async function scan() {
  if (scanning || !$('#scan-on').checked) return;
  scanning = true;
  try {
    for (const tf of SCAN_TFS) {
      try {
        const read = await readMarket(tf);
        const t = ticket(read, state.settings, state.trades, state.calendar);
        state.scan[tf] = t;
        const key = `${tf}:${t.dir}:${t.workflow && t.workflow.zone ? t.workflow.zone.time : ''}:${Math.round(t.stop || 0)}`;
        if (t.verdict === 'go' && t.source === 'live' && state.settings.configured && !state.seen.has(key)) {
          state.seen.add(key);
          store.set('blue-trading.seen', JSON.stringify([...state.seen].slice(-50)));
          const id = `t${Date.now()}${tf}`;
          state.tickets.set(id, t);
          state.lastTicket = t;
          const el = say(renderTicket(t, id));
          el.insertAdjacentHTML('afterbegin', `<span class="auto-tag">Auto-scanner found a setup · ${tf}</span>`);
          notify(`Gold ${t.dir > 0 ? 'LONG' : 'SHORT'} setup on the ${tf}. Entry ${fmt(t.entry)}, SL ${fmt(t.stop)}, TP ${fmt(t.tp2)}.`, true);
        }
      } catch { /* skip this timeframe this round */ }
    }
    renderScan();
  } finally { scanning = false; }
}
function renderScan() {
  $('#scan').innerHTML = SCAN_TFS.map(tf => {
    const t = state.scan[tf];
    const v = t ? (t.source === 'demo' ? 'demo' : t.verdict) : 'idle';
    const label = !t ? '…' : t.source === 'demo' ? 'Demo' : t.dir && t.verdict !== 'skip' ? `${t.dir > 0 ? 'Long' : 'Short'} · ${VERDICT_SHORT[t.verdict]}` : 'No trade';
    return `<li data-v="${v}"><span class="num">${tf}</span><span>${label}</span></li>`;
  }).join('');
  $('#scan-time').textContent = $('#scan-on').checked ? `Checked ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Off';
}
$('#scan-on').checked = store.get('blue-trading.scan', '1') === '1';
$('#scan-on').addEventListener('change', async e => {
  store.set('blue-trading.scan', e.target.checked ? '1' : '0');
  renderScan();
  if (e.target.checked) {
    try { if (Notification.permission === 'default') await Notification.requestPermission(); } catch { /* unsupported */ }
    toast('Scanner on. Keep this tab open and I’ll post setups as they appear.');
    scan();
  }
});

/* ---------- account ---------- */
function buildAccount() {
  const s = state.settings;
  $('#s-balance').value = s.balance || ''; $('#s-riskpct').value = s.riskPct;
  $('#s-sizing').value = s.sizing; $('#s-lots').value = s.lots;
  $('#s-dailyloss').value = s.dailyLossPct; $('#s-maxtrades').value = s.maxTrades;
  syncSizingFields();
}
function syncSizingFields() {
  const fixed = $('#s-sizing').value === 'fixed';
  $('#s-lots-wrap').hidden = !fixed;
  $('#s-riskpct-label').textContent = fixed ? 'Max risk per trade (%)' : 'Risk per trade (%)';
}
$('#account').addEventListener('input', () => {
  const v = id => parseFloat($(id).value);
  const balance = v('#s-balance') || 0;
  state.settings = {
    balance, riskPct: v('#s-riskpct') || 0,
    sizing: $('#s-sizing').value, lots: Math.max(0.01, v('#s-lots') || 0.03),
    dailyLossPct: v('#s-dailyloss') || 0, maxTrades: Math.max(1, Math.round(v('#s-maxtrades') || 1)),
    configured: balance > 0,
  };
  syncSizingFields();
  J.saveSettings(state.settings);
  renderToday();
});

function renderToday() {
  const today = J.todayTrades(state.trades);
  const pnl = today.map(J.tradeResult).filter(r => !r.open).reduce((a, r) => a + r.pnl, 0);
  const limit = state.settings.balance * state.settings.dailyLossPct / 100;
  const used = limit ? Math.min(1, Math.max(0, -pnl / limit)) : 0;
  $('#today').innerHTML = `
    <div class="today-row"><span class="label">Today</span><b class="num ${pnl > 0 ? 'up' : pnl < 0 ? 'down' : ''}">${money(pnl)}</b><span class="num fine">${today.length} / ${state.settings.maxTrades} trades</span></div>
    <div class="bar" role="meter" aria-label="Daily loss limit used" aria-valuenow="${Math.round(used * 100)}" aria-valuemin="0" aria-valuemax="100"><span style="width:${used * 100}%" data-level="${used >= 1 ? 'bad' : used >= 0.6 ? 'warn' : 'ok'}"></span></div>
    <p class="fine">${used >= 1 ? 'Daily loss limit reached. Stop for today.' : `Loss limit ${money(-limit)} · ${Math.round(used * 100)}% used`}</p>`;
}

/* ---------- alerts & backup ---------- */
$('#alerts').checked = store.get('blue-trading.alerts', '0') === '1';
$('#alerts').addEventListener('change', async e => {
  store.set('blue-trading.alerts', e.target.checked ? '1' : '0');
  if (!e.target.checked) return;
  try { if (Notification.permission === 'default') await Notification.requestPermission(); } catch { /* unsupported */ }
  toast('Alerts on. Keep this tab open to receive them.');
});
function notify(text, force = false) {
  toast(text);
  if (!force && !$('#alerts').checked) return;
  try {
    const ctx = notify.ctx || (notify.ctx = new AudioContext());
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = 880; g.gain.setValueAtTime(0.15, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.4);
  } catch { /* audio blocked */ }
  try { if (Notification.permission === 'granted') new Notification('Blue Trading Desk', { body: text }); } catch { /* unsupported */ }
}

$('#export-csv').addEventListener('click', () => download('blue-trading-positions.csv', J.toCSV(state.trades), 'text/csv'));
$('#export-json').addEventListener('click', () => download('blue-trading-backup.json', JSON.stringify({ trades: state.trades, settings: state.settings }, null, 2), 'application/json'));
$('#import-json').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const trades = Array.isArray(data) ? data : data.trades;
    if (!Array.isArray(trades)) throw new Error('no positions found in that file');
    state.trades = trades;
    J.saveTrades(trades);
    if (data.settings) { state.settings = { ...J.DEFAULT_SETTINGS, ...data.settings }; J.saveSettings(state.settings); buildAccount(); }
    renderRail();
    toast(`Restored ${trades.length} positions`);
  } catch (err) { toast(`Could not restore: ${err.message}`); }
  e.target.value = '';
});

/* ---------- utils ---------- */
function ctx() { return { analysis: null, symbol: state.symbol, tf: state.tf, trades: state.trades, settings: state.settings, risk: null }; }
function setFeed(kind, text) { const f = $('#feed'); f.dataset.state = kind; f.querySelector('span').textContent = text; }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function localNow() { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); }
function lotFmt(l) { return l >= 0.01 ? (Math.floor(l * 100) / 100).toFixed(2) : l.toFixed(3); }
function usd(d) { return `${d >= 0 ? '+' : '−'}$${Math.abs(d).toFixed(2)}`; }
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3000);
}

/* ---------- boot ---------- */
buildComposer();
buildAccount();
renderRail();
say(`<div class="note intro"><h3>Your gold trading assistant.</h3><p>Press <b>Get position</b> or say <b>give me a position</b> for a trade ticket with entry, stop and take profits. Or just ask: <b>what’s gold doing on the 4h?</b>, <b>what news is coming?</b>, <b>what is a CHoCH?</b>, <b>why short?</b></p></div>`);
if (!state.settings.configured) askBalance('First, tell me your account balance and the lot size you trade, so every ticket shows what it risks.');
refreshCalendar();
refreshQuote();
sync();
setInterval(sync, 30000);
setInterval(refreshQuote, 15000);
setInterval(renderNews, 60000);
setInterval(refreshCalendar, 30 * 60000);
renderScan();
setTimeout(scan, 4000);
setInterval(scan, 60000);
