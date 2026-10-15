# Blue Trading Gold Desk

A gold (XAU/USD) position bot that runs entirely in your browser. You ask for a position and it reads the live gold chart, then replies with a trade ticket. There is no server, no account and no API cost.

## What it does

- **Set up once.** On the first visit it asks for your account balance, your lot size (0.03 by default) and the most you are willing to risk per trade. These are saved in your browser.
- **Ask anything about gold trading.** It only gives you a trade when you ask for one (“give me a position”, “15m”, “scalp”, “4h swing”). Otherwise it answers questions: the gold price, what gold is doing on a timeframe, why it made the last call, upcoming news, and trading basics (FVG, CHoCH, lot sizes, stops, take profit, sessions, what moves gold, and more). It is rules-based, not a general chatbot, so it only understands trading questions.
- **Auto-scanner.** Every minute it checks gold on the 5m, 15m, 1h and 4h charts. When a setup passes every rule (no news nearby, risk within your max), it posts the ticket in the chat and plays a sound. It never posts the same setup twice, and it never alerts on demo prices.

- **Position on request.** Pick a timeframe, or type “15m”, “scalp” or “4h swing”. The ticket shows:
  - direction and a **Take it / Wait / Skip** verdict
  - entry, stop loss, take profit 1 (1R) and take profit 2 (nearest opposing liquidity, at least 2R away), each as a price and as a dollar distance from entry
  - your **lot size** (fixed, 0.03 by default, or sized from a risk %), the dollar risk if stopped and what that is as a % of your balance. If a fixed lot would risk more than your max, the ticket says to skip it
  - what to wait for before entering, and every check behind the call
  - how the same rules performed on gold over the recent history (win rate, average R)
- **News and risk warnings.** High-impact USD events (NFP, CPI, FOMC and others) from the public Forex Factory calendar feed. The bot won't say “Take it” within 60 minutes of high-impact news, and it warns you 30 minutes before a release. It also flags the weekend close, Friday afternoon, the daily rollover and sudden volatility spikes.
- **Position tracking.** Press “I took it”. Open positions are checked against live 1-minute prices and closed automatically when they hit the stop or the final target. You can also close them manually. Your record (win rate, net P&L, average R) builds up from these.
- **Your rules.** Balance, risk per trade, daily loss limit and max trades per day. The bot checks each new position against them.

## How the calls are made

The engine is in `assets/js/analysis.js`. It looks for:

1. an unfilled **fair value gap** on the higher timeframe (1h for 5m/15m charts, 4h for 1h charts, and so on)
2. a **change of character** (CHoCH) on the lower timeframe after price taps that gap
3. a **trigger candle** (engulfing, hammer or shooting star) in the same direction

This is combined with structure, EMA 20/50, RSI and ATR. If the workflow isn't active, it falls back to a trend-pullback rule. No rule set wins every trade. The ticket shows the recent record so you can judge it with numbers.

## Price data

Gold prices come from Binance's **PAXG/USDT** market. One PAXG token is backed by one fine troy ounce of gold, so it tracks spot XAU/USD closely, but your broker's quote can differ by a few dollars. Place orders using the **dollar distances** on the ticket, measured from your broker's entry price. If Binance is unreachable on your network, the bot uses clearly labelled demo prices.

## Run it

It is a static site. Serve the folder with any web server:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

To publish it, enable GitHub Pages for this repository: Settings → Pages → deploy from the branch root.

## Files

| Path | Purpose |
| --- | --- |
| `index.html` | Page layout |
| `assets/css/styles.css` | Design (dark and light themes) |
| `assets/js/app.js` | Conversation, tickets, positions, account |
| `assets/js/bot.js` | Works out what you're asking and builds position tickets |
| `assets/js/knowledge.js` | Answers to common gold-trading questions |
| `assets/js/analysis.js` | Structure, FVGs, patterns, workflow, trade plan, backtester |
| `assets/js/news.js` | Economic calendar and market-condition warnings |
| `assets/js/coach.js` | Rule checks, risk status and journal review |
| `assets/js/journal.js` | Position storage and stats (saved in your browser) |
| `assets/js/data.js` | Binance market data and the demo fallback |

## Disclaimer

Educational tool, not financial advice. It applies fixed rules to past and live prices. It cannot predict the market, and past results don't guarantee future results.
