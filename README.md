# Blue Trading Gold Breakout

One gold (XAU/USD) rule, done properly, in your browser. There is no server, no account and no cost.

## Why this rule

Before building this, we looked for gold strategies with published, tested results:

- **London breakout on gold** ([study](https://www.mql5.com/en/blogs/post/777540)): 715 trades over 3.7 years on real tick data, about 49% winners, profit factor 1.38, max drawdown about 17%. On unseen 2026 data the profit factor was 1.61 (157 trades). Every rule is written down, so it can be copied exactly. This is the strongest public result we found.
- **Smart money concepts (SMC/ICT)**: when coded as fixed rules, independent tests land around 38–48% winners. One broad test of 648 variants found no edge over buy-and-hold ([StatOasis](https://statoasis.com/overfit/research/ict-backtest-what-survives)). High SMC win rates mostly come from sellers' own, untested claims.
- **Caution**: another tester found gold breakout edges small or missing on longer data ([mql5](https://www.mql5.com/en/blogs/post/777404)). That is why this app **re-tests the rule on the last 6 months of real gold prices every time you open it** and tells you plainly if it has stopped working.

## The rule

| Step | Rule |
| --- | --- |
| Range | High and low from 03:00 to 08:00 broker server time (Athens time). The app shows this in your local time. |
| Filter | Skip the day if the range is under 0.30% or over 1.60% of price |
| Orders | At 08:00, place a buy stop at the range high and a sell stop at the range low. When one fills, cancel the other. One trade per day. |
| Stop loss | The other side of the range, capped at 0.6% of price |
| Take profit | 2.5× the stop distance (2.5R) |
| Break-even | Move the stop to entry once price reaches 1.5R |
| Time exit | Close anything still open at 21:00 server time |

## What you see

1. **Your account first**: balance, lot size (0.03 by default) and max risk %.
2. **Today's plan**: "Building the range", then "Place these 2 orders" with exact entry, stop and target, then "BUY/SELL is live" with what to do next, or "No trade today" with the reason. If your lot size is too big for your balance, it tells you the lot size that fits.
3. **The rule's record on the last 6 months of gold**: trades, win %, profit factor, and the dollar result at your lot size. It shows a red warning if the rule is losing recently.
4. **The last 10 trading days**: what the rule did each day.

Sound and browser alerts fire when the orders are ready, when one fills, when to move the stop, and when the trade ends. Keep the page open.

## Notes

- Gold prices come from Binance PAXG/USDT, which tracks spot gold within a few dollars. Your broker's range can differ slightly.
- Back-tests on 15-minute candles assume the worst case when a candle touches both the stop and the target.
- Past results don't guarantee future results. Educational tool, not financial advice.

## Files

| Path | Purpose |
| --- | --- |
| `index.html`, `assets/css/styles.css` | The page |
| `assets/js/app.js` | Account setup, today's plan, record, alerts |
| `assets/js/london.js` | The breakout rule and its back-test |
| `assets/js/data.js` | Binance price data |
| `assets/js/news.js` | High-impact news warnings |
| `assets/js/analysis.js`, `assets/js/journal.js` | Formatting and saved settings |
