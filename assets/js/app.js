import { fmt } from './analysis.js';
import { fetchCandles, fetchHistory, fetchTicker, demoCandles } from './data.js';
import * as J from './journal.js';
import { loadCalendar, upcoming, conditions } from './news.js';
import { RULES, playDays, summarize, server, serverHourToMs } from './london.js';

const GOLD = 'PAXGUSDT';
const HISTORY_DAYS = 180;
const STUDY_URL = 'https://www.mql5.com/en/blogs/post/777540';
const $ = sel => document.querySelector(sel);
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
};

const state = {
  settings: J.loadSettings(),
  candles: null,
  source: null,
  days: [],
  price: null,
  calendar: null,
  loading: 0,
};

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
  $('#setup-save').textContent = editing ? 'Save' : 'Show today’s plan';
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
  let text = `At ${lots} lots, every $1 gold moves is $${(lots * 100).toFixed(2)} on your account.`;
  if (bal > 0 && risk > 0) text += ` A ${risk}% max risk is $${(bal * risk / 100).toFixed(2)} per trade.`;
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
});
$('#settings-btn').addEventListener('click', () => showSetup(true));

/* ---------- data ---------- */
async function loadHistory() {
  state.loading = 0.01;
  render();
  const hist = await fetchHistory(GOLD, '15m', HISTORY_DAYS, p => { state.loading = p; renderRecord(); });
  if (hist && hist.length) { state.candles = hist; state.source = 'live'; }
  else { state.candles = demoCandles(GOLD, '15m', 96 * HISTORY_DAYS); state.source = 'demo'; }
  state.loading = 0;
  recompute();
}

async function refreshRecent() {
  if (state.source !== 'live') return;
  const res = await fetchCandles(GOLD, '15m', 200);
  if (res.source !== 'live') return;
  const byTime = new Map(state.candles.slice(-400).map(c => [c.time, c]));
  for (const c of res.candles) byTime.set(c.time, c);
  state.candles = [...state.candles.slice(0, -400), ...[...byTime.values()].sort((a, b) => a.time - b.time)];
  recompute();
}

function recompute() {
  state.days = playDays(state.candles);
  setFeed(state.source === 'live' ? 'live' : 'demo');
  alerts();
  render();
}

async function refreshPrice() {
  const tk = await fetchTicker(GOLD);
  if (!tk) return;
  state.price = tk.price;
  $('#price').textContent = fmt(tk.price);
  const t = today();
  if (t && t.phase === 'open') renderToday();
}

/* ---------- money ---------- */
const s$ = v => `${v < 0 ? '−' : ''}$${Math.abs(v).toFixed(2)}`;
function sizing(risk) {
  const { lots, balance, riskPct } = state.settings;
  const riskUsd = risk * 100 * lots;
  const pctOf = balance > 0 ? (riskUsd / balance) * 100 : null;
  const fit = balance > 0 ? Math.floor((balance * riskPct / 100) / (risk * 100) * 100) / 100 : null;
  return { lots, riskUsd, pctOf, fit, tooBig: pctOf != null && pctOf > riskPct };
}

/* ---------- today ---------- */
function today() {
  const key = server(Date.now()).day;
  return state.days.find(d => d.day === key) || null;
}
const local = hour => new Date(serverHourToMs(Date.now(), hour)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function render() {
  if ($('#board').hidden) return;
  renderAlertBar();
  renderToday();
  renderRecord();
  renderHistory();
}

function renderToday() {
  const el = $('#today');
  const now = server(Date.now());
  const d = today();
  const times = `Range ${local(RULES.rangeStart)}–${local(RULES.rangeEnd)} · orders until ${local(RULES.closeHour)} (your time)`;

  if (!state.candles) { el.dataset.state = 'idle'; el.innerHTML = `<p class="kicker">Today</p><h1 class="title">Loading gold prices…</h1>`; return; }
  if (now.weekday === 'Sat' || now.weekday === 'Sun') {
    el.dataset.state = 'idle';
    el.innerHTML = `<p class="kicker">Today</p><h1 class="title">Market closed</h1><p class="lead">Gold is closed for the weekend. Monday’s range starts at ${local(RULES.rangeStart)} your time.</p>`;
    return;
  }
  if (!d || d.phase === 'range') {
    const r = d && d.range;
    const mins = Math.max(0, Math.round((serverHourToMs(Date.now(), RULES.rangeEnd) - Date.now()) / 60000));
    el.dataset.state = 'idle';
    el.innerHTML = `
      <p class="kicker">Today · ${times}</p>
      <h1 class="title">${now.hour < RULES.rangeStart ? 'Waiting for the range' : 'Building today’s range'}</h1>
      <p class="lead">${now.hour < RULES.rangeStart ? `The range starts at ${local(RULES.rangeStart)}.` : `Orders are ready in ${mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins} min`}, at ${local(RULES.rangeEnd)}. Nothing to do until then.`}</p>
      ${r ? `<div class="range num"><span>High so far <b>${fmt(r.high)}</b></span><span>Low so far <b>${fmt(r.low)}</b></span></div>` : ''}
      <p class="meta">Keep this page open. It sounds an alert when your orders are ready.</p>`;
    return;
  }
  if (d.phase === 'skip') {
    el.dataset.state = 'skip';
    el.innerHTML = `<p class="kicker">Today · ${times}</p><h1 class="title">No trade today</h1><p class="lead">${esc(d.skip)}</p><p class="meta">Skipping days like this is part of the rule. Next range starts tomorrow at ${local(RULES.rangeStart)}.</p>`;
    return;
  }
  if (d.phase === 'pending') {
    const L = d.long, S = d.short;
    el.dataset.state = 'pending';
    el.innerHTML = `
      <p class="kicker">Today · ${times}</p>
      <h1 class="title">Place these 2 orders now</h1>
      <p class="lead">Gold is about to break out of today’s range (${d.range.pct.toFixed(2)}% of price). One order will fill. <b>When it does, cancel the other.</b></p>
      <div class="orders">${orderCard(L)}${orderCard(S)}</div>
      <ol class="steps">
        <li>Price reaches ${fmt(L.be)} (buy) or ${fmt(S.be)} (sell): move your stop to your entry price.</li>
        <li>Not filled by ${local(RULES.closeHour)}: cancel both orders.</li>
        <li>Still in the trade at ${local(RULES.closeHour)}: close it.</li>
      </ol>`;
    return;
  }
  const t = d.trade;
  if (d.phase === 'open') {
    const pnl = state.price ? (state.price - t.entry) * t.dir * 100 * state.settings.lots : null;
    el.dataset.state = t.dir > 0 ? 'up' : 'down';
    el.innerHTML = `
      <p class="kicker">Today · in a trade · close by ${local(RULES.closeHour)}</p>
      <h1 class="title ${t.dir > 0 ? 'up' : 'down'}">${t.dir > 0 ? 'BUY' : 'SELL'} is live</h1>
      <p class="lead">${t.dir > 0 ? 'Cancel your sell stop order if you haven’t.' : 'Cancel your buy stop order if you haven’t.'}</p>
      <p class="do">${t.beDone ? `Your stop should now be at entry, ${fmt(t.entry)}. You can’t lose on this trade any more. Target ${fmt(t.tp)}.` : `When price reaches ${fmt(t.be)}, move your stop to ${fmt(t.entry)}. Until then, the stop stays at ${fmt(t.stop)}.`}</p>
      <dl class="levels">
        <div><dt>Entry</dt><dd class="num">${fmt(t.entry)}</dd></div>
        <div><dt>Stop now</dt><dd class="num down">${fmt(t.stopNow)}</dd></div>
        <div><dt>Take profit</dt><dd class="num up">${fmt(t.tp)}</dd></div>
        <div><dt>Open P&amp;L</dt><dd class="num ${pnl == null ? '' : pnl >= 0 ? 'up' : 'down'}">${pnl == null ? '–' : s$(pnl)}</dd></div>
      </dl>`;
    return;
  }
  if (d.phase === 'notrigger') {
    el.dataset.state = 'skip';
    el.innerHTML = `<p class="kicker">Today</p><h1 class="title">No breakout today</h1><p class="lead">Neither order filled before ${local(RULES.closeHour)}. Cancel both if they are still open. Next range starts tomorrow at ${local(RULES.rangeStart)}.</p>`;
    return;
  }
  const usd = t.r * t.risk * 100 * state.settings.lots;
  const how = { tp: 'Take profit hit', sl: 'Stopped out', be: 'Stopped at entry', time: `Closed at ${local(RULES.closeHour)}` }[t.how];
  el.dataset.state = t.r > 0 ? 'up' : t.r < 0 ? 'down' : 'skip';
  el.innerHTML = `<p class="kicker">Today · done</p><h1 class="title ${t.r > 0 ? 'up' : t.r < 0 ? 'down' : ''}">${how}</h1>
    <p class="lead">${t.dir > 0 ? 'Buy' : 'Sell'} from ${fmt(t.entry)} closed at ${fmt(t.exit)}: <b class="num ${t.r >= 0 ? 'up' : 'down'}">${t.r >= 0 ? '+' : ''}${t.r.toFixed(2)}R (${s$(usd)} at ${state.settings.lots} lots)</b>.</p>
    <p class="meta">${t.r < 0 ? 'That’s a normal, planned loss. The rule wins on about half its trades and makes it back on the bigger winners. No revenge trades. ' : ''}Next range starts tomorrow at ${local(RULES.rangeStart)}.</p>`;
}

function orderCard(o) {
  const z = sizing(o.risk);
  const buy = o.dir > 0;
  return `<div class="order ${buy ? 'up' : 'down'}">
    <h3>${buy ? 'BUY STOP' : 'SELL STOP'}</h3>
    <dl>
      <div><dt>Entry</dt><dd class="num">${fmt(o.entry)}</dd></div>
      <div><dt>Stop loss</dt><dd class="num down">${fmt(o.stop)}</dd></div>
      <div><dt>Take profit</dt><dd class="num up">${fmt(o.tp)}</dd></div>
    </dl>
    <p class="size">${z.lots} lots · risk <b class="down">${s$(z.riskUsd)}</b>${z.pctOf != null ? ` (${z.pctOf.toFixed(1)}%)` : ''} · win <b class="up">${s$(z.riskUsd * RULES.tpR)}</b></p>
    ${z.tooBig ? `<p class="toobig">${z.fit >= 0.01 ? `Too big for your ${state.settings.riskPct}% max. Use <b>${z.fit.toFixed(2)} lots</b>.` : `Even 0.01 lots risks ${s$(o.risk)} here, more than your ${state.settings.riskPct}% max. Skip it, or accept the bigger risk knowingly.`}</p>` : ''}
  </div>`;
}

/* ---------- track record ---------- */
function renderRecord() {
  const el = $('#record');
  if (state.loading) {
    el.innerHTML = `<h2>Testing the rule on real gold prices…</h2><div class="bar"><span style="width:${Math.round(state.loading * 100)}%"></span></div>`;
    return;
  }
  if (!state.days.length) { el.innerHTML = ''; return; }
  const past = state.days.filter(d => d.day !== server(Date.now()).day);
  const s = summarize(past);
  const usd = past.map(d => d.trade).filter(t => t && t.how).reduce((a, t) => a + t.r * t.risk * 100 * state.settings.lots, 0);
  const health = s.profitFactor == null ? 'idle' : s.profitFactor >= 1.2 ? 'good' : s.profitFactor >= 1 ? 'weak' : 'bad';
  const verdict = { good: 'Working on recent gold prices', weak: 'Barely profitable recently. Trade small or wait.', bad: 'Losing on recent gold prices. Don’t trade it until this turns green.', idle: 'Not enough trades yet' }[health];
  const months = Math.round(HISTORY_DAYS / 30);
  el.dataset.health = health;
  el.innerHTML = `
    <div class="rec-head"><h2>Tested on the last ${months} months of gold</h2><span class="pill">${verdict}</span></div>
    <div class="stats">
      <div><span>Trades</span><b class="num">${s.n}</b></div>
      <div><span>Won</span><b class="num">${s.winRate == null ? '–' : Math.round(s.winRate * 100) + '%'}</b></div>
      <div><span>Profit factor</span><b class="num">${s.profitFactor == null ? '–' : isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : '∞'}</b></div>
      <div><span>At ${state.settings.lots} lots</span><b class="num ${usd >= 0 ? 'up' : 'down'}">${s$(usd)}</b></div>
    </div>
    <p class="meta">${s.skipped} of ${s.days} days were skipped by the range filter. Worst losing run: ${s.maxDD.toFixed(1)}R. Profit factor is money won ÷ money lost; above 1 makes money.</p>
    <p class="meta">The published test of the same rules: 715 trades over 3.7 years, about 49% won, profit factor 1.38, and 1.61 on unseen 2026 data. <a href="${STUDY_URL}" target="_blank" rel="noopener">Read the study</a>.</p>
    ${state.source === 'demo' ? '<p class="demo">Live prices are unreachable on this network, so these numbers come from demo data and mean nothing.</p>' : ''}`;
}

function renderHistory() {
  const list = state.days.filter(d => d.day !== server(Date.now()).day).slice(-10).reverse();
  $('#history').innerHTML = list.map(d => {
    const t = d.trade;
    const date = new Date(`${d.day}T12:00:00Z`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    if (!t) return `<li><span class="h-side">–</span><span class="h-what">${date}<small>${d.phase === 'skip' ? 'Skipped by range filter' : 'No breakout'}</small></span><span class="h-res"></span></li>`;
    const usd = t.r * t.risk * 100 * state.settings.lots;
    const how = { tp: 'Target', sl: 'Stopped', be: 'Break-even', time: 'Closed at end of day' }[t.how];
    return `<li><span class="h-side ${t.dir > 0 ? 'up' : 'down'}">${t.dir > 0 ? 'BUY' : 'SELL'}</span>
      <span class="h-what">${date}<small>${how}</small></span>
      <span class="h-res ${t.r > 0 ? 'up' : t.r < 0 ? 'down' : ''}"><b class="num">${t.r >= 0 ? '+' : ''}${t.r.toFixed(2)}R</b><small class="num">${s$(usd)}</small></span></li>`;
  }).join('');
  const trades = list.map(d => d.trade).filter(t => t && t.how);
  $('#score').textContent = trades.length ? `${trades.filter(t => t.r > 0).length} of ${trades.length} won` : '';
}

/* ---------- news & alerts ---------- */
function renderAlertBar() {
  const bar = $('#alert-bar');
  const now = Date.now();
  const c = state.calendar ? conditions(state.calendar, null, now).filter(x => !/weekend|Friday/.test(x.text)) : [];
  const dayEnd = serverHourToMs(now, RULES.closeHour);
  const big = state.calendar ? upcoming(state.calendar, now).find(e => e.impact === 'high' && e.time > now && e.time < dayEnd) : null;
  if (c.find(x => x.block)) { bar.textContent = c.find(x => x.block).text; bar.dataset.level = 'bad'; bar.hidden = false; }
  else if (big) {
    bar.textContent = `${big.title} today at ${new Date(big.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Expect a fast move. If you’re in a trade before it, consider moving your stop to entry or closing.`;
    bar.dataset.level = 'warn'; bar.hidden = false;
  } else bar.hidden = true;
}

// One alert per change of today's state.
function alerts() {
  const d = today();
  if (!d || state.source !== 'live') return;
  const t = d.trade;
  const key = `${d.day}:${d.phase}:${t ? `${t.dir}:${t.beDone}:${t.how || ''}` : ''}`;
  const last = store.get('blue-trading.alerted', '');
  if (key === last) return;
  store.set('blue-trading.alerted', key);
  if (!last.startsWith(d.day) && d.phase !== 'pending') return; // no alert for states reached before the page was open
  if (d.phase === 'pending') notify(`Gold orders ready: BUY STOP ${fmt(d.long.entry)} and SELL STOP ${fmt(d.short.entry)}. Open the page for stops and targets.`);
  else if (d.phase === 'skip') notify('No gold trade today: the range is outside the filter.');
  else if (d.phase === 'open' && !t.beDone) notify(`${t.dir > 0 ? 'BUY' : 'SELL'} filled at ${fmt(t.entry)}. Cancel the other order. Stop ${fmt(t.stop)}, target ${fmt(t.tp)}.`);
  else if (d.phase === 'open' && t.beDone) notify(`Move your stop to entry now: ${fmt(t.entry)}.`);
  else if (d.phase === 'done') notify(`Trade closed: ${t.r >= 0 ? '+' : ''}${t.r.toFixed(2)}R.`);
}

function notify(text) {
  toast(text);
  try {
    const ctx = notify.ctx || (notify.ctx = new AudioContext());
    for (const [f, at] of [[880, 0], [1175, 0.18]]) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.14, ctx.currentTime + at);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + at + 0.3);
      o.connect(g).connect(ctx.destination); o.start(ctx.currentTime + at); o.stop(ctx.currentTime + at + 0.3);
    }
  } catch { /* audio blocked */ }
  try { if (Notification.permission === 'granted') new Notification('Blue Trading Gold', { body: text }); } catch { /* unsupported */ }
}

/* ---------- utils ---------- */
function setFeed(kind) { $('#feed').dataset.state = kind; $('#feed').title = { live: 'Live prices', demo: 'Demo prices', loading: 'Loading…' }[kind] || ''; }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 6000);
}

/* ---------- boot ---------- */
if (state.settings.configured) showBoard(); else showSetup();
loadHistory();
loadCalendar().then(c => { state.calendar = c; renderAlertBar(); });
refreshPrice();
setInterval(refreshRecent, 30000);
setInterval(refreshPrice, 10000);
setInterval(() => { if (!$('#board').hidden) { renderToday(); renderAlertBar(); } }, 60000);
setInterval(() => loadCalendar().then(c => { state.calendar = c; }), 30 * 60000);
