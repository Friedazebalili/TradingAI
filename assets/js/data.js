// Market data: Binance public market-data endpoints (no account or key needed).
// If they can't be reached, a clearly labelled demo series is generated instead.

const REST = 'https://data-api.binance.vision/api/v3';
const WS = 'wss://data-stream.binance.vision/ws';

export const MARKETS = [
  { symbol: 'BTCUSDT', label: 'BTC / USDT' },
  { symbol: 'ETHUSDT', label: 'ETH / USDT' },
  { symbol: 'SOLUSDT', label: 'SOL / USDT' },
  { symbol: 'XRPUSDT', label: 'XRP / USDT' },
  { symbol: 'BNBUSDT', label: 'BNB / USDT' },
  { symbol: 'DOGEUSDT', label: 'DOGE / USDT' },
  { symbol: 'PAXGUSDT', label: 'Gold (PAXG / USDT)' },
  { symbol: 'EURUSDT', label: 'EUR / USDT' },
];

export const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'];

const SECONDS = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400, '1w': 604800 };

export async function fetchCandles(symbol, interval, limit = 500) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`${REST}/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      if (body && body.code === -1121) throw Object.assign(new Error(`${symbol} is not a Binance spot market`), { badSymbol: true });
      throw new Error(`Market data returned ${res.status}`);
    }
    const rows = await res.json();
    return { source: 'live', candles: rows.map(toCandle) };
  } catch (err) {
    if (err.badSymbol) throw err;
    return { source: 'demo', error: err.message, candles: demoCandles(symbol, interval, limit) };
  }
}

function toCandle(r) {
  return { time: Math.floor(r[0] / 1000), open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] };
}

// Live kline stream. onCandle receives (candle, isClosed). Returns a stop function.
export function streamCandles(symbol, interval, onCandle, onStatus) {
  let ws, closed = false, retry = 0, timer;
  const open = () => {
    ws = new WebSocket(`${WS}/${symbol.toLowerCase()}@kline_${interval}`);
    ws.onopen = () => { retry = 0; onStatus && onStatus('live'); };
    ws.onmessage = ev => {
      const k = JSON.parse(ev.data).k;
      if (!k) return;
      onCandle({ time: Math.floor(k.t / 1000), open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v }, k.x);
    };
    ws.onclose = () => {
      if (closed) return;
      onStatus && onStatus('reconnecting');
      timer = setTimeout(open, Math.min(30000, 1000 * 2 ** retry++));
    };
    ws.onerror = () => ws.close();
  };
  open();
  return () => { closed = true; clearTimeout(timer); ws && ws.close(); };
}

// Deterministic random walk with trending phases, so the tools have something
// realistic to work on when the live feed is blocked.
export function demoCandles(symbol, interval, limit = 500) {
  const step = SECONDS[interval] || 3600;
  let seed = [...symbol + interval].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 2147483647, 7) || 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const base = { BTCUSDT: 64000, ETHUSDT: 3200, SOLUSDT: 150, XRPUSDT: 0.6, BNBUSDT: 580, DOGEUSDT: 0.15, PAXGUSDT: 4000, EURUSDT: 1.08 }[symbol] || 100;
  const vol = Math.sqrt(step / 3600) * 0.006;
  const now = Math.floor(Date.now() / 1000 / step) * step;
  let price = base, drift = 0;
  const out = [];
  for (let i = 0; i < limit; i++) {
    if (i % 40 === 0) drift = (rand() - 0.5) * vol * 0.6;
    const open = price;
    const shock = rand() < 0.04 ? (rand() - 0.5) * vol * 8 : 0;
    const close = open * (1 + drift + (rand() - 0.5) * vol * 2 + shock);
    const high = Math.max(open, close) * (1 + rand() * vol * 0.8);
    const low = Math.min(open, close) * (1 - rand() * vol * 0.8);
    out.push({ time: now - (limit - 1 - i) * step, open, high, low, close, volume: 100 + rand() * 900 });
    price = close;
  }
  return out;
}

export function intervalSeconds(interval) { return SECONDS[interval] || 3600; }

// Rolls lower-timeframe candles up into a higher timeframe (used for demo data,
// so both timeframes describe the same price path).
export function aggregate(candles, interval) {
  const step = SECONDS[interval];
  const out = [];
  for (const c of candles) {
    const t = Math.floor(c.time / step) * step;
    const last = out[out.length - 1];
    if (last && last.time === t) {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
      last.volume += c.volume;
    } else out.push({ ...c, time: t });
  }
  return out;
}

// Latest prices for several symbols in one request. Returns {} when unreachable.
export async function fetchPrices(symbols) {
  if (!symbols.length) return {};
  try {
    const res = await fetch(`${REST}/ticker/price?symbols=${encodeURIComponent(JSON.stringify(symbols))}`);
    if (!res.ok) return {};
    const rows = await res.json();
    return Object.fromEntries(rows.map(r => [r.symbol, +r.price]));
  } catch { return {}; }
}

// One-minute candles from a start time, used to see whether a stop or target was hit.
export async function fetchMinuteCandlesSince(symbol, startMs) {
  try {
    const res = await fetch(`${REST}/klines?symbol=${encodeURIComponent(symbol)}&interval=1m&startTime=${startMs}&limit=1000`);
    if (!res.ok) return null;
    return (await res.json()).map(toCandle);
  } catch { return null; }
}

// 24-hour ticker: last price and change. Returns null when unreachable.
export async function fetchTicker(symbol) {
  try {
    const res = await fetch(`${REST}/ticker/24hr?symbol=${encodeURIComponent(symbol)}`);
    if (!res.ok) return null;
    const r = await res.json();
    return { price: +r.lastPrice, changePct: +r.priceChangePercent / 100 };
  } catch { return null; }
}
