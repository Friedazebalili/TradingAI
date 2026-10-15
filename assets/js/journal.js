// Trade journal: stored in this browser's localStorage, with stats derived on read.

const KEY = 'blue-trading.journal.v1';
const SETTINGS_KEY = 'blue-trading.settings.v1';

export const SETUPS = [
  '1H FVG + LTF CHoCH',
  'Fakeout (sweep trap)',
  'CHoCH breakout',
  'Mitigation retest',
  'Other',
];

export const DEFAULT_SETTINGS = { balance: 10000, riskPct: 1, dailyLossPct: 3, maxTrades: 4 };

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}

function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

export function loadTrades() { return read(KEY, []); }
export function saveTrades(trades) { return write(KEY, trades); }
export function loadSettings() { return { ...DEFAULT_SETTINGS, ...read(SETTINGS_KEY, {}) }; }
export function saveSettings(s) { return write(SETTINGS_KEY, s); }

export function tradeResult(t) {
  const dir = t.side === 'short' ? -1 : 1;
  const risk = Math.abs(t.entry - t.stop);
  const open = t.exit == null || t.exit === '' || isNaN(t.exit);
  if (open) return { open: true, pnl: 0, r: null, plannedRR: t.target ? Math.abs(t.target - t.entry) / (risk || 1) : null };
  const pnl = (t.exit - t.entry) * dir * t.qty - (t.fees || 0);
  const r = risk ? ((t.exit - t.entry) * dir) / risk : null;
  return { open: false, pnl, r, win: pnl > 0, plannedRR: t.target ? Math.abs(t.target - t.entry) / (risk || 1) : null };
}

export function stats(trades) {
  const closed = trades.map(t => ({ t, res: tradeResult(t) })).filter(x => !x.res.open)
    .sort((a, b) => new Date(a.t.date) - new Date(b.t.date));
  const wins = closed.filter(x => x.res.win);
  const losses = closed.filter(x => !x.res.win);
  const sum = arr => arr.reduce((a, b) => a + b, 0);
  const grossWin = sum(wins.map(x => x.res.pnl));
  const grossLoss = -sum(losses.map(x => x.res.pnl));
  const rs = closed.map(x => x.res.r).filter(r => r != null);
  let equity = 0;
  const curve = closed.map(x => ({ time: Math.floor(new Date(x.t.date).getTime() / 1000), value: (equity += x.res.pnl) }));

  const bySetup = {};
  for (const x of closed) {
    const s = bySetup[x.t.setup] || (bySetup[x.t.setup] = { setup: x.t.setup, n: 0, wins: 0, pnl: 0, r: 0 });
    s.n++; s.pnl += x.res.pnl; s.r += x.res.r || 0; if (x.res.win) s.wins++;
  }
  let streak = 0, streakType = null;
  for (let i = closed.length - 1; i >= 0; i--) {
    const w = closed[i].res.win;
    if (streakType === null) streakType = w;
    if (w !== streakType) break;
    streak++;
  }
  return {
    total: trades.length,
    closed: closed.length,
    open: trades.length - closed.length,
    winRate: closed.length ? wins.length / closed.length : null,
    net: grossWin - grossLoss,
    avgWin: wins.length ? grossWin / wins.length : null,
    avgLoss: losses.length ? grossLoss / losses.length : null,
    profitFactor: grossLoss ? grossWin / grossLoss : (grossWin ? Infinity : null),
    avgR: rs.length ? sum(rs) / rs.length : null,
    bySetup: Object.values(bySetup).sort((a, b) => b.r / b.n - a.r / a.n),
    curve,
    streak, streakType,
    long: summarize(closed.filter(x => x.t.side !== 'short')),
    short: summarize(closed.filter(x => x.t.side === 'short')),
    offPlan: closed.filter(x => x.t.followedPlan === false),
  };
}

function summarize(list) {
  const n = list.length;
  const w = list.filter(x => x.res.win).length;
  return { n, winRate: n ? w / n : null, pnl: list.reduce((a, x) => a + x.res.pnl, 0) };
}

export function todayTrades(trades) {
  const d = new Date().toDateString();
  return trades.filter(t => new Date(t.date).toDateString() === d);
}

export function toCSV(trades) {
  const cols = ['date', 'symbol', 'side', 'setup', 'entry', 'stop', 'target', 'exit', 'qty', 'fees', 'followedPlan', 'notes'];
  const esc = v => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = trades.map(t => {
    const r = tradeResult(t);
    return [...cols.map(c => esc(t[c])), r.open ? '' : r.pnl.toFixed(2), r.r == null ? '' : r.r.toFixed(2)].join(',');
  });
  return [[...cols, 'pnl', 'r'].join(','), ...rows].join('\n');
}

// Marked as examples so they are never mistaken for real results.
export function exampleTrades() {
  const day = 86400000;
  const now = Date.now();
  const mk = (daysAgo, o) => ({ id: crypto.randomUUID(), date: new Date(now - daysAgo * day).toISOString().slice(0, 16), fees: 0, followedPlan: true, example: true, ...o });
  return [
    mk(9, { symbol: 'BTCUSDT', side: 'long', setup: '1H FVG + LTF CHoCH', entry: 61250, stop: 60900, target: 62300, exit: 62180, qty: 0.28, notes: 'Example: textbook tap, 5m CHoCH, entry on pullback.' }),
    mk(8, { symbol: 'ETHUSDT', side: 'short', setup: 'Fakeout (sweep trap)', entry: 3320, stop: 3352, target: 3240, exit: 3352, qty: 3, notes: 'Example: shorted before the sweep finished.' }),
    mk(6, { symbol: 'SOLUSDT', side: 'long', setup: 'Mitigation retest', entry: 142.1, stop: 139.8, target: 148, exit: 147.6, qty: 40, notes: 'Example: held to the order block target.' }),
    mk(5, { symbol: 'BTCUSDT', side: 'long', setup: 'CHoCH breakout', entry: 62900, stop: 62500, target: 64100, exit: 62500, qty: 0.25, followedPlan: false, notes: 'Example: chased, no HTF zone behind it.' }),
    mk(3, { symbol: 'ETHUSDT', side: 'long', setup: '1H FVG + LTF CHoCH', entry: 3185, stop: 3160, target: 3260, exit: 3255, qty: 4, notes: 'Example: bullish engulfing trigger.' }),
    mk(1, { symbol: 'PAXGUSDT', side: 'short', setup: 'Fakeout (sweep trap)', entry: 2412, stop: 2421, target: 2390, exit: 2393, qty: 10, notes: 'Example: shooting star after BSL sweep.' }),
  ];
}
