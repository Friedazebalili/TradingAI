import { fmt } from './analysis.js';
import { fetchMinuteCandlesSince, fetchTicker } from './data.js';
import * as J from './journal.js';
import { loadCalendar, upcoming, conditions, fmtIn } from './news.js';
import { scanGold, trailLevel, GOLD, SCAN_TFS } from './signals.js';

const $ = sel => document.querySelector(sel);
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
};
const HISTORY_KEY = 'blue-trading.signals.v1';

const state = {
  settings: J.loadSettings(),
  history: (() => { try { return JSON.parse(store.get(HISTORY_KEY, '[]')); } catch { return []; } })(),
  calendar: null,
  scan: null,
  price: null,
  lastScan: null,
  scanning: false,
};
const saveHistory = () => store.set(HISTORY_KEY, JSON.stringify(state.history.slice(0, 40)));

/* ---------- theme ---------- */
$('#theme-toggle').addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  store.set('blue-trading.theme', next);
});

/* ---------- account setup (always first) ---------- */
function showSetup(editing = false) {
  const s = state.settings;
  $('#f-balance').value = s.configured ? s.balance : '';
  $('#f-lots').value = s.lots;
  $('#f-risk').value = s.riskPct;
  $('#setup-save').textContent = editing ? 'Save' : 'Show me signals';
  $('#setup').hidden = false;
  $('#board').hidden = true;
  $('#settings-btn').hidden = true;
  setupHint();
  $('#f-balance').focus();
}
function showBoard() {
  $('#setup').hidden = true;
  $('#board').hidden = false;
  $('#settings-btn').hidden = false;
  render();
}
function setupHint() {
  const bal = parseFloat($('#f-balance').value), lots = parseFloat($('#f-lots').value), risk = parseFloat($('#f-risk').value);
  if (!(lots > 0)) { $('#setup-hint').textContent = ''; return; }
  const perDollar = lots * 100;
  let text = `At ${lots} lots, every $1 gold moves is $${perDollar.toFixed(2)} on your account.`;
  if (bal > 0 && risk > 0) {
    const maxStop = (bal * risk / 100) / perDollar;
    text += ` With ${risk}% max risk, I only show signals whose stop is within $${maxStop.toFixed(2)} of entry.`;
  }
  $('#setup-hint').textContent = text;
}
$('#setup-form').addEventListener('input', setupHint);
$('#setup-form').addEventListener('submit', e => {
  e.preventDefault();
  const balance = parseFloat($('#f-balance').value);
  if (!(balance > 0)) { toast('Enter your account balance'); return; }
  state.settings = { ...state.settings, balance, lots: Math.max(0.01, parseFloat($('#f-lots').value) || 0.03), riskPct: parseFloat($('#f-risk').value) || 2, sizing: 'fixed', configured: true };
  J.saveSettings(state.settings);
  try { if (Notification.permission === 'default') Notification.requestPermission(); } catch { /* unsupported */ }
  showBoard();
  scan();
});
$('#settings-btn').addEventListener('click', () => showSetup(true));

/* ---------- scanning ---------- */
function dailyLimits() {
  const today = new Date().toDateString();
  const mine = state.history.filter(h => h.taken && new Date(h.takenAt || h.at).toDateString() === today);
  const lost = mine.filter(h => h.status !== 'open').reduce((a, h) => a + (h.r || 0) * h.risk, 0);
  return {
    lossHit: lost <= -(state.settings.balance * state.settings.dailyLossPct / 100),
    tradesHit: mine.length >= state.settings.maxTrades,
  };
}

async function scan() {
  if (state.scanning || !state.settings.configured) return;
  state.scanning = true;
  setFeed('loading');
  try {
    const res = await scanGold(state.settings, state.calendar, dailyLimits());
    state.scan = res;
    state.lastScan = Date.now();
    setFeed(res.source === 'live' ? 'live' : res.source === 'demo' ? 'demo' : 'error');
    const s = res.signal;
    // Live signals go into the history once, so the record is real.
    if (s && s.source === 'live' && !state.history.some(h => h.id === s.id)) {
      state.history.unshift({ ...s, status: 'open', taken: false, tp1Hit: false, stopNow: s.stop, r: null });
      saveHistory();
      alertUser(`${s.dir > 0 ? 'BUY' : 'SELL'} gold · ${s.label} · ${s.tf}. Entry ${fmt(s.entry)}, SL ${fmt(s.stop)}, TP ${fmt(s.tp2)}.`);
    }
  } finally {
    state.scanning = false;
    render();
  }
}

/* ---------- follow-up on every live signal ---------- */
// Walks 1-minute candles since the signal. TP1 moves the stop to entry; for trades
// you took, the stop then trails behind new swings. Stop is checked first in a candle.
let monitoring = false;
async function monitor() {
  if (monitoring) return;
  const open = state.history.filter(h => h.status === 'open' && h.source === 'live');
  if (!open.length) return;
  monitoring = true;
  try {
    for (const h of open) {
      if (!h.taken && Date.now() - h.at > 24 * 3600000) { h.status = 'expired'; continue; }
      const candles = await fetchMinuteCandlesSince(GOLD, h.at);
      if (!candles) continue;
      let stop = h.stop, tp1Hit = false;
      for (const c of candles) {
        if (c.time * 1000 < h.at - 60000) continue;
        const hitStop = h.dir > 0 ? c.low <= stop : c.high >= stop;
        if (hitStop) { close(h, tp1Hit ? (stop === h.entry ? 'be' : 'trail') : 'sl', stop); break; }
        if (!tp1Hit && (h.dir > 0 ? c.high >= h.tp1 : c.low <= h.tp1)) { tp1Hit = true; stop = h.entry; }
        if (h.dir > 0 ? c.high >= h.tp2 : c.low <= h.tp2) { close(h, 'tp2', h.tp2); break; }
        if (h.taken && tp1Hit && h.stopNow && (h.dir > 0 ? h.stopNow > stop : h.stopNow < stop)) stop = h.stopNow;
      }
      if (h.status !== 'open') continue;
      if (tp1Hit && !h.tp1Hit) {
        h.tp1Hit = true;
        h.stopNow = h.entry;
        if (h.taken) instruct(h, `TP1 hit. Close ${closeLots(h.lots)} lots now and move your stop to entry (${fmt(h.entry)}). The rest of the trade can't lose now.`);
      }
      if (h.taken && h.tp1Hit) {
        const trail = await trailLevel(h).catch(() => null);
        if (trail && (h.dir > 0 ? trail > h.stopNow : trail < h.stopNow) && (h.dir > 0 ? trail < state.price : trail > state.price)) {
          h.stopNow = trail;
          instruct(h, `Move your stop to ${fmt(trail)}. It now sits behind the latest ${h.tf} swing and locks in $${(Math.abs(trail - h.entry) * h.lots * 100 / 2).toFixed(2)}.`);
        }
      }
    }
    saveHistory();
    render();
  } finally { monitoring = false; }
}

function close(h, how, price) {
  h.status = how;
  h.exit = price;
  h.closedAt = Date.now();
  // Result in R, counting half the position closed at TP1 when it was reached.
  const full = ((price - h.entry) * h.dir) / Math.abs(h.entry - h.stop);
  // TP2 always lies beyond TP1, so any win banked half the position at 1R first.
  h.r = how === 'sl' ? -1 : 0.5 + 0.5 * Math.max(0, full);
  if (h.taken) {
    const msg = { sl: `Stopped out at ${fmt(price)}. That's a planned loss of about $${h.risk.toFixed(2)}. Wait for the next signal; no revenge trades.`,
      tp2: `Take profit 2 hit at ${fmt(price)}. Trade complete.`,
      be: `Stopped at entry after TP1. You kept the TP1 profit.`,
      trail: `Trailing stop hit at ${fmt(price)}. Profit locked in.` }[how];
    instruct(h, msg);
  }
}
const closeLots = lots => (Math.ceil((lots / 2) * 100) / 100).toFixed(2);

function instruct(h, text) {
  h.instruction = text;
  h.instructionAt = Date.now();
  alertUser(text);
}

/* ---------- rendering ---------- */
function render() {
  renderAlertBar();
  renderActive();
  renderSignal();
  renderHistory();
}

function renderAlertBar() {
  const bar = $('#alert-bar');
  const now = Date.now();
  const c = state.calendar ? conditions(state.calendar, null, now) : [];
  const top = c.find(x => x.block) || c[0];
  const next = state.calendar ? upcoming(state.calendar, now).find(e => e.impact === 'high' && e.time > now) : null;
  if (top) { bar.textContent = top.text; bar.dataset.level = top.block ? 'bad' : 'warn'; bar.hidden = false; }
  else if (next && next.time - now < 24 * 3600000) { bar.textContent = `${next.title} in ${fmtIn((next.time - now) / 60000)}. No new trades in the hour before it.`; bar.dataset.level = 'info'; bar.hidden = false; }
  else bar.hidden = true;
}

function currentSignal() {
  if (state.scan && state.scan.signal) {
    const s = state.scan.signal;
    const h = state.history.find(x => x.id === s.id);
    if (h && (h.taken || h.skipped || h.status !== 'open')) return null;
    return s;
  }
  // Keep a recent live signal on screen until it plays out or 20 minutes pass.
  return state.history.find(h => h.status === 'open' && !h.taken && !h.skipped && Date.now() - h.at < 20 * 60000) || null;
}

function renderSignal() {
  const el = $('#signal');
  const s = currentSignal();
  if (!s) {
    const res = state.scan ? state.scan.results : [];
    const main = res.find(r => r.tf === '15m') || res[0];
    el.dataset.dir = 'none';
    el.innerHTML = `
      <p class="sig-kicker">Watching ${SCAN_TFS.join(' · ')}</p>
      <h1 class="sig-title">No signal right now</h1>
      <p class="sig-reason">${esc(main && main.why ? main.why : 'Checking the gold chart…')}</p>
      <p class="sig-meta">I only show trades that pass every check. Leave this page open and I’ll sound an alert when one appears.${state.lastScan ? ` Last check ${clock(state.lastScan)}.` : ''}</p>
      ${state.scan && state.scan.source === 'demo' ? '<p class="demo">Live prices are unreachable on this network, so nothing here is real.</p>' : ''}`;
    return;
  }
  const d = s.dir;
  const dist = v => `${v - s.entry >= 0 ? '+' : '−'}$${Math.abs(v - s.entry).toFixed(2)}`;
  el.dataset.dir = d > 0 ? 'up' : 'down';
  el.innerHTML = `
    <p class="sig-kicker"><span class="tag">${esc(s.label)}</span> ${s.tf} chart · ${ago(s.at)}</p>
    <h1 class="sig-title ${d > 0 ? 'up' : 'down'}">${d > 0 ? 'BUY' : 'SELL'} GOLD</h1>
    <p class="sig-reason">${esc(s.reason)}</p>
    <dl class="levels">
      <div><dt>Entry</dt><dd class="num">${fmt(s.entry)}</dd><span class="num">now</span></div>
      <div><dt>Stop loss</dt><dd class="num down">${fmt(s.stop)}</dd><span class="num">${dist(s.stop)}</span></div>
      <div><dt>Take profit 1</dt><dd class="num up">${fmt(s.tp1)}</dd><span class="num">${dist(s.tp1)}</span></div>
      <div><dt>Take profit 2</dt><dd class="num up">${fmt(s.tp2)}</dd><span class="num">${dist(s.tp2)}</span></div>
    </dl>
    <p class="money"><b>${s.lots} lots</b> · risk <b class="down">$${s.risk.toFixed(2)}</b>${s.riskPct != null ? ` (${s.riskPct.toFixed(1)}%)` : ''} · reward up to <b class="up">$${s.reward.toFixed(2)}</b></p>
    <ol class="plan">
      <li>Enter now. Set stop loss <b class="num">${fmt(s.stop)}</b> and take profit <b class="num">${fmt(s.tp2)}</b>.</li>
      <li>At TP1 <b class="num">${fmt(s.tp1)}</b>: close ${closeLots(s.lots)} lots and move your stop to entry.</li>
      <li>Then I’ll tell you where to trail your stop as gold makes new ${s.tf} swings.</li>
      <li>The rest closes at TP2, or at your trailed stop.</li>
    </ol>
    ${s.warnings.length ? `<p class="sig-warn">${esc(s.warnings[0])}</p>` : ''}
    ${s.record && s.record.n ? `<p class="sig-meta">This setup on the ${s.tf}, recent history: ${s.record.trades.filter(t => t.r > 0).length} of ${s.record.n} reached a target.</p>` : ''}
    ${s.source === 'demo' ? '<p class="demo">Demo prices. Don’t trade this.</p>' : ''}
    <div class="actions">
      <button class="btn-primary" type="button" data-act="take" ${s.source === 'demo' ? 'disabled' : ''}>I’m in</button>
      <button class="btn-quiet" type="button" data-act="skip">Skip</button>
    </div>`;
  el.dataset.id = s.id;
}

$('#signal').addEventListener('click', e => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const h = state.history.find(x => x.id === $('#signal').dataset.id);
  if (!h) return;
  if (b.dataset.act === 'take') {
    h.taken = true; h.takenAt = Date.now();
    h.instruction = `You're in. Stop loss ${fmt(h.stop)}, take profit ${fmt(h.tp2)}. I'll tell you when to move the stop.`;
    h.instructionAt = Date.now();
    try { if (Notification.permission === 'default') Notification.requestPermission(); } catch { /* unsupported */ }
  } else {
    h.skipped = true;
  }
  saveHistory();
  render();
});

function renderActive() {
  const active = state.history.filter(h => h.taken && (h.status === 'open' || (h.closedAt && Date.now() - h.closedAt < 30 * 60000)));
  $('#active').innerHTML = active.map(h => {
    const live = h.status === 'open' && state.price ? (state.price - h.entry) * h.dir * h.lots * 100 : null;
    return `<article class="trade" data-state="${h.status}">
      <div class="trade-top">
        <span class="trade-side ${h.dir > 0 ? 'up' : 'down'}">${h.dir > 0 ? 'BUY' : 'SELL'}</span>
        <span>Gold · ${h.tf} · ${h.status === 'open' ? 'in trade' : 'closed'}</span>
        ${live != null ? `<b class="num ${live >= 0 ? 'up' : 'down'}">${live >= 0 ? '+' : '−'}$${Math.abs(live).toFixed(2)}</b>` : h.r != null ? `<b class="num ${h.r >= 0 ? 'up' : 'down'}">${h.r >= 0 ? '+' : ''}${h.r.toFixed(2)}R</b>` : ''}
      </div>
      <p class="trade-do">${esc(h.instruction || '')}</p>
      ${h.status === 'open' ? `<div class="trade-stops num"><span>Stop now <b>${fmt(h.stopNow)}</b></span><span>TP1 <b>${fmt(h.tp1)}</b>${h.tp1Hit ? ' ✓' : ''}</span><span>TP2 <b>${fmt(h.tp2)}</b></span></div>
      <button class="link" type="button" data-closed="${h.id}">I closed this trade</button>` : ''}
    </article>`;
  }).join('');
}
$('#active').addEventListener('click', e => {
  const b = e.target.closest('[data-closed]');
  if (!b) return;
  const h = state.history.find(x => x.id === b.dataset.closed);
  if (!h) return;
  const exit = state.price || h.entry;
  h.status = 'manual'; h.exit = exit; h.closedAt = Date.now();
  h.r = ((exit - h.entry) * h.dir) / Math.abs(h.entry - h.stop);
  saveHistory();
  render();
});

const RESULT = { open: ['Running', ''], tp2: ['TP2 hit', 'up'], be: ['TP1, then break-even', 'up'], trail: ['TP1, then trailed', 'up'], sl: ['Stopped', 'down'], manual: ['Closed', ''], expired: ['Expired', ''] };
function renderHistory() {
  const list = state.history.slice(0, 12);
  $('#history').innerHTML = list.length ? list.map(h => {
    const [label, tone] = RESULT[h.status] || ['', ''];
    return `<li>
      <span class="h-side ${h.dir > 0 ? 'up' : 'down'}">${h.dir > 0 ? 'BUY' : 'SELL'}</span>
      <span class="h-what">${esc(h.label)} · ${h.tf}<small>${new Date(h.at).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}${h.taken ? ' · you took it' : ''}</small></span>
      <span class="h-res ${tone}">${label}${h.r != null ? ` <b class="num">${h.r >= 0 ? '+' : ''}${h.r.toFixed(1)}R</b>` : ''}</span>
    </li>`;
  }).join('') : '<li class="empty">No signals yet. Live signals and how they ended will be listed here, so you can see the real hit rate.</li>';
  const closed = state.history.filter(h => h.r != null);
  const wins = closed.filter(h => h.r > 0).length;
  const net = closed.reduce((a, h) => a + h.r, 0);
  $('#score').innerHTML = closed.length ? `${wins} of ${closed.length} won · <b class="num ${net >= 0 ? 'up' : 'down'}">${net >= 0 ? '+' : ''}${net.toFixed(1)}R</b>` : '';
}

/* ---------- price, news, alerts ---------- */
async function refreshPrice() {
  const tk = await fetchTicker(GOLD);
  if (!tk) return;
  state.price = tk.price;
  $('#price').textContent = fmt(tk.price);
  if (state.history.some(h => h.taken && h.status === 'open')) renderActive();
}
async function refreshCalendar() {
  state.calendar = await loadCalendar();
  renderAlertBar();
}
const warned = new Set();
function newsHeadsUp() {
  if (!state.calendar) return;
  const now = Date.now();
  for (const e of upcoming(state.calendar, now)) {
    const mins = (e.time - now) / 60000;
    const key = `${e.title}@${e.time}`;
    if (e.impact === 'high' && mins > 0 && mins <= 30 && !warned.has(key)) {
      warned.add(key);
      const inTrade = state.history.some(h => h.taken && h.status === 'open');
      alertUser(`${e.title} in ${Math.round(mins)} minutes.${inTrade ? ' You have an open trade: move your stop to entry or close it.' : ' No new trades until it’s out.'}`);
    }
  }
  renderAlertBar();
}

function alertUser(text) {
  toast(text);
  try {
    const ctx = alertUser.ctx || (alertUser.ctx = new AudioContext());
    for (const [f, t] of [[880, 0], [1175, 0.18]]) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.14, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.3);
      o.connect(g).connect(ctx.destination); o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.3);
    }
  } catch { /* audio blocked */ }
  try { if (Notification.permission === 'granted') new Notification('Blue Trading Gold', { body: text }); } catch { /* unsupported */ }
}

/* ---------- utils ---------- */
function setFeed(kind) { $('#feed').dataset.state = kind; $('#feed').title = { live: 'Live prices', demo: 'Demo prices', loading: 'Checking…', error: 'Price feed error' }[kind] || ''; }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function clock(ms) { return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
function ago(ms) { const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? 'just now' : `${m} min ago`; }
let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 5000);
}

/* ---------- boot ---------- */
if (state.settings.configured) showBoard(); else showSetup();
refreshCalendar().then(() => { if (state.settings.configured) scan(); });
refreshPrice();
setInterval(scan, 60000);
setInterval(monitor, 30000);
setInterval(refreshPrice, 10000);
setInterval(newsHeadsUp, 60000);
setInterval(refreshCalendar, 30 * 60000);
setInterval(() => { if (!$('#board').hidden) renderSignal(); }, 30000);
