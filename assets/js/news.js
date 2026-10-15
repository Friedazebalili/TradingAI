// High-impact news and market-condition warnings for gold.
// Tries the public Forex Factory weekly calendar feed first. If the browser can't
// reach it, falls back to the release times that are fixed by rule.

const FEEDS = [
  'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
];

// FOMC rate decisions (second day of each meeting, 2:00 pm New York time).
const FOMC_2026 = ['2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17', '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09'];

export async function loadCalendar() {
  for (const url of FEEDS) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) continue;
      const rows = await res.json();
      const events = rows
        .filter(r => r.country === 'USD' && (r.impact === 'High' || r.impact === 'Medium'))
        .map(r => ({ title: r.title, time: new Date(r.date).getTime(), impact: r.impact === 'High' ? 'high' : 'medium', forecast: r.forecast, previous: r.previous }))
        .filter(e => isFinite(e.time))
        .sort((a, b) => a.time - b.time);
      return { source: 'live', events };
    } catch { /* try the next feed */ }
  }
  return { source: 'schedule', events: scheduledEvents(new Date()) };
}

// New York wall-clock time to a UTC timestamp (handles daylight saving).
function nyTime(y, m, d, hh, mm) {
  const guess = Date.UTC(y, m, d, hh + 5, mm);
  const offsetH = +new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(new Date(guess));
  return guess - (offsetH - hh) * 3600000;
}

function scheduledEvents(now) {
  const events = [];
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  for (const mo of [m, m + 1]) {
    const yy = y + Math.floor(mo / 12), mm = mo % 12;
    // Non-farm payrolls: first Friday of the month, 8:30 am New York.
    const first = new Date(Date.UTC(yy, mm, 1)).getUTCDay();
    const day = 1 + ((5 - first + 7) % 7);
    events.push({ title: 'Non-Farm Payrolls', time: nyTime(yy, mm, day, 8, 30), impact: 'high' });
  }
  for (const d of FOMC_2026) {
    const [yy, mm, dd] = d.split('-').map(Number);
    events.push({ title: 'FOMC rate decision', time: nyTime(yy, mm - 1, dd, 14, 0), impact: 'high' });
    events.push({ title: 'FOMC press conference', time: nyTime(yy, mm - 1, dd, 14, 30), impact: 'high' });
  }
  // Weekly jobless claims: Thursdays 8:30 am New York.
  for (let i = 0; i < 14; i++) {
    const d = new Date(now.getTime() + i * 86400000);
    if (d.getUTCDay() === 4) events.push({ title: 'Unemployment claims', time: nyTime(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 8, 30), impact: 'medium' });
  }
  return events.filter(e => e.time > now.getTime() - 86400000 && e.time < now.getTime() + 14 * 86400000).sort((a, b) => a.time - b.time);
}

export function upcoming(calendar, now = Date.now()) {
  return calendar.events.filter(e => e.time > now - 30 * 60000);
}

// Warnings that change how a gold position should be handled right now.
export function conditions(calendar, analysis, now = Date.now()) {
  const out = [];
  if (calendar) {
    for (const e of calendar.events) {
      const mins = (e.time - now) / 60000;
      if (e.impact === 'high' && mins > 0 && mins <= 60) {
        out.push({ tone: 'bad', block: true, text: `${e.title} in ${Math.round(mins)} min. Gold often spikes both ways on USD news. Don't open a new position until it is out.` });
      } else if (e.impact === 'high' && mins <= 0 && mins > -30) {
        out.push({ tone: 'warn', text: `${e.title} was released ${Math.round(-mins)} min ago. Spreads and wicks are still wide. Wait for the first 15-minute candle to close.` });
      } else if (e.impact === 'high' && mins > 60 && mins <= 240) {
        out.push({ tone: 'warn', text: `${e.title} in ${fmtIn(mins)}. Plan to be out or at break-even before then.` });
      } else if (e.impact === 'medium' && mins > 0 && mins <= 30) {
        out.push({ tone: 'warn', text: `${e.title} in ${Math.round(mins)} min. Expect a quick move.` });
      }
    }
  }
  const d = new Date(now);
  const ny = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(d);
  const wd = ny.find(p => p.type === 'weekday').value;
  const hr = +ny.find(p => p.type === 'hour').value;
  // Spot gold closes Friday 5 pm to Sunday 6 pm New York; PAXG keeps trading on thin volume.
  if ((wd === 'Fri' && hr >= 17) || wd === 'Sat' || (wd === 'Sun' && hr < 18)) {
    out.push({ tone: 'bad', block: true, text: 'The gold market is closed for the weekend. PAXG still trades, but on thin volume, and Monday can open with a gap. Wait for the Sunday open.' });
  } else if (wd === 'Fri' && hr >= 14) {
    out.push({ tone: 'warn', text: 'Late Friday. Liquidity is thinning before the weekend close, so avoid holding positions over the weekend.' });
  } else if (hr >= 17 && hr < 19) {
    out.push({ tone: 'warn', text: 'Daily rollover hour (5–7 pm New York). Spreads widen at many brokers.' });
  }
  if (analysis && analysis.atr) {
    const recentRange = analysis.recentRange;
    if (recentRange && recentRange > analysis.atr * 2.5) {
      out.push({ tone: 'warn', text: `The last candle moved ${(recentRange / analysis.atr).toFixed(1)}× the normal range. Something is moving gold. Check the headlines before entering.` });
    }
  }
  return out;
}

export function fmtIn(mins) {
  if (mins < 60) return `${Math.round(mins)} min`;
  const h = Math.floor(mins / 60), m = Math.round(mins % 60);
  if (h < 24) return m ? `${h}h ${m}m` : `${h}h`;
  const days = Math.floor(h / 24);
  return `${days}d ${h % 24}h`;
}
