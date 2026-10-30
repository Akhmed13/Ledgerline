// Ledger Line live sync from desktop platforms (Vercel serverless function).
// The LedgerLineSync add-on for NinjaTrader 8 posts every fill here as it happens. Fills are stored under ntx/,
// grouped into round trips per account and instrument (flat → position → flat), and saved as journal trades.
// Auth: a sync key "<username>:<secret>" made in Settings → Accounts. Only a SHA-256 hash of the secret is stored
// (settings/sync in that user's journal), so the key can be replaced or turned off from the journal at any time.
import { createHash, timingSafeEqual } from 'node:crypto';
import { db, USERS } from './docs.js';

export const config = { maxDuration: 30 };
const log = (...a) => console.log('[ledgerline:ingest]', ...a);
const sha = s => createHash('sha256').update(String(s)).digest('hex');
const safeId = s => String(s).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120) || 'x';
const r2 = n => Math.round(n * 100) / 100, r6 = n => +(+n).toFixed(6);

async function readBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) return JSON.parse(String(req.body) || '{}');
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > 2_000_000) throw Object.assign(new Error('Too much data in one request.'), { status: 413 }); chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

// Who owns this key, and where their journal lives.
async function keyOwner(store, key) {
  const m = /^([a-z0-9][a-z0-9_.-]{1,31}):([A-Za-z0-9_-]{20,100})$/.exec(String(key || '').trim()); if (!m) return null;
  const [, name, secret] = m;
  if (name !== 'admin') { const u = await store.get(`${USERS}/${name}`); if (!u || u.disabled) return null; }
  const prefix = name === 'admin' ? '' : `u/${name}/`;
  const cfg = await store.get(`${prefix}settings/sync`);
  if (!cfg || !cfg.hash || cfg.off) return null;
  const a = Buffer.from(sha(secret)), b = Buffer.from(String(cfg.hash));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { name, prefix, cfg };
}

// "MGC 12-25" → "MGC"; "ES 03-26" → "ES"; forex/stock names pass through.
const rootOf = x => String(x.root || String(x.instrument || '').split(' ')[0] || '').toUpperCase().slice(0, 20);
const cleanExec = (x, acct) => {
  const qty = Math.abs(+x.qty || 0), price = +x.price, time = String(x.time || '').replace(' ', 'T').slice(0, 23);
  if (!x.id || !qty || !Number.isFinite(price) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(time)) return null;
  const side = /^s/i.test(x.side) ? 'Sell' : 'Buy';
  return { id: String(x.id).slice(0, 120), orderId: String(x.orderId || '').slice(0, 120), account: String(acct || x.account || '').slice(0, 80), instrument: String(x.instrument || '').slice(0, 60),
    root: rootOf(x), side, qty, price, time, commission: Math.abs(+x.commission || 0), pointValue: +x.pointValue > 0 ? +x.pointValue : 1, tickSize: +x.tickSize > 0 ? +x.tickSize : 0 };
};

// Fills → round trips. A fill that flips the position closes one trade and opens the next.
export function roundTrips(fills) {
  const ex = fills.slice().sort((a, b) => a.time.localeCompare(b.time) || a.id.localeCompare(b.id));
  const out = []; let cur = null, pos = 0;
  for (const f of ex) {
    let left = f.qty; const dir = f.side === 'Buy' ? 1 : -1;
    while (left > 1e-9) {
      if (!cur) { cur = { first: f.id, dir, fills: [], open: 0 }; }
      const closing = pos !== 0 && Math.sign(pos) !== dir, q = closing ? Math.min(left, Math.abs(pos)) : left;
      cur.fills.push({ ...f, qty: q, commission: f.commission * (q / f.qty) });
      pos += dir * q; left -= q;
      if (Math.abs(pos) < 1e-9) { pos = 0; out.push(cur); cur = null; }
    }
  }
  return { closed: out, open: cur };
}
export function tripToTrade(tr, feeRows = []) {
  const f = tr.fills, d = tr.dir, ins = f.filter(x => (x.side === 'Buy' ? 1 : -1) === d), outs = f.filter(x => (x.side === 'Buy' ? 1 : -1) !== d);
  const qIn = ins.reduce((a, x) => a + x.qty, 0), qOut = outs.reduce((a, x) => a + x.qty, 0);
  const entry = ins.reduce((a, x) => a + x.price * x.qty, 0) / qIn, exit = outs.reduce((a, x) => a + x.price * x.qty, 0) / qOut;
  const mult = f[0].pointValue || 1, rule = feeRows.find(r => r && r.root && String(r.root).toUpperCase() === f[0].root);
  let fees = r2(f.reduce((a, x) => a + x.commission, 0)); const feeSrc = fees > 0 ? 'platform' : rule ? 'rule' : '';
  if (!(fees > 0) && rule) fees = r2((+rule.fee || 0) * qIn); // platform sent no commission → use your fee table
  const pnl = r2((exit - entry) * d * Math.min(qIn, qOut) * mult - fees);
  const a = f[0].time, b = f[f.length - 1].time;
  return {
    extId: `nt:${f[0].account}:${tr.first}`, source: 'NinjaTrader', ntAccount: f[0].account, instrument: f[0].instrument,
    date: a.slice(0, 10), time: a.slice(11, 16), exitDate: b.slice(0, 10), exitTime: b.slice(11, 16),
    symbol: f[0].root, side: d > 0 ? 'Long' : 'Short', qty: qIn, entry: r6(entry), exit: r6(exit), mult, fees, feeSrc, pnl,
    executions: f.map((x, i) => ({ id: safeId(x.id) + (f.findIndex(y => y.id === x.id) === i ? '' : '-' + i), time: x.time.slice(11, 19), side: x.side, qty: x.qty, price: x.price }))
  };
}
const KEEP = ['tags', 'note', 'attachments', 'rating', 'reviewed', 'playbookId', 'rulesChecked', 'risk', 'stop', 'target', 'mae', 'mfe', 'accountId', 'createdAt', 'bestExit', 'bestExitTime'];

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') return res.status(200).json({ ok: true, service: 'ledgerline-ingest' });
    if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });
    const store = await db();
    const who = await keyOwner(store, req.headers['x-ledgerline-sync']);
    if (!who) { log('rejected: bad or disabled sync key'); return res.status(401).json({ error: 'Sync key not recognised. Make a new one in Ledger Line → Settings → Accounts.' }); }
    const body = await readBody(req), P = who.prefix, now = new Date().toISOString();
    const raw = Array.isArray(body.executions) ? body.executions.slice(0, 1000) : [];
    const fills = raw.map(x => cleanExec(x)).filter(Boolean);
    const status = { lastAt: now, client: String(body.client || '').slice(0, 60), accounts: [...new Set([...(Array.isArray(body.accounts) ? body.accounts : []), ...fills.map(f => f.account)].map(s => String(s).slice(0, 80)).filter(Boolean))].slice(0, 30) };
    if (!fills.length) { await store.write([{ path: `${P}settings/syncStatus`, parent: `${P}settings`, data: { ...((await store.get(`${P}settings/syncStatus`)) || {}), ...status, ping: now } }]); return res.status(200).json({ ok: true, trades: 0, fills: 0 }); }

    // 1) store the fills (same id = same doc, so re-sending is harmless)
    const known = new Map((await store.list(`${P}ntx`)).map(r => [r.path.split('/').pop(), r.data]));
    const fresh = [];
    for (const f of fills) { const k = safeId(f.account + '_' + f.id); const old = known.get(k); if (!old || old.qty !== f.qty || old.price !== f.price || old.time !== f.time) fresh.push({ path: `${P}ntx/${k}`, parent: `${P}ntx`, data: f }); known.set(k, f); }
    if (fresh.length) await store.write(fresh);

    // 2) rebuild round trips for every account + instrument that got a fill
    const groups = new Set(fills.map(f => f.account + '|' + f.instrument)), map = who.cfg.map || {}, ops = []; let made = 0, openPos = [];
    const feeRows = ((await store.get(`${P}settings/fees`)) || {}).rows || [];
    for (const g of groups) {
      const all = [...known.values()].filter(f => f.account + '|' + f.instrument === g);
      const { closed, open } = roundTrips(all);
      if (open) openPos.push(g.replace('|', ' '));
      for (const tr of closed) {
        const t = tripToTrade(tr, feeRows), id = 'nt-' + safeId(t.ntAccount + '-' + tr.first).slice(0, 110), path = `${P}trades/${id}`;
        const prev = await store.get(path);
        if (prev && prev.pnl === t.pnl && prev.qty === t.qty && (prev.executions || []).length === t.executions.length) continue;
        const keep = prev ? Object.fromEntries(KEEP.filter(k => prev[k] !== undefined).map(k => [k, prev[k]])) : {};
        const data = { tags: {}, rulesChecked: [], attachments: [], note: '', reviewed: false, rating: 0, risk: 0, playbookId: '', sample: false, createdAt: now,
          accountId: map[t.ntAccount] || who.cfg.accountId || 'main', ...t, ...keep, syncedAt: now };
        ops.push({ path, parent: `${P}trades`, data }); made++;
      }
    }
    for (let i = 0; i < ops.length; i += 100) await store.write(ops.slice(i, i + 100));
    await store.write([{ path: `${P}settings/syncStatus`, parent: `${P}settings`, data: { ...status, lastFill: fills.map(f => f.time).sort().pop(), open: openPos, lastTrades: made, total: known.size } }]);
    log(`${who.name}: ${fills.length} fill(s), ${fresh.length} new, ${made} trade(s) saved${openPos.length ? ', open: ' + openPos.join(', ') : ''}`);
    return res.status(200).json({ ok: true, fills: fills.length, newFills: fresh.length, trades: made, open: openPos });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[ledgerline:ingest]', err && err.code, err && err.message);
    return res.status(502).json({ error: 'The server could not save the fills. Check the Vercel logs.' });
  }
}
