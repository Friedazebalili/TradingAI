// Gold signal engine. Scans a few timeframes and returns a signal only when one
// of three setups passes every check. Otherwise it explains why there is none.
//
//   Bounce        price pulls back into a higher-timeframe gap in the direction of
//                 the bigger trend, the lower timeframe turns, and a trigger candle prints
//   Reversal      the same sequence against the bigger trend
//   Continuation  the trend breaks structure, price pulls back to the 20 EMA or an
//                 open gap (never chasing), and a trigger candle prints in the trend direction

import { analyze, backtest, findSwings, marketStructure, HTF_FOR } from './analysis.js';
import { fetchCandles, aggregate, intervalSeconds } from './data.js';
import { conditions } from './news.js';

export const GOLD = 'PAXGUSDT';
export const SCAN_TFS = ['5m', '15m', '1h'];
const FRESH_BARS = 2;   // trigger must be on one of the last 2 closed-or-current candles
const MIN_RR = 1.5;

const recordCache = new Map();

async function read(tf) {
  const htfTf = HTF_FOR[tf];
  const [main, htfRes] = await Promise.all([fetchCandles(GOLD, tf, 400), fetchCandles(GOLD, htfTf, 300)]);
  const htf = main.source === 'demo' ? aggregate(main.candles, htfTf) : htfRes.candles;
  const a = analyze(main.candles, htf);
  if (!a) return null;
  const htfTrend = marketStructure(htf, findSwings(htf, 3)).trend;
  return { tf, htfTf, candles: main.candles, htf, a, htfTrend, source: main.source };
}

// Recent record of the matching rules on this timeframe, refreshed every 30 minutes.
function record(r, kind) {
  const key = `${r.tf}:${kind}`;
  const hit = recordCache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60000) return hit.res;
  const res = backtest(r.candles, r.htf, kind === 'continuation' ? 'trend' : 'workflow', { htfStep: intervalSeconds(r.htfTf), minRR: MIN_RR });
  recordCache.set(key, { at: Date.now(), res });
  return res;
}

function evaluate(r, settings, calendar, daily) {
  const { a } = r;
  const n = r.candles.length - 1;
  const p = a.plan;
  const wf = a.workflow;
  const why = [];

  let kind = null, dir = 0;
  if (wf && wf.step === 3 && !wf.failing && wf.trigger && n - wf.trigger.index < FRESH_BARS && p.dir === wf.zone.dir) {
    dir = wf.zone.dir;
    kind = r.htfTrend === dir ? 'bounce' : 'reversal';
  } else if (a.bias !== 0 && a.structure.trend === a.bias && p.dir === a.bias) {
    const lastEvent = a.structure.events[a.structure.events.length - 1];
    const trig = a.patterns.filter(x => x.dir === a.bias && ['bull-engulf', 'bear-engulf', 'hammer', 'shooting-star', 'morning-star', 'evening-star'].includes(x.key)).pop();
    const nearEma = a.ema20 != null && Math.abs(a.price - a.ema20) <= a.atr * 0.6;
    const inGap = a.fvgs.some(g => g.dir === a.bias && a.price <= g.top + a.atr * 0.2 && a.price >= g.bottom - a.atr * 0.2);
    if (lastEvent && lastEvent.type === 'BOS' && lastEvent.dir === a.bias && trig && n - trig.index < FRESH_BARS && (nearEma || inGap)) {
      dir = a.bias; kind = 'continuation';
    } else if (lastEvent && lastEvent.dir === a.bias && !(nearEma || inGap)) {
      why.push(`Gold is trending ${a.bias > 0 ? 'up' : 'down'} on the ${r.tf} but has run away from the 20 EMA. Chasing here is how trend trades lose. Waiting for a pullback near ${Math.round(a.ema20)}.`);
    }
  }

  if (!kind) {
    if (!why.length) {
      if (wf && wf.zone && wf.step >= 1 && !wf.failing) why.push(`Price is at a ${r.htfTf} zone on the ${r.tf}. Waiting for the turn and a trigger candle.`);
      else if (a.bias === 0) why.push(`The ${r.tf} has no clear direction. No trade is a position.`);
      else why.push(`No clean entry on the ${r.tf} yet.`);
    }
    return { tf: r.tf, signal: null, why: why[0], source: r.source };
  }

  // Gates every signal must pass.
  const stopDist = Math.abs(p.entry - p.stop);
  const oz = settings.lots * 100;
  const risk = stopDist * oz;
  const riskPct = settings.balance > 0 ? (risk / settings.balance) * 100 : null;
  const blockers = [];
  if (p.rr < MIN_RR) blockers.push(`only ${p.rr.toFixed(1)}R to the target`);
  if (p.tooWide) blockers.push(`the proper stop would be $${stopDist.toFixed(0)} away, too wide for a clean trade`);
  if (dir > 0 && a.rsi > 72) blockers.push('the move is already stretched (RSI high)');
  if (dir < 0 && a.rsi < 28) blockers.push('the move is already stretched (RSI low)');
  if (riskPct != null && riskPct > settings.riskPct) blockers.push(`${settings.lots} lots would risk $${risk.toFixed(0)} (${riskPct.toFixed(1)}% of your balance)`);
  const warn = conditions(calendar, a);
  const block = warn.find(w => w.block);
  if (block) blockers.push(block.text.split('.')[0].toLowerCase());
  if (daily.lossHit) blockers.push('your daily loss limit is reached');
  if (daily.tradesHit) blockers.push('you have hit your trade limit for today');
  const rec = record(r, kind);
  if (rec.n >= 5 && rec.avgR <= 0) blockers.push(`this setup has lost money on the ${r.tf} recently (${rec.n} signals)`);

  const label = { bounce: 'Bounce', reversal: 'Reversal', continuation: 'Trend continuation' }[kind];
  if (blockers.length) {
    return { tf: r.tf, signal: null, why: `A ${label.toLowerCase()} ${dir > 0 ? 'buy' : 'sell'} formed on the ${r.tf}, but I'm skipping it: ${blockers[0]}.`, source: r.source };
  }

  return {
    tf: r.tf,
    source: r.source,
    why: null,
    signal: {
      id: `${r.tf}:${dir}:${Math.round(p.stop * 100)}`,
      at: Date.now(),
      tf: r.tf, kind, label, dir,
      entry: p.entry, stop: p.stop, tp1: p.entry + dir * stopDist, tp2: p.target, rr: p.rr,
      lots: settings.lots, risk, reward: Math.abs(p.target - p.entry) * oz, riskPct,
      reason: describe(kind, dir, r),
      warnings: warn.filter(w => !w.block).map(w => w.text),
      record: rec,
      source: r.source,
    },
  };
}

function describe(kind, dir, r) {
  const side = dir > 0 ? 'buyers' : 'sellers';
  if (kind === 'bounce') return `Price pulled back into a ${r.htfTf} gap in the direction of the main trend and ${side} stepped back in on the ${r.tf}.`;
  if (kind === 'reversal') return `Price hit a ${r.htfTf} gap against the main trend, the ${r.tf} broke the other way, and ${side} confirmed with a strong candle.`;
  return `The ${r.tf} trend broke structure, pulled back to value instead of running away, and ${side} came back in.`;
}

// Scan all timeframes. Returns the freshest signal (if any) and a status per timeframe.
export async function scanGold(settings, calendar, daily) {
  const results = [];
  for (const tf of SCAN_TFS) {
    try {
      const r = await read(tf);
      if (r) results.push(evaluate(r, settings, calendar, daily));
    } catch { /* skip this timeframe this round */ }
  }
  const signal = results.map(x => x.signal).filter(Boolean).sort((x, y) => SCAN_TFS.indexOf(y.tf) - SCAN_TFS.indexOf(x.tf))[0] || null;
  return { signal, results, source: results[0] ? results[0].source : null };
}

// Where the stop should be now for an open trade: entry after TP1, then behind
// each new swing on the signal timeframe.
export async function trailLevel(trade) {
  const r = await read(trade.tf);
  if (!r) return null;
  const pad = r.a.atr * 0.25;
  const swings = findSwings(r.candles, 2);
  const opened = trade.openedAt / 1000;
  if (trade.dir > 0) {
    const lows = swings.lows.filter(s => s.time > opened && s.price > trade.entry);
    return lows.length ? lows[lows.length - 1].price - pad : null;
  }
  const highs = swings.highs.filter(s => s.time > opened && s.price < trade.entry);
  return highs.length ? highs[highs.length - 1].price + pad : null;
}
