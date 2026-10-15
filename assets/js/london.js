// Gold London breakout, implemented exactly as published in
// "London Breakout on Gold: 3.7 Years of Backtests" (mql5.com/en/blogs/post/777540):
//
//   Range       high and low from 03:00 to 08:00 broker server time (Athens time, GMT+2/+3)
//   Filter      skip the day if the range is under 0.30% or over 1.60% of price
//   Orders      at 08:00, buy stop at the range high and sell stop at the range low;
//               the first to fill cancels the other; one trade per day
//   Stop        the opposite side of the range, capped at 0.6% of price from entry
//   Target      2.5R; move the stop to entry once price reaches 1.5R
//   Time exit   close anything still open at 21:00 server time
//
// Published result: profit factor 1.38, about 49% winners, 715 trades, 17% max
// drawdown; 2026 out-of-sample profit factor 1.61 over 157 trades.

export const RULES = { rangeStart: 3, rangeEnd: 8, closeHour: 21, minRangePct: 0.30, maxRangePct: 1.60, maxStopPct: 0.6, tpR: 2.5, beR: 1.5 };

const fmtParts = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Athens', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
});

// Server-time (Athens) fields for a timestamp in ms.
export function server(ms) {
  const p = Object.fromEntries(fmtParts.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: +p.hour, minute: +p.minute, weekday: p.weekday };
}

// UTC ms for a given Athens-time hour on the server day containing `refMs`.
export function serverHourToMs(refMs, hour) {
  const s = server(refMs);
  const [y, m, d] = s.day.split('-').map(Number);
  let guess = Date.UTC(y, m - 1, d, hour - 2);
  const got = server(guess).hour;
  return guess - (got - hour) * 3600000;
}

// Groups 15-minute candles into server days and plays the rules through each day.
// Returns one entry per weekday. `now` lets the current day show a partial state.
export function playDays(candles, now = Date.now()) {
  const days = new Map();
  for (const c of candles) {
    const s = server(c.time * 1000);
    if (s.weekday === 'Sat' || s.weekday === 'Sun') continue;
    if (!days.has(s.day)) days.set(s.day, []);
    days.get(s.day).push({ ...c, h: s.hour + s.minute / 60 });
  }
  return [...days.entries()].map(([day, list]) => playDay(day, list, now));
}

function playDay(day, list, now) {
  const R = RULES;
  const range = list.filter(c => c.h >= R.rangeStart && c.h < R.rangeEnd);
  const after = list.filter(c => c.h >= R.rangeEnd && c.h < R.closeHour);
  const out = { day, phase: 'range', range: null, trade: null };
  const lastH = list.length ? list[list.length - 1].h : 0;
  if (range.length) {
    out.range = { high: Math.max(...range.map(c => c.high)), low: Math.min(...range.map(c => c.low)) };
  }
  // The range is complete once the first candle at or after 08:00 exists.
  if (!after.length && lastH < R.rangeEnd) return out;
  if (range.length < 16) { out.phase = 'skip'; out.skip = 'Not enough price data for the 03:00–08:00 range.'; return out; }

  const { high, low } = out.range;
  const ref = after.length ? after[0].open : range[range.length - 1].close;
  const pct = ((high - low) / ref) * 100;
  out.range.pct = pct;
  if (pct < R.minRangePct) { out.phase = 'skip'; out.skip = `The range is only ${pct.toFixed(2)}% of price, too narrow. Breakouts from narrow ranges fail too often.`; return out; }
  if (pct > R.maxRangePct) { out.phase = 'skip'; out.skip = `The range is ${pct.toFixed(2)}% of price, too wide. The move has already happened.`; return out; }

  const levels = dir => {
    const entry = dir > 0 ? high : low;
    const cap = entry * R.maxStopPct / 100;
    const stop = dir > 0 ? Math.max(low, entry - cap) : Math.min(high, entry + cap);
    const risk = Math.abs(entry - stop);
    return { dir, entry, stop, risk, tp: entry + dir * risk * R.tpR, be: entry + dir * risk * R.beR };
  };
  out.long = levels(1);
  out.short = levels(-1);
  out.phase = 'pending';

  let t = null;
  for (const c of after) {
    if (!t) {
      const up = c.high >= high, down = c.low <= low;
      if (!up && !down) continue;
      // Both sides touched in one 15-minute candle: we can't know the order, so count it as a loss.
      if (up && down) { t = { ...out.long, openedAt: c.time, stopNow: out.long.stop, beDone: false, exit: out.long.stop, r: -1, how: 'sl', closedAt: c.time }; break; }
      t = { ...(up ? out.long : out.short), openedAt: c.time, stopNow: (up ? out.long : out.short).stop, beDone: false };
    }
    const d = t.dir;
    const adverse = d > 0 ? c.low : c.high;
    const favour = d > 0 ? c.high : c.low;
    if ((adverse - t.stopNow) * d <= 0) { finish(t, t.stopNow, t.beDone ? 'be' : 'sl', c.time); break; }
    if ((favour - t.tp) * d >= 0) { finish(t, t.tp, 'tp', c.time); break; }
    if (!t.beDone && (favour - t.be) * d >= 0) { t.beDone = true; t.stopNow = t.entry; }
    t.last = c.close;
  }
  if (t && !t.how) {
    const dayOver = lastH >= R.closeHour - 0.25 || server(now).day !== day;
    if (dayOver) finish(t, t.last ?? t.entry, 'time', after[after.length - 1].time);
  }
  out.trade = t;
  out.phase = !t ? (lastH >= R.closeHour - 0.25 || server(now).day !== day ? 'notrigger' : 'pending') : t.how ? 'done' : 'open';
  return out;
}

function finish(t, price, how, at) {
  t.exit = price; t.how = how; t.closedAt = at;
  t.r = how === 'sl' ? -1 : ((price - t.entry) * t.dir) / t.risk;
}

export function summarize(days) {
  const trades = days.map(d => d.trade).filter(t => t && t.how);
  const n = trades.length;
  const wins = trades.filter(t => t.r > 0);
  const gw = wins.reduce((a, t) => a + t.r, 0);
  const gl = -trades.filter(t => t.r <= 0).reduce((a, t) => a + t.r, 0);
  let eq = 0, peak = 0, dd = 0;
  for (const t of trades) { eq += t.r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  return {
    n, days: days.length,
    winRate: n ? wins.length / n : null,
    profitFactor: gl ? gw / gl : (gw ? Infinity : null),
    totalR: eq, avgR: n ? eq / n : null, maxDD: dd,
    skipped: days.filter(d => d.phase === 'skip').length,
  };
}
