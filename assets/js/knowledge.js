// Answers to common gold-trading questions. Each topic lists the phrases that
// point to it; the best-scoring topic wins. Written for XAU/USD specifically.

const T = (id, title, keys, lines) => ({ id, title, keys, lines: lines.map(text => ({ tone: 'info', text })) });

export const TOPICS = [
  T('fvg', 'Fair value gap (FVG)', ['fvg', 'fair value', 'imbalance', 'gap'], [
    'An FVG is a three-candle pattern where the middle candle moves so fast that the wicks of candles 1 and 3 don’t overlap. The space between them is the gap.',
    'Price often comes back to fill part of that gap before continuing, because orders were left unfilled there.',
    'On gold, mark FVGs on the 1H chart as points of interest. Don’t trade the gap by itself; wait for a lower-timeframe CHoCH when price returns to it.',
  ]),
  T('choch', 'Change of character (CHoCH)', ['choch', 'change of character', 'character'], [
    'A CHoCH is the first break of structure against the current trend. In a downtrend, it is the first candle close above the last lower high.',
    'It tells you order flow may be turning. It is the confirmation step after price taps a higher-timeframe zone.',
    'Enter on the pullback after the CHoCH, not on the breakout candle itself. Your stop goes beyond the zone.',
  ]),
  T('bos', 'Break of structure (BOS)', ['bos', 'break of structure', 'structure', 'higher high', 'lower low'], [
    'A BOS is a candle close beyond the last swing high (in an uptrend) or swing low (in a downtrend). It means the trend is continuing.',
    'A BOS in your direction keeps the idea alive. A break against your direction is a CHoCH and is a warning.',
  ]),
  T('ob', 'Order block', ['order block', 'ob ', 'mitigation', 'retest'], [
    'An order block is the last opposite-colour candle before a strong move that breaks structure. For a bullish move, it is the last bearish candle before the rally.',
    'Price often returns to it (a “mitigation” or retest) before continuing. Look for a hammer or engulfing candle there as your trigger.',
  ]),
  T('liquidity', 'Liquidity and stop hunts', ['liquidity', 'sweep', 'stop hunt', 'fakeout', 'trap', 'bsl', 'ssl'], [
    'Liquidity is where many stop losses sit: just above obvious highs (buy-side) and just below obvious lows (sell-side).',
    'Gold often spikes through those levels to fill big orders, then reverses. That is a sweep or stop hunt.',
    'Avoid putting your stop exactly at an obvious high or low. Put it beyond the structure with some room, which is what the tickets do.',
  ]),
  T('lots', 'Lot size for gold', ['lot', 'lots', 'ounce', 'oz', 'contract', 'position size', 'how big', 'how much should i buy'], [
    'For XAU/USD at most brokers, 1 standard lot = 100 ounces, 0.1 lot = 10 oz and 0.01 lot = 1 oz.',
    'With 1 lot, every $1 move in gold is $100 profit or loss. With 0.01 lot, it is $1.',
    'Size = money you are willing to lose ÷ (stop distance in $ × 100). For example, risking $100 with an $8 stop: 100 ÷ (8 × 100) = 0.125 lot.',
    'Your tickets use the fixed lot size from your Account card (0.03 by default) and show exactly what it risks. If that is more than your max risk %, the ticket tells you to skip it.',
  ]),
  T('pips', 'Pips and points on gold', ['pip', 'pips', 'point', 'points', 'tick'], [
    'Brokers count gold differently. Most quote two decimals, so a $1 move is 100 points, and many call $0.10 one pip (so $1 = 10 pips).',
    'Because this varies, the tickets show distances in plain dollars, for example “−$8.20” to the stop. Use that against your broker’s price.',
  ]),
  T('risk', 'How much to risk', ['how much to risk', 'risk per trade', 'risk management', 'money management', 'blow', 'account size', 'percent'], [
    'Most professional traders risk 0.5–1% of the account per trade, and stop for the day after losing 2–3%.',
    'At 1% risk, 10 losses in a row costs about 10%. At 5% risk, the same streak costs about 40%, which is very hard to recover from.',
    'Set your numbers in the Account card. The bot sizes every ticket from them and warns you when you hit your daily limit.',
  ]),
  T('rr', 'Reward to risk and R', ['r:r', 'rr', 'reward', 'risk reward', 'r multiple', '2r', '1r', 'expectancy'], [
    '1R is the amount you lose if your stop is hit. A 2R target makes twice that if it is reached.',
    'At 2R, you only need to win more than 1 in 3 trades to make money over time, before fees. That is why the bot looks for at least 2R.',
  ]),
  T('stop', 'Where to put the stop loss', ['stop loss', 'sl', 'where.*stop', 'stop placement', 'stopped out'], [
    'Put the stop where the idea is proven wrong: beyond the higher-timeframe FVG, or beyond the last swing that created the setup.',
    'Gold is volatile, so a stop smaller than about half the ATR usually gets hit by normal noise. The bot flags stops that tight.',
    'If the correct stop makes the position too big, reduce the lot size. Don’t tighten the stop.',
  ]),
  T('tp', 'Taking profit', ['take profit', 'tp', 'target', 'partial', 'break even', 'breakeven', 'trail', 'trailing'], [
    'The tickets give two targets. TP1 is at 1R. Close about half there and move the stop to your entry price, so the rest of the trade can’t lose.',
    'TP2 is the nearest opposing liquidity (a swing high for longs, a swing low for shorts) at least 2R away.',
    'If gold stalls at an opposite FVG before TP2, it is fine to take more off there.',
  ]),
  T('sessions', 'Best times to trade gold', ['session', 'what time', 'best time', 'when to trade', 'london', 'new york', 'asian', 'asia', 'hours'], [
    'Gold moves most during the London session (3–11 am New York time) and the New York session (8 am–12 pm). The overlap, 8–11 am New York, is usually the most active.',
    'The Asian session is quieter and tends to range. Breakouts there often fail.',
    'Spreads widen around the daily close (5–6 pm New York), and the market is closed from Friday 5 pm to Sunday 6 pm New York.',
  ]),
  T('drivers', 'What moves gold', ['what moves', 'why is gold', 'why gold', 'drive', 'affect', 'dollar', 'dxy', 'yield', 'interest rate', 'war', 'geopolit', 'safe haven'], [
    'Gold usually falls when the US dollar and US interest rates (Treasury yields) rise, and rises when they fall.',
    'The biggest scheduled movers are US inflation (CPI, PCE), jobs (NFP), and Federal Reserve decisions and speeches.',
    'Unscheduled movers include wars, political shocks and banking stress, when investors buy gold as a safe haven. Central-bank buying also supports it over the long run.',
    'Ask “what news is coming?” to see this week’s scheduled events.',
  ]),
  T('spread', 'Spread, leverage and fees', ['spread', 'leverage', 'margin', 'swap', 'commission', 'fee'], [
    'The spread is the gap between the buy and sell price. On gold it is usually $0.10–$0.50, and wider during news and rollover.',
    'Leverage lets you open bigger positions with less margin. It doesn’t change how much you lose per dollar of movement; your lot size does.',
    'Holding overnight usually costs a swap fee. Check your broker’s rates if you hold swing trades for days.',
  ]),
  T('psychology', 'Trading psychology', ['revenge', 'fomo', 'emotion', 'scared', 'fear', 'greed', 'discipline', 'overtrad', 'lost', 'losing', 'tilt'], [
    'After a loss, the urge to win it back straight away (revenge trading) is the fastest way to lose more. Step away for at least 30 minutes.',
    'Set a daily loss limit and a maximum number of trades in the Account card, and stop when either is hit.',
    'Only take tickets marked “Take it”. Your record will show whether skipping “Wait” tickets helps you.',
  ]),
  T('paxg', 'Why the price can differ from my broker', ['paxg', 'different', 'broker price', 'not the same', 'wrong price', 'price differ', 'mt4', 'mt5', 'metatrader'], [
    'The bot reads gold from Binance’s PAXG token, where one token is one troy ounce of gold. It follows spot gold closely but can be a few dollars off your broker.',
    'Use the dollar distances on the ticket. If the ticket says the stop is $8.20 above entry, put it $8.20 above the price you actually got.',
  ]),
  T('winrate', 'Win rate and accuracy', ['win rate', 'winrate', 'accurate', 'accuracy', 'guarantee', 'profitable', 'does it work', 'reliable'], [
    'No bot wins every trade, and anyone promising a fixed high win rate is not being honest with you.',
    'Each ticket shows how the same rules did on recent gold history. Your Record card tracks the positions you actually took.',
    'Making money comes from small losses, bigger wins (2R or more), and skipping bad conditions like news, not from being right every time.',
  ]),
  T('howbot', 'How the bot decides', ['how do you', 'how does', 'how it works', 'how you work', 'strategy', 'method', 'logic', 'decide'], [
    'Step 1: find an unfilled fair value gap on the higher timeframe (1H for 5m and 15m charts).',
    'Step 2: wait for price to tap it and for a change of character on the lower timeframe in the same direction.',
    'Step 3: wait for a trigger candle (engulfing, hammer or shooting star), then place the stop beyond the zone and target liquidity at least 2R away.',
    'It also checks trend (structure and EMAs), momentum (RSI), volatility (ATR), your daily limits and upcoming news before saying “Take it”.',
  ]),
  T('demo', 'What “demo prices” means', ['demo'], [
    'Demo prices appear only when your network can’t reach the live price feed. They are generated, so don’t trade them.',
    'On a normal connection the status at the top shows “Live prices” in green.',
  ]),
  T('rsi', 'RSI, EMA and ATR', ['rsi', 'ema', 'moving average', 'atr', 'indicator', 'overbought', 'oversold'], [
    'EMA 20 and 50 show the trend: price above both, with the 20 above the 50, is an uptrend.',
    'RSI measures momentum. Above 55 favours buyers, below 45 favours sellers, and above 75 or below 25 means the move is stretched.',
    'ATR is the average candle range. The bot uses it to judge whether a stop is too tight and whether a candle is unusually large.',
  ]),
];

export function findTopic(text) {
  const q = ` ${text.toLowerCase()} `;
  let best = null, bestScore = 0;
  for (const t of TOPICS) {
    let score = 0;
    for (const k of t.keys) {
      const re = new RegExp(k.includes('.*') ? k : `\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
      if (re.test(q)) score += k.length > 4 ? 2 : 1;
    }
    if (score > bestScore) { best = t; bestScore = score; }
  }
  return best;
}
