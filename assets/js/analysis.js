// Market structure engine: indicators, swings, BOS/CHoCH, fair value gaps,
// candlestick triggers and the 1H FVG -> LTF CHoCH workflow check.
// Pure functions only. Candles are {time, open, high, low, close, volume}, oldest first.

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

export function atr(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  if (candles.length <= period) return out;
  const tr = candles.map((c, i) => i === 0 ? c.high - c.low : Math.max(
    c.high - c.low,
    Math.abs(c.high - candles[i - 1].close),
    Math.abs(c.low - candles[i - 1].close),
  ));
  let prev = tr.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  out[period] = prev;
  for (let i = period + 1; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

// A pivot needs `k` bars on each side, so it is only known k bars later.
export function findSwings(candles, k = 3) {
  const highs = [], lows = [];
  for (let i = k; i < candles.length - k; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (j < i ? candles[j].high >= candles[i].high : candles[j].high > candles[i].high) isHigh = false;
      if (j < i ? candles[j].low <= candles[i].low : candles[j].low < candles[i].low) isLow = false;
    }
    if (isHigh) highs.push({ index: i, confirmedAt: i + k, time: candles[i].time, price: candles[i].high });
    if (isLow) lows.push({ index: i, confirmedAt: i + k, time: candles[i].time, price: candles[i].low });
  }
  return { highs, lows };
}

// Walks the candles in order and records each close beyond the most recent
// confirmed swing. A break against the current trend is a CHoCH, with it a BOS.
export function marketStructure(candles, swings) {
  const events = [];
  let trend = 0;
  let hi = null, lo = null;
  let hiIdx = 0, loIdx = 0;
  for (let i = 0; i < candles.length; i++) {
    while (hiIdx < swings.highs.length && swings.highs[hiIdx].confirmedAt <= i) hi = { ...swings.highs[hiIdx++], broken: false };
    while (loIdx < swings.lows.length && swings.lows[loIdx].confirmedAt <= i) lo = { ...swings.lows[loIdx++], broken: false };
    const c = candles[i];
    if (hi && !hi.broken && c.close > hi.price) {
      events.push({ type: trend === -1 ? 'CHoCH' : 'BOS', dir: 1, level: hi.price, index: i, time: c.time, swingTime: hi.time });
      trend = 1; hi.broken = true;
    }
    if (lo && !lo.broken && c.close < lo.price) {
      events.push({ type: trend === 1 ? 'CHoCH' : 'BOS', dir: -1, level: lo.price, index: i, time: c.time, swingTime: lo.time });
      trend = -1; lo.broken = true;
    }
  }
  return { trend, events };
}

// Three-candle imbalance. Gaps smaller than minSize (in price) are ignored.
export function findFVGs(candles, minSize = 0) {
  const gaps = [];
  for (let i = 2; i < candles.length; i++) {
    const a = candles[i - 2], c = candles[i];
    if (c.low > a.high && c.low - a.high >= minSize) {
      gaps.push({ dir: 1, top: c.low, bottom: a.high, index: i - 1, time: candles[i - 1].time });
    } else if (c.high < a.low && a.low - c.high >= minSize) {
      gaps.push({ dir: -1, top: a.low, bottom: c.high, index: i - 1, time: candles[i - 1].time });
    }
  }
  for (const g of gaps) {
    g.tapped = false; g.filled = false; g.tapIndex = null;
    for (let j = g.index + 2; j < candles.length; j++) {
      const c = candles[j];
      const touched = g.dir === 1 ? c.low <= g.top : c.high >= g.bottom;
      if (touched && !g.tapped) { g.tapped = true; g.tapIndex = j; g.tapTime = c.time; }
      if (g.dir === 1 ? c.close < g.bottom : c.close > g.top) { g.filled = true; g.filledIndex = j; break; }
    }
  }
  return gaps;
}

// Names follow the Candlestick Execution Matrix in the playbook.
export function detectPatterns(candles) {
  const found = [];
  const trendInto = (i, n = 4) => i >= n ? Math.sign(candles[i - 1].close - candles[i - n].close) : 0;
  for (let i = 2; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1], pp = candles[i - 2];
    const range = c.high - c.low;
    if (range <= 0) continue;
    const body = Math.abs(c.close - c.open);
    const upper = c.high - Math.max(c.open, c.close);
    const lower = Math.min(c.open, c.close) - c.low;
    const pBody = Math.abs(p.close - p.open);
    const prior = trendInto(i);
    const add = (name, dir, key) => found.push({ name, dir, key, index: i, time: c.time });

    if (p.close < p.open && c.close > c.open && c.close >= p.open && c.open <= p.close && body > pBody) {
      add('Bullish Engulfing', 1, 'bull-engulf');
    } else if (p.close > p.open && c.close < c.open && c.close <= p.close - pBody && c.open >= p.close && body > pBody) {
      add('Bearish Engulfing', -1, 'bear-engulf');
    } else if (lower >= 2 * body && upper <= Math.max(body, range * 0.1) && prior <= 0) {
      add('Hammer', 1, 'hammer');
    } else if (upper >= 2 * body && lower <= Math.max(body, range * 0.1) && prior > 0) {
      add('Shooting Star', -1, 'shooting-star');
    } else if (upper >= 2 * body && lower <= Math.max(body, range * 0.1) && prior < 0) {
      add('Inverted Hammer', 1, 'inv-hammer');
    } else if (body >= range * 0.9) {
      add(c.close > c.open ? 'Bullish Marubozu' : 'Bearish Marubozu', c.close > c.open ? 1 : -1, 'marubozu');
    } else if (body <= range * 0.1) {
      add('Doji', 0, 'doji');
    }

    const ppBody = Math.abs(pp.close - pp.open);
    const ppRange = pp.high - pp.low || 1;
    if (ppBody > ppRange * 0.5 && pBody < ppBody * 0.4) {
      const mid = (pp.open + pp.close) / 2;
      if (pp.close < pp.open && c.close > c.open && c.close > mid) add('Morning Star', 1, 'morning-star');
      if (pp.close > pp.open && c.close < c.open && c.close < mid) add('Evening Star', -1, 'evening-star');
    }
  }
  return found;
}

export const HTF_FOR = { '1m': '15m', '5m': '1h', '15m': '1h', '1h': '4h', '4h': '1d', '1d': '1w' };

// Full read of one chart, optionally checked against a higher-timeframe chart.
export function analyze(candles, htfCandles = null) {
  if (!candles || candles.length < 60) return null;
  const closes = candles.map(c => c.close);
  const last = candles[candles.length - 1];
  const n = candles.length - 1;
  const ema20 = ema(closes, 20), ema50 = ema(closes, 50);
  const rsi14 = rsi(closes, 14), atr14 = atr(candles, 14);
  const atrNow = atr14[n] || (last.high - last.low);
  const swings = findSwings(candles, 3);
  const structure = marketStructure(candles, swings);
  const fvgs = findFVGs(candles, atrNow * 0.15);
  const openFvgs = fvgs.filter(g => !g.filled).slice(-6);
  const patterns = detectPatterns(candles);
  const recentPatterns = patterns.filter(p => p.index >= n - 5);

  // Bias score: each line adds or subtracts and is kept as a reason.
  const reasons = [];
  let score = 0;
  const lastEvent = structure.events[structure.events.length - 1];
  if (structure.trend !== 0) {
    score += structure.trend * 2;
    reasons.push({ dir: structure.trend, text: `Structure is ${structure.trend > 0 ? 'bullish' : 'bearish'}${lastEvent ? ` (last ${lastEvent.type} at ${fmt(lastEvent.level)})` : ''}` });
  }
  if (ema50[n] != null) {
    const d = last.close > ema50[n] ? 1 : -1;
    score += d;
    reasons.push({ dir: d, text: `Price is ${d > 0 ? 'above' : 'below'} the 50 EMA (${fmt(ema50[n])})` });
  }
  if (ema20[n] != null && ema50[n] != null) {
    const d = ema20[n] > ema50[n] ? 1 : -1;
    score += d;
    reasons.push({ dir: d, text: `20 EMA is ${d > 0 ? 'above' : 'below'} the 50 EMA` });
  }
  if (rsi14[n] != null) {
    const r = rsi14[n];
    if (r >= 55) { score += 1; reasons.push({ dir: 1, text: `RSI ${r.toFixed(0)} shows upside momentum` }); }
    else if (r <= 45) { score -= 1; reasons.push({ dir: -1, text: `RSI ${r.toFixed(0)} shows downside momentum` }); }
    else reasons.push({ dir: 0, text: `RSI ${r.toFixed(0)} is neutral` });
    if (r >= 75) reasons.push({ dir: -1, text: 'RSI is overbought, chasing longs here is risky' });
    if (r <= 25) reasons.push({ dir: 1, text: 'RSI is oversold, chasing shorts here is risky' });
  }
  const trigger = recentPatterns.filter(p => p.dir !== 0).pop();
  if (trigger) {
    score += trigger.dir;
    reasons.push({ dir: trigger.dir, text: `${trigger.name} printed ${n - trigger.index === 0 ? 'on the current candle' : `${n - trigger.index} candle(s) ago`}` });
  }
  const bias = score >= 2 ? 1 : score <= -2 ? -1 : 0;
  const confidence = Math.min(100, Math.round(Math.abs(score) / 6 * 100));

  const workflow = htfCandles && htfCandles.length > 20
    ? precisionWorkflow(candles, htfCandles, structure, patterns, swings, atrNow)
    : null;

  const plan = buildPlan({ candles, bias, swings, openFvgs, workflow, atrNow });

  return {
    price: last.close, time: last.time, atr: atrNow, recentRange: last.high - last.low,
    ema20: ema20[n], ema50: ema50[n], rsi: rsi14[n],
    series: { ema20, ema50 },
    swings, structure, fvgs: openFvgs, patterns, recentPatterns,
    bias, score, confidence, reasons, workflow, plan,
  };
}

// Step 1: price reaches an open higher-timeframe FVG.
// Step 2: the lower timeframe prints a CHoCH (or BOS) in the gap's direction after the tap.
// Step 3: a trigger candle in the same direction after that shift.
export function precisionWorkflow(candles, htf, structure, patterns, swings, atrNow) {
  const htfAtr = atr(htf, 14)[htf.length - 1] || atrNow * 4;
  const zones = findFVGs(htf, htfAtr * 0.1).filter(g => !g.filled);
  const price = candles[candles.length - 1].close;

  // Which zones has the lower timeframe traded into?
  const touches = zones.map(z => {
    const tapIdx = candles.findIndex(c => c.time > z.time && (z.dir === 1 ? c.low <= z.top && c.high >= z.bottom : c.high >= z.bottom && c.low <= z.top));
    return { zone: z, tapIdx };
  });
  const tapped = touches.filter(t => t.tapIdx >= 0).sort((a, b) => b.tapIdx - a.tapIdx)[0];

  const nearest = zones
    .map(z => ({ zone: z, dist: price > z.top ? price - z.top : price < z.bottom ? z.bottom - price : 0 }))
    .sort((a, b) => a.dist - b.dist)[0];

  const result = { zones, step: 0, status: 'No open higher-timeframe gap', zone: null, steps: [] };
  if (!zones.length) {
    result.steps = [
      { done: false, text: 'No unfilled higher-timeframe FVG nearby. Wait for displacement to create one.' },
      { done: false, text: 'Lower-timeframe CHoCH' },
      { done: false, text: 'Trigger candle' },
    ];
    return result;
  }

  if (!tapped) {
    const z = nearest.zone;
    result.zone = z;
    result.status = 'Waiting for price to reach the POI';
    result.steps = [
      { done: false, text: `Nearest open ${z.dir > 0 ? 'bullish' : 'bearish'} HTF FVG: ${fmt(z.bottom)} – ${fmt(z.top)} (${pct(nearest.dist / price)} away)` },
      { done: false, text: `Wait for a ${z.dir > 0 ? 'bullish' : 'bearish'} CHoCH inside the zone` },
      { done: false, text: `Then a ${z.dir > 0 ? 'Hammer / Bullish Engulfing' : 'Shooting Star / Bearish Engulfing'} trigger` },
    ];
    return result;
  }

  const z = tapped.zone;
  result.zone = z;
  result.step = 1;
  const shift = structure.events.find(e => e.index >= tapped.tapIdx && e.dir === z.dir);
  const against = structure.events.find(e => e.index >= tapped.tapIdx && e.dir === -z.dir && e.type === 'CHoCH');
  const side = z.dir > 0 ? 'bullish' : 'bearish';
  result.steps.push({ done: true, text: `Price tapped the ${side} HTF FVG ${fmt(z.bottom)} – ${fmt(z.top)}` });

  if (!shift) {
    result.status = against ? 'Zone is failing. Structure broke the other way' : `In the POI. Waiting for a ${side} CHoCH`;
    result.failing = !!against;
    result.steps.push({ done: false, text: `Lower-timeframe ${side} CHoCH not printed yet` });
    result.steps.push({ done: false, text: 'Trigger candle' });
    return result;
  }
  result.step = 2;
  result.shift = shift;
  result.steps.push({ done: true, text: `${shift.type} ${side} at ${fmt(shift.level)}` });
  const trig = patterns.find(p => p.index >= shift.index && p.dir === z.dir);
  if (!trig) {
    result.status = 'Shift confirmed. Wait for the pullback trigger';
    result.steps.push({ done: false, text: `Wait for a pullback and a ${z.dir > 0 ? 'bullish' : 'bearish'} trigger candle` });
    return result;
  }
  result.step = 3;
  result.trigger = trig;
  result.status = `Setup triggered (${side})`;
  result.steps.push({ done: true, text: `${trig.name} trigger after the shift` });
  return result;
}

// Intraday levels: the stop sits just behind the latest swing on this timeframe,
// kept between 0.8 and 2.5 ATR. TP1 is 1R. TP2 is the nearest swing between 1.5R
// and 3R, otherwise 2R. A setup whose proper stop is wider than 2.5 ATR is marked
// tooWide and not traded.
function buildPlan({ candles, bias, swings, openFvgs, workflow, atrNow }) {
  const price = candles[candles.length - 1].close;
  const dir = workflow && workflow.step >= 2 ? workflow.zone.dir : bias;
  if (dir === 0) return { dir: 0, note: 'No clear edge. Signals are mixed, so standing aside is a valid position.' };

  const pad = atrNow * 0.2;
  const behind = dir > 0
    ? swings.lows.filter(s => s.price < price).slice(-1)[0]
    : swings.highs.filter(s => s.price > price).slice(-1)[0];
  let dist = behind ? Math.abs(price - behind.price) + pad : atrNow * 1.2;
  let stopReason = behind ? (dir > 0 ? 'just below the last swing low' : 'just above the last swing high') : '1.2 ATR from price';
  const tooWide = dist > atrNow * 2.5;
  if (dist < atrNow * 0.8) { dist = atrNow * 0.8; stopReason = 'outside normal noise (0.8 ATR)'; }
  const stop = price - dir * dist;

  const pool = (dir > 0 ? swings.highs.filter(s => s.price > price) : swings.lows.filter(s => s.price < price))
    .map(s => s.price)
    .filter(p => Math.abs(p - price) >= dist * 1.5 && Math.abs(p - price) <= dist * 3)
    .sort((x, y) => Math.abs(x - price) - Math.abs(y - price));
  const target = pool.length ? pool[0] - dir * atrNow * 0.1 : price + dir * dist * 2;
  const targetReason = pool.length ? (dir > 0 ? 'just under the next swing high' : 'just above the next swing low') : '2× the stop distance';
  return {
    dir, entry: price, stop, target, stopReason, targetReason,
    rr: Math.abs(target - price) / dist,
    tooTight: false, tooWide,
    nearFvg: openFvgs.filter(g => g.dir === dir).slice(-1)[0] || null,
  };
}

export function fmt(v) {
  if (v == null || !isFinite(v)) return '–';
  const a = Math.abs(v);
  const d = a >= 1000 ? 2 : a >= 10 ? 3 : a >= 1 ? 4 : 6;
  return v.toLocaleString('en-US', { minimumFractionDigits: Math.min(d, 2), maximumFractionDigits: d });
}

export function pct(v) {
  return `${(v * 100).toFixed(2)}%`;
}

// Walk-forward backtest. At every bar the strategy only sees candles that had
// closed by then, so results are not peeking at the future. If a bar touches
// both the stop and the target, the stop is assumed to fill first.
export const STRATEGIES = {
  workflow: {
    name: '1H FVG + LTF CHoCH',
    desc: 'Enters when price taps an open higher-timeframe FVG, the lower timeframe prints a CHoCH in the same direction, and a trigger candle follows.',
    signal(a, i) {
      const wf = a.workflow;
      if (!wf || wf.step < 3 || wf.failing || !wf.trigger) return 0;
      return wf.trigger.index === i ? wf.zone.dir : 0;
    },
  },
  trend: {
    name: 'Trend pullback',
    desc: 'Trades with structure and both EMAs aligned, entering on an engulfing, hammer or shooting star trigger.',
    signal(a, i) {
      if (a.bias === 0 || a.structure.trend !== a.bias) return 0;
      const p = a.patterns[a.patterns.length - 1];
      if (!p || p.index !== i || p.dir !== a.bias) return 0;
      if (!['bull-engulf', 'bear-engulf', 'hammer', 'shooting-star'].includes(p.key)) return 0;
      return a.bias;
    },
  },
};

export function backtest(candles, htfCandles, strategyId = 'workflow', opts = {}) {
  const strat = STRATEGIES[strategyId];
  const window = opts.window || 250;
  const htfStep = opts.htfStep || 3600;
  const minRR = opts.minRR ?? 1.5;
  const trades = [];
  let pos = null;
  for (let i = 80; i < candles.length; i++) {
    const c = candles[i];
    if (pos) {
      const hitStop = pos.dir > 0 ? c.low <= pos.stop : c.high >= pos.stop;
      const hitTarget = pos.dir > 0 ? c.high >= pos.target : c.low <= pos.target;
      if (hitStop || hitTarget) {
        pos.exit = hitStop ? pos.stop : pos.target;
        pos.exitTime = c.time;
        pos.r = ((pos.exit - pos.entry) * pos.dir) / Math.abs(pos.entry - pos.stop);
        trades.push(pos);
        pos = null;
      }
      continue;
    }
    const slice = candles.slice(Math.max(0, i + 1 - window), i + 1);
    const htf = htfCandles ? htfCandles.filter(h => h.time + htfStep <= c.time + 1) : null;
    const a = analyze(slice, htf);
    if (!a) continue;
    const localIdx = slice.length - 1;
    const dir = strat.signal(a, localIdx);
    if (!dir || a.plan.dir !== dir || a.plan.tooWide || a.plan.rr < minRR) continue;
    pos = { dir, entry: c.close, stop: a.plan.stop, target: a.plan.target, time: c.time };
  }
  const n = trades.length;
  const wins = trades.filter(t => t.r > 0);
  const sumR = trades.reduce((s, t) => s + t.r, 0);
  const gw = wins.reduce((s, t) => s + t.r, 0);
  const gl = -trades.filter(t => t.r <= 0).reduce((s, t) => s + t.r, 0);
  let peak = 0, eq = 0, dd = 0;
  for (const t of trades) { eq += t.r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  return {
    strategy: strat.name, trades, open: pos,
    n, winRate: n ? wins.length / n : null,
    totalR: sumR, avgR: n ? sumR / n : null,
    profitFactor: gl ? gw / gl : (gw ? Infinity : null),
    maxDrawdownR: dd,
    from: candles[0]?.time, to: candles[candles.length - 1]?.time,
  };
}
