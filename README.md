# Blue Trading Gold Signals

A simple gold (XAU/USD) signal page that runs in your browser. There is no server, no account and no cost.

1. **Enter your balance first.** Also your lot size (0.03 by default) and the most you'll risk per trade. These stay in your browser.
2. **Wait for a signal.** Every minute the page checks gold on the 5m, 15m and 1h charts. It shows a signal only when one of three setups passes every check; otherwise it says "No signal right now" and why.
   - **Bounce:** price pulls back into a higher-timeframe gap in the direction of the main trend, turns, and prints a trigger candle.
   - **Reversal:** the same sequence against the main trend.
   - **Trend continuation:** the trend breaks structure, then *pulls back* to the 20 EMA or an open gap before a trigger candle. It never fires while price is running away.
3. **Follow the plan on the card:** entry, stop loss, TP1, TP2, your lot size, and the dollar risk and reward.
   - The stop sits just behind the latest swing on that chart, between 0.8 and 2.5 ATR. Setups that need a wider stop are skipped.
   - TP1 is 1× the stop distance. TP2 is the next swing high or low between 1.5× and 3× the stop distance, otherwise 2×.
4. **Press "I'm in"** and it coaches the trade: close half and move the stop to entry at TP1, then move the stop behind each new swing (it gives you the exact price), and close at TP2.

A signal is skipped when:
- high-impact USD news (NFP, CPI, FOMC and others) is less than an hour away
- the gold market is closed for the weekend
- your lot size would risk more than your max %
- the move is already stretched
- your daily loss or trade limit is reached
- the setup has been losing on that timeframe recently

Every live signal is followed to its outcome and listed under **Recent signals**, so you can see the real hit rate.

## Notes

- Gold prices come from Binance PAXG/USDT (one token = one troy ounce). It tracks spot gold within a few dollars. Use the dollar distances from your broker's entry price.
- Leave the page open for alerts (sound and browser notification).
- Educational tool, not financial advice. Signals follow fixed rules and can lose.

## Run it

Serve the folder with any static web server (`python3 -m http.server 8000`), or use GitHub Pages from the `main` branch root.

## Files

| Path | Purpose |
| --- | --- |
| `index.html`, `assets/css/styles.css` | The page |
| `assets/js/app.js` | Account setup, signal card, trade coaching, history |
| `assets/js/signals.js` | Signal rules (bounce, reversal, continuation) and trailing stops |
| `assets/js/analysis.js` | Structure, gaps, candle patterns, levels, backtest |
| `assets/js/news.js` | Economic calendar and market-hours warnings |
| `assets/js/data.js` | Binance price data |
| `assets/js/journal.js` | Saved settings |
