// Trade Coach: a rule engine that turns the chart read, your risk settings and
// your journal into plain-language answers. Runs entirely in the browser.

import { fmt, pct } from './analysis.js';
import { stats, todayTrades, tradeResult } from './journal.js';

export const QUICK_ASKS = [
  { id: 'plan', label: 'Where do I enter, stop and take profit?' },
  { id: 'take', label: 'Should I take this trade?' },
  { id: 'setup', label: 'Explain the current setup' },
  { id: 'invalid', label: 'What invalidates it?' },
  { id: 'risk', label: 'Am I within my risk rules today?' },
  { id: 'review', label: 'Review my journal' },
  { id: 'backtest', label: 'How has this strategy performed?' },
];

const INTENTS = [
  { id: 'plan', words: ['tp', 'take profit', 'target', 'sl', 'stop loss', 'where', 'position', 'how much', 'entry price', 'plan'] },
  { id: 'backtest', words: ['backtest', 'bot', 'strategy', 'win rate', 'winrate', 'perform', 'history', 'tested'] },
  { id: 'take', words: ['take', 'enter', 'buy', 'sell', 'long', 'short', 'should i', 'go in', 'entry'] },
  { id: 'invalid', words: ['invalid', 'wrong', 'stop', 'fail', 'exit'] },
  { id: 'risk', words: ['risk', 'today', 'limit', 'overtrad', 'loss', 'size', 'lot'] },
  { id: 'review', words: ['journal', 'review', 'stats', 'win rate', 'performance', 'mistake', 'improve', 'best setup'] },
  { id: 'setup', words: ['setup', 'explain', 'structure', 'fvg', 'choch', 'bias', 'trend', 'chart', 'pattern', 'market'] },
];

export function ask(id, ctx) {
  if (!ctx.analysis) return msg('Chart not loaded', [line('info', 'Load a market first. The coach reads the chart you have open.')]);
  switch (id) {
    case 'plan': return tradePlan(ctx);
    case 'backtest': return backtestSummary(ctx);
    case 'take': return shouldTake(ctx);
    case 'setup': return explainSetup(ctx);
    case 'invalid': return invalidation(ctx);
    case 'risk': return riskStatus(ctx);
    case 'review': return reviewJournal(ctx);
    default: return msg('Not sure what you mean', [line('info', 'I can answer questions about the open chart, your risk for today and your journal. Try one of the buttons below.')]);
  }
}

export function answerText(text, ctx) {
  const q = text.toLowerCase();
  let best = null, bestScore = 0;
  for (const intent of INTENTS) {
    const s = intent.words.reduce((a, w) => a + (q.includes(w) ? 1 : 0), 0);
    if (s > bestScore) { best = intent.id; bestScore = s; }
  }
  return ask(best, ctx);
}

const line = (tone, text) => ({ tone, text });
const msg = (title, lines, verdict = null) => ({ title, lines, verdict });
const side = d => d > 0 ? 'long' : d < 0 ? 'short' : 'flat';

function explainSetup({ analysis: a, symbol, tf }) {
  const lines = [];
  const biasWord = a.bias > 0 ? 'bullish' : a.bias < 0 ? 'bearish' : 'mixed';
  lines.push(line('info', `${symbol} on the ${tf} chart reads ${biasWord} (score ${a.score > 0 ? '+' : ''}${a.score} of ±6).`));
  for (const r of a.reasons) lines.push(line(r.dir > 0 ? 'good' : r.dir < 0 ? 'bad' : 'info', r.text));
  if (a.fvgs.length) {
    const g = a.fvgs[a.fvgs.length - 1];
    lines.push(line('info', `Most recent open ${g.dir > 0 ? 'bullish' : 'bearish'} FVG on this timeframe: ${fmt(g.bottom)} – ${fmt(g.top)}${g.tapped ? ' (already tapped once)' : ''}.`));
  }
  if (a.workflow) lines.push(line(a.workflow.step >= 2 ? 'good' : 'warn', `Precision workflow: ${a.workflow.status}.`));
  return msg('Current setup', lines);
}

function shouldTake(ctx) {
  const { analysis: a, risk } = ctx;
  const checks = [];
  const plan = a.plan;
  const wf = a.workflow;
  const planDir = risk && risk.entry && risk.stop ? Math.sign(risk.entry - risk.stop) : plan.dir;

  if (planDir === 0) return msg('Stand aside', [line('warn', plan.note || 'No direction. Signals are mixed.')], 'skip');

  checks.push(planDir === a.bias
    ? line('good', `Trade direction (${side(planDir)}) agrees with the chart bias.`)
    : a.bias === 0 ? line('warn', 'Chart bias is mixed. Treat this as a lower-quality trade.')
      : line('bad', `You'd be trading ${side(planDir)} against a ${a.bias > 0 ? 'bullish' : 'bearish'} bias.`));

  if (wf) {
    if (wf.failing) checks.push(line('bad', 'The higher-timeframe zone is failing. Structure broke against it.'));
    else if (wf.step === 3 && wf.zone.dir === planDir) checks.push(line('good', 'All three workflow steps are complete: POI tap, CHoCH, trigger candle.'));
    else if (wf.step === 2 && wf.zone.dir === planDir) checks.push(line('warn', 'POI tapped and structure shifted. You still need the trigger candle on the pullback.'));
    else if (wf.step === 1) checks.push(line('warn', 'Price is in the higher-timeframe zone but no CHoCH yet. Entering now is a blind limit order.'));
    else checks.push(line('bad', 'Price is not at a higher-timeframe POI. The workflow says wait.'));
  }

  const rr = risk && risk.rr != null ? risk.rr : plan.rr;
  if (rr != null) checks.push(rr >= 2 ? line('good', `Reward to risk is ${rr.toFixed(1)}R.`) : line('bad', `Reward to risk is only ${rr.toFixed(1)}R. Aim for 2R or better.`));

  const stopDist = risk && risk.entry && risk.stop ? Math.abs(risk.entry - risk.stop) : Math.abs(plan.entry - plan.stop);
  if (stopDist < a.atr * 0.5) checks.push(line('bad', `Stop is ${(stopDist / a.atr).toFixed(2)}× ATR, inside normal noise. It will likely get wicked.`));
  else checks.push(line('good', `Stop distance is ${(stopDist / a.atr).toFixed(1)}× ATR, outside normal noise.`));

  if (a.rsi != null && ((planDir > 0 && a.rsi > 75) || (planDir < 0 && a.rsi < 25))) {
    checks.push(line('warn', `RSI is ${a.rsi.toFixed(0)}. You'd be chasing an extended move.`));
  }

  for (const r of ruleBreaches(ctx)) checks.push(r);

  const bad = checks.filter(c => c.tone === 'bad').length;
  const warn = checks.filter(c => c.tone === 'warn').length;
  const verdict = bad ? 'skip' : warn ? 'wait' : 'go';
  const title = verdict === 'go' ? 'Meets your rules' : verdict === 'wait' ? 'Not yet. Wait for confirmation' : 'Skip this one';
  checks.push(line('info', 'This is a rules check, not financial advice. You make the final call.'));
  return msg(title, checks, verdict);
}

function tradePlan({ analysis: a, settings, symbol }) {
  const p = a.plan;
  if (!p.dir) return msg('No trade right now', [line('warn', p.note), line('info', 'I will have levels as soon as structure and momentum agree on a side.')], 'skip');
  const riskAmt = settings.balance * settings.riskPct / 100;
  const perUnit = Math.abs(p.entry - p.stop);
  const qty = perUnit ? riskAmt / perUnit : 0;
  const lines = [
    line('info', `Idea: ${side(p.dir).toUpperCase()} ${symbol}.`),
    line('info', `Entry: ${fmt(p.entry)} (current price). Better fills come on a pullback toward ${p.nearFvg ? `the FVG at ${fmt(p.nearFvg.bottom)} – ${fmt(p.nearFvg.top)}` : 'the last broken level'}.`),
    line('bad', `Stop loss: ${fmt(p.stop)}, ${p.stopReason}.`),
    line('good', `Take profit: ${fmt(p.target)}, ${p.targetReason} (${p.rr.toFixed(1)}R).`),
    line('good', `TP1 at 1R: ${fmt(p.entry + p.dir * perUnit)}. Take partials there and move the stop to break-even.`),
    line('info', `Size for ${settings.riskPct}% risk (${money(riskAmt)}): ${qty.toLocaleString('en-US', { maximumFractionDigits: qty < 1 ? 6 : 3 })} units, about ${money(qty * p.entry)} notional, before fees.`),
  ];
  if (p.tooTight) lines.push(line('warn', 'The stop sits inside normal volatility. Widen it and size down rather than tightening it.'));
  if (p.rr < 2) lines.push(line('warn', `Only ${p.rr.toFixed(1)}R to the nearest liquidity. Consider waiting for a better entry.`));
  if (a.workflow && a.workflow.step < 3) lines.push(line('warn', `The precision workflow is not complete yet (${a.workflow.status.toLowerCase()}).`));
  lines.push(line('info', 'Levels are calculated from the chart, not a prediction. You make the final call.'));
  return msg('Trade plan', lines, a.workflow && a.workflow.step === 3 && p.rr >= 2 ? 'go' : 'wait');
}

function backtestSummary({ backtest: b }) {
  if (!b) return msg('No backtest yet', [line('info', 'Open the Strategy tester panel and press Run. It replays the strategy over the loaded candles.')]);
  if (!b.n) return msg(`${b.strategy}: no trades`, [line('info', 'The strategy found no qualifying setups in the loaded history. Try a lower timeframe for more candles, or the trend pullback strategy.')]);
  const lines = [
    line(b.winRate >= 0.5 ? 'good' : 'warn', `${b.n} trades, ${pct(b.winRate)} win rate.`),
    line(b.avgR > 0 ? 'good' : 'bad', `Average ${b.avgR.toFixed(2)}R per trade, ${b.totalR.toFixed(1)}R in total, worst drawdown ${b.maxDrawdownR.toFixed(1)}R.`),
  ];
  if (b.n < 30) lines.push(line('warn', `${b.n} trades is a small sample. Treat this as a hint, not proof.`));
  if (b.winRate < 0.5 && b.avgR > 0) lines.push(line('info', 'A win rate under 50% can still make money when winners are bigger than losers.'));
  lines.push(line('info', 'Past results on one market and timeframe do not guarantee future results.'));
  return msg('Strategy test', lines);
}

function invalidation({ analysis: a }) {
  const p = a.plan;
  if (!p.dir) return msg('Nothing to invalidate', [line('info', 'There is no active idea on this chart. Wait for structure to pick a side.')]);
  const lines = [
    line('bad', `Hard invalidation: a close ${p.dir > 0 ? 'below' : 'above'} ${fmt(p.stop)} (${p.stopReason}).`),
  ];
  if (a.workflow && a.workflow.zone && a.workflow.zone.dir === p.dir) {
    const z = a.workflow.zone;
    lines.push(line('warn', `A full body close ${p.dir > 0 ? 'below' : 'above'} the HTF FVG edge at ${fmt(p.dir > 0 ? z.bottom : z.top)} means the zone failed.`));
  }
  const opp = a.structure.events.filter(e => e.dir === -p.dir).pop();
  if (opp) lines.push(line('warn', `A ${p.dir > 0 ? 'bearish' : 'bullish'} CHoCH through ${fmt(opp.level)} flips the order flow against you.`));
  lines.push(line('info', `Target: ${fmt(p.target)} (${p.targetReason}). Take partials if price stalls at an opposing FVG first.`));
  return msg('What invalidates the idea', lines);
}

function ruleBreaches({ trades, settings }) {
  const out = [];
  const today = todayTrades(trades);
  const closed = today.map(t => ({ t, r: tradeResult(t) })).filter(x => !x.r.open);
  const pnl = closed.reduce((a, x) => a + x.r.pnl, 0);
  const limit = settings.balance * settings.dailyLossPct / 100;
  if (pnl <= -limit) out.push(line('bad', `Daily loss limit hit (${money(pnl)} vs −${money(limit)}). Stop trading for today.`));
  if (today.length >= settings.maxTrades) out.push(line('bad', `${today.length} trades today. Your limit is ${settings.maxTrades}.`));
  const lastLoss = closed.filter(x => !x.r.win).sort((a, b) => new Date(b.t.date) - new Date(a.t.date))[0];
  if (lastLoss && Date.now() - new Date(lastLoss.t.date).getTime() < 30 * 60000) {
    out.push(line('warn', 'You took a loss less than 30 minutes ago. Make sure this is not a revenge trade.'));
  }
  return out;
}

function riskStatus(ctx) {
  const { trades, settings, risk } = ctx;
  const today = todayTrades(trades);
  const closed = today.map(t => tradeResult(t)).filter(r => !r.open);
  const pnl = closed.reduce((a, r) => a + r.pnl, 0);
  const limit = settings.balance * settings.dailyLossPct / 100;
  const lines = [
    line(pnl >= 0 ? 'good' : pnl > -limit ? 'warn' : 'bad', `Today's P&L: ${money(pnl)} of a −${money(limit)} daily loss limit.`),
    line(today.length < settings.maxTrades ? 'good' : 'bad', `Trades today: ${today.length} of ${settings.maxTrades}.`),
  ];
  if (risk && risk.riskAmount) {
    lines.push(line(settings.riskPct <= 2 ? 'good' : 'bad', `Planned risk per trade: ${money(risk.riskAmount)} (${settings.riskPct}% of the account).`));
    if (pnl - risk.riskAmount < -limit) lines.push(line('warn', 'If this next trade loses, you will be past your daily limit.'));
  }
  if (settings.riskPct > 2) lines.push(line('bad', 'Risking more than 2% per trade makes a normal losing streak very expensive.'));
  lines.push(...ruleBreaches(ctx).filter(l => l.tone === 'warn'));
  return msg('Risk check for today', lines);
}

function reviewJournal({ trades }) {
  const s = stats(trades);
  if (!s.closed) return msg('Journal is empty', [line('info', 'Log a few closed trades in the Journal tab and I will look for patterns in your results.')]);
  const lines = [];
  lines.push(line(s.net >= 0 ? 'good' : 'bad', `${s.closed} closed trades, ${pct(s.winRate)} win rate, net ${money(s.net)}.`));
  if (s.avgR != null) lines.push(line(s.avgR > 0 ? 'good' : 'bad', `Average result ${s.avgR.toFixed(2)}R per trade. ${s.avgR > 0 ? 'You have a positive expectancy so far.' : 'Expectancy is negative. Focus on fewer, better setups.'}`));
  if (s.avgWin && s.avgLoss) {
    const ratio = s.avgWin / s.avgLoss;
    lines.push(line(ratio >= 1.5 ? 'good' : 'warn', `Average winner is ${ratio.toFixed(2)}× the average loser.${ratio < 1 ? ' You may be cutting winners early or moving stops.' : ''}`));
  }
  if (s.bySetup.length > 1) {
    const best = s.bySetup[0], worst = s.bySetup[s.bySetup.length - 1];
    lines.push(line('good', `Best setup: ${best.setup} (${(best.r / best.n).toFixed(2)}R avg over ${best.n}).`));
    if (worst.r < 0) lines.push(line('bad', `Weakest setup: ${worst.setup} (${(worst.r / worst.n).toFixed(2)}R avg over ${worst.n}). Consider dropping it.`));
  }
  if (s.long.n && s.short.n) {
    const better = s.long.pnl >= s.short.pnl ? 'longs' : 'shorts';
    lines.push(line('info', `Longs: ${s.long.n} trades, ${money(s.long.pnl)}. Shorts: ${s.short.n} trades, ${money(s.short.pnl)}. You do better on ${better}.`));
  }
  if (s.offPlan.length) {
    const offPnl = s.offPlan.reduce((a, x) => a + x.res.pnl, 0);
    lines.push(line('bad', `${s.offPlan.length} trade(s) marked off-plan, totalling ${money(offPnl)}.`));
  }
  if (s.streak >= 3) lines.push(line(s.streakType ? 'good' : 'warn', `Current streak: ${s.streak} ${s.streakType ? 'wins' : 'losses'}.${s.streakType ? '' : ' Consider cutting size until you log a winner.'}`));
  return msg('Journal review', lines);
}

export function money(v) {
  if (v == null || !isFinite(v)) return '–';
  const sign = v < 0 ? '−' : '';
  return `${sign}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
