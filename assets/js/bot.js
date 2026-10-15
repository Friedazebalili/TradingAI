// Position bot: reads a question, pulls the market, and returns a position ticket
// or a coaching answer. Everything is computed in the browser from public prices.

import { analyze, backtest, HTF_FOR, fmt } from './analysis.js';
import { fetchCandles, aggregate, intervalSeconds } from './data.js';
import { ask } from './coach.js';
import { conditions } from './news.js';
import { findTopic } from './knowledge.js';

export const GOLD = 'PAXGUSDT';

const TF_WORDS = [
  [/\b(1\s?m|1\s?min(ute)?)\b/i, '1m'], [/\b(5\s?m|5\s?min(ute)?s?)\b/i, '5m'], [/\b(15\s?m|15\s?min(ute)?s?)\b/i, '15m'],
  [/\b(1\s?h|1\s?hr|1\s?hour|hourly)\b/i, '1h'], [/\b(4\s?h|4\s?hr|4\s?hours?)\b/i, '4h'], [/\b(1\s?d|daily|1\s?day)\b/i, '1d'],
  [/\bscalp/i, '5m'], [/\bday\s?trade/i, '15m'], [/\bintraday/i, '15m'], [/\bswing/i, '4h'],
];

// Decide what the message is asking for. A trade ticket is only produced when the
// message clearly asks for one; everything else gets an answer instead.
export function parse(text) {
  let tf = null;
  for (const [re, v] of TF_WORDS) if (re.test(text)) { tf = v; break; }
  const q = text.toLowerCase().trim();
  const words = q.split(/\s+/).filter(Boolean);
  const topic = findTopic(q);
  const question = /^(what|whats|what's|explain|define|meaning|how|why is|why does|is it|can you explain|tell me about)\b/.test(q);

  const asksTrade = /\b(position|signal|trade (idea|now|setup)|give me (a |an )?(trade|entry|setup)|any (trade|setup|entry)|should i (buy|sell|long|short|enter|take|go)|buy or sell|long or short|go long|go short|entry now|setup now|get position)\b/.test(q)
    || (tf && words.length <= 4 && !question);

  let intent;
  if (!q || /^(help|hi|hello|hey|yo|start|what can you do|what do you do)\b/.test(q)) intent = 'help';
  else if (/journal|my (trades|stats|results|record)|review my|how am i doing/.test(q)) intent = 'review';
  else if (/\bnews\b|calendar|economic|event|fomc|nfp|payroll|\bcpi\b|\bpce\b|\bfed\b|powell|inflation report/.test(q)) intent = 'news';
  else if (/(within my|my (limit|risk|rules)|daily loss|today'?s? (risk|loss|limit)|can i (still )?trade)/.test(q)) intent = 'risk';
  else if (/invalid|what if .*wrong|when .*(exit|wrong)|cancel the (trade|setup)/.test(q)) intent = 'invalid';
  else if (/^why\b.*\b(short|long|wait|skip|no trade|this|that|it|sell|buy)\b|explain (the|this|that) (ticket|trade|position|call)/.test(q)) intent = 'why';
  else if (question && topic && !asksTrade) intent = 'topic';
  else if (asksTrade) intent = 'position';
  else if (/\b(price|how much is gold|gold at|current gold|gold now|quote)\b/.test(q)) intent = 'price';
  else if (/\b(trend|bias|bullish|bearish|direction|outlook|analy[sz]e|analysis|market|doing|going up|going down|forecast|predict)\b/.test(q)) intent = 'market';
  else if (topic) intent = 'topic';
  else intent = 'unknown';
  return { tf, intent, topic };
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
  const perUnit = p.dir ? Math.abs(p.entry - p.stop) : 0;
  // Gold: 1 lot = 100 oz, so every $1 move is $100 per lot.
  const fixed = settings.sizing !== 'risk';
  const qty = fixed ? settings.lots * 100 : (perUnit ? (settings.balance * settings.riskPct / 100) / perUnit : 0);
  const riskAmt = perUnit * qty;
  const riskPctOfBalance = settings.balance > 0 ? riskAmt / settings.balance * 100 : null;
  if (p.dir && fixed && riskPctOfBalance != null && riskPctOfBalance > settings.riskPct) {
    warnings.push({ tone: 'bad', block: true, text: `At ${settings.lots} lots this stop risks ${moneyStr(riskAmt)}, which is ${riskPctOfBalance.toFixed(1)}% of your balance and above your ${settings.riskPct}% max. Skip it, or wait for a setup with a tighter stop.` });
  }
  const tp1 = p.dir ? p.entry + p.dir * perUnit : null;
  if (verdict === 'go' && warnings.some(w => w.block)) verdict = 'wait';

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
    stopDist: perUnit, lots: qty / 100, fixed, riskPctOfBalance,
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
    { tone: 'info', text: 'Ask for a trade and I give you a gold position ticket: “give me a position”, “15m”, “scalp”, “4h swing”, or press Get position.' },
    { tone: 'info', text: 'Ask about the market without a trade: “what’s the gold price?”, “is gold bullish on the 1h?”, “what news is coming?”' },
    { tone: 'info', text: 'Ask about the last ticket: “why short?”, “what invalidates it?”' },
    { tone: 'info', text: 'Ask trading questions: “what is an FVG?”, “how do lot sizes work?”, “where should my stop go?”, “best time to trade gold?”, “what moves gold?”' },
    { tone: 'info', text: 'Ask about you: “am I within my risk today?”, “review my trades”.' },
  ],
};

export const UNKNOWN = {
  title: 'I didn’t catch that',
  lines: [
    { tone: 'info', text: 'I’m a rules-based gold assistant, not a general chatbot, so I only understand trading questions.' },
    { tone: 'info', text: 'Try “give me a position”, “what’s gold doing on the 4h?”, “what news is coming?”, “what is a CHoCH?” or “how many lots should I use?”' },
  ],
};

function moneyStr(v) { return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
