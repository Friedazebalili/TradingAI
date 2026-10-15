// Position bot: reads a question, pulls the market, and returns a position ticket
// or a coaching answer. Everything is computed in the browser from public prices.

import { analyze, backtest, HTF_FOR, fmt } from './analysis.js';
import { fetchCandles, aggregate, intervalSeconds } from './data.js';
import { ask } from './coach.js';
import { conditions } from './news.js';

export const GOLD = 'PAXGUSDT';

const TF_WORDS = [
  [/\b(1\s?m|1\s?min(ute)?)\b/i, '1m'], [/\b(5\s?m|5\s?min(ute)?s?)\b/i, '5m'], [/\b(15\s?m|15\s?min(ute)?s?)\b/i, '15m'],
  [/\b(1\s?h|1\s?hr|1\s?hour|hourly)\b/i, '1h'], [/\b(4\s?h|4\s?hr|4\s?hours?)\b/i, '4h'], [/\b(1\s?d|daily|1\s?day)\b/i, '1d'],
  [/\bscalp/i, '5m'], [/\bday\s?trade/i, '15m'], [/\bintraday/i, '15m'], [/\bswing/i, '4h'],
];

export function parse(text) {
  let tf = null;
  for (const [re, v] of TF_WORDS) if (re.test(text)) { tf = v; break; }
  const q = text.toLowerCase();
  let intent = 'position';
  if (/journal|my (trades|stats|results)|review|how am i doing/.test(q)) intent = 'review';
  else if (/news|calendar|event|fomc|nfp|payroll|cpi|\bfed\b|powell|inflation/.test(q)) intent = 'news';
  else if (/(risk|limit|today|overtrad|how much can i)/.test(q)) intent = 'risk';
  else if (/invalid|what if.*wrong|when.*(exit|wrong)/.test(q)) intent = 'invalid';
  else if (/^(help|hi|hello|hey|what can you)/.test(q.trim())) intent = 'help';
  return { tf, intent };
}

// Cache the last read per market so follow-ups ("what invalidates it?") are instant.
const cache = new Map();

export async function readMarket(tf, symbol = GOLD) {
  const htfTf = HTF_FOR[tf];
  const [main, htfRes] = await Promise.all([fetchCandles(symbol, tf, 600), fetchCandles(symbol, htfTf, 500)]);
  const htf = main.source === 'demo' ? aggregate(main.candles, htfTf) : htfRes.candles;
  const analysis = analyze(main.candles, htf);
  if (!analysis) throw new Error(`Not enough price history for ${symbol} on ${tf}.`);
  const viaWorkflow = analysis.workflow && analysis.workflow.step >= 2 && analysis.plan.dir === analysis.workflow.zone.dir;
  const strategy = viaWorkflow ? 'workflow' : 'trend';
  const record = backtest(main.candles, htf, strategy, { htfStep: intervalSeconds(htfTf), minRR: 2 });
  const read = { symbol, tf, htfTf, analysis, record, strategy, source: main.source, at: Date.now() };
  cache.set(`${symbol}:${tf}`, read);
  return read;
}

export function cached(symbol, tf) { return cache.get(`${symbol}:${tf}`) || null; }

// Assemble the ticket the UI renders.
export function ticket(read, settings, trades, calendar) {
  const a = read.analysis;
  const p = a.plan;
  const ctx = { analysis: a, symbol: read.symbol, tf: read.tf, trades, settings, risk: null };
  const check = ask('take', ctx);
  const warnings = conditions(calendar, a);
  let verdict = p.dir ? check.verdict : 'skip';
  if (verdict === 'go' && warnings.some(w => w.block)) verdict = 'wait';
  const riskAmt = settings.balance * settings.riskPct / 100;
  const perUnit = p.dir ? Math.abs(p.entry - p.stop) : 0;
  const qty = perUnit ? riskAmt / perUnit : 0;
  const tp1 = p.dir ? p.entry + p.dir * perUnit : null;

  let waitingFor = null;
  if (!p.dir || verdict !== 'go') {
    const wf = a.workflow;
    if (wf && wf.zone && !wf.failing) {
      const z = wf.zone;
      waitingFor = wf.step === 0
        ? `price to reach the ${read.htfTf} ${z.dir > 0 ? 'bullish' : 'bearish'} zone at ${fmt(z.bottom)} – ${fmt(z.top)}, then a ${read.tf} CHoCH`
        : wf.step === 1 ? `a ${z.dir > 0 ? 'bullish' : 'bearish'} CHoCH on the ${read.tf} inside the zone`
          : `a ${z.dir > 0 ? 'bullish' : 'bearish'} trigger candle on the pullback`;
    }
  }

  return {
    symbol: read.symbol, tf: read.tf, htfTf: read.htfTf, source: read.source, at: read.at,
    price: a.price,
    dir: p.dir,
    verdict, warnings,
    stopDist: perUnit, lots: qty / 100,
    entry: p.entry, stop: p.stop, tp1, tp2: p.target, rr: p.rr,
    stopReason: p.stopReason, targetReason: p.targetReason,
    qty, notional: qty * (p.entry || 0), riskAmt, rewardAmt: p.dir ? riskAmt * p.rr : 0,
    confidence: a.confidence, bias: a.bias,
    checks: check.lines.filter(l => l.tone !== 'info'),
    reasons: a.reasons,
    workflow: a.workflow,
    waitingFor,
    note: p.note,
    record: read.record,
    strategyName: read.record.strategy,
    setup: read.strategy === 'workflow' ? '1H FVG + LTF CHoCH' : 'Trend pullback',
  };
}

export const HELP = {
  title: 'What I can do',
  lines: [
    { tone: 'info', text: 'I trade one market: gold. Ask for a position with a timeframe, e.g. “gold 15m”, “scalp”, “4h swing”, or just press Get position.' },
    { tone: 'info', text: 'You get the direction, entry, stop loss, two take-profit levels, and the size in ounces and lots for your risk, plus a Take / Wait / Skip verdict.' },
    { tone: 'info', text: 'I warn you about high-impact USD news (NFP, CPI, FOMC and others), the weekend close, rollover and sudden volatility, and hold back a “Take it” when news is close.' },
    { tone: 'info', text: 'Each ticket shows how the same rules performed on gold recently. Press “I took it” and I track the position against live prices.' },
    { tone: 'info', text: 'You can also ask “what news is coming?”, “what invalidates it?”, “am I within my risk today?” or “review my trades”.' },
  ],
};
