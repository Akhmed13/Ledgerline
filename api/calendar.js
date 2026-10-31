// Ledger Line economic calendar (Vercel serverless function).
// GET → { events: [{ at, title, cur, impact, forecast, previous }] } for this week and next week, from the public
// Forex Factory weekly feed. The feed asks clients not to poll often, so results are cached in memory and at
// Vercel's edge for 30 minutes; every journal user shares that one cached copy.
export const config = { maxDuration: 15 };
const FEEDS = ['https://nfs.faireconomy.media/ff_calendar_thisweek.json', 'https://nfs.faireconomy.media/ff_calendar_nextweek.json'];
const TTL = 30 * 60 * 1000;
let cache = { at: 0, events: null };
const IMP = { High: 'high', Medium: 'med', Low: 'low', Holiday: 'hol' };

async function grab(url) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'LedgerLine-journal/1.0', accept: 'application/json' } });
    if (!r.ok) return null;
    const j = await r.json(); return Array.isArray(j) ? j : null;
  } catch (e) { return null; } finally { clearTimeout(t); }
}
export function normalise(rows) {
  const seen = new Set(), out = [];
  for (const x of rows) {
    const at = Date.parse(x && x.date); if (!x || !x.title || !Number.isFinite(at)) continue;
    const ev = { at: new Date(at).toISOString(), title: String(x.title).slice(0, 140), cur: String(x.country || '').toUpperCase().slice(0, 6), impact: IMP[x.impact] || 'low',
      forecast: String(x.forecast || '').slice(0, 30), previous: String(x.previous || '').slice(0, 30), actual: String(x.actual || '').slice(0, 30) };
    const k = ev.at + ev.cur + ev.title; if (seen.has(k)) continue; seen.add(k); out.push(ev);
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Use GET.' });
  if (!cache.events || Date.now() - cache.at > TTL) {
    const parts = await Promise.all(FEEDS.map(grab));
    if (parts[0]) cache = { at: Date.now(), events: normalise([...parts[0], ...(parts[1] || [])]) };
  }
  if (!cache.events) { res.setHeader('Cache-Control', 'no-store'); return res.status(502).json({ error: 'The calendar feed could not be reached. Try again in a few minutes.' }); }
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=1800, stale-while-revalidate=3600');
  return res.status(200).json({ updated: new Date(cache.at).toISOString(), events: cache.events });
}
