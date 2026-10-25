// Ledgerline broker auto-sync (Vercel serverless function).
// Links MetaTrader 4/5 accounts through MetaApi (https://metaapi.cloud) with a read-only investor password,
// then reads the closed-trade history and turns it into journal trades.
// Needs process.env.METAAPI_TOKEN (a MetaApi API token) and process.env.LEDGERLINE_PASSWORD, like /api/docs.
// The investor password is passed to MetaApi once and never stored in the journal database.
import { randomBytes } from 'node:crypto';
import { principal } from './docs.js';

export const config = { maxDuration: 30 };

const PROV = process.env.METAAPI_PROVISIONING_URL || 'https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai';
const CLIENT = process.env.METAAPI_CLIENT_URL || 'https://mt-client-api-v1.{region}.agiliumtrade.ai';
const clientUrl = region => CLIENT.replace('{region}', region || 'new-york');
const token = () => process.env.METAAPI_TOKEN || '';
const log = (...a) => console.log('[ledgerline:broker]', ...a);

async function readBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) return JSON.parse(String(req.body) || '{}');
  const chunks = []; for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function ma(url, opts = {}) {
  let r;
  try {
    r = await fetch(url, { ...opts, headers: { 'auth-token': token(), accept: 'application/json', ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) }, signal: AbortSignal.timeout(20000) });
  } catch (e) { throw Object.assign(new Error("Couldn't reach MetaApi. Try again in a moment."), { status: 502 }); }
  const text = await r.text(); let j = null; try { j = text ? JSON.parse(text) : null; } catch (e) { j = { message: text.slice(0, 300) }; }
  return { status: r.status, j, retry: r.headers.get('retry-after') };
}
function explain(res, fallback) {
  const j = res.j || {}, code = (j.details && (j.details.code || j.details)) || j.error || '', msg = j.message || '';
  if (res.status === 401) return 'MetaApi rejected the API token. Check METAAPI_TOKEN in Vercel.';
  if (res.status === 403) return 'The MetaApi token is missing permissions for this action.';
  if (/E_AUTH/.test(code + msg)) return 'The login or investor password was rejected by the broker server.';
  if (/E_SRV_NOT_FOUND/.test(code + msg)) return "That server name wasn't found. Copy it exactly from the MetaTrader login window.";
  if (/E_SERVER_TIMEZONE/.test(code + msg)) return "MetaApi couldn't detect this broker's settings. Try again later or contact MetaApi support.";
  return msg || fallback;
}
const retrySecs = h => { const n = Number(h), w = Number.isFinite(n) ? n : (Date.parse(h) - Date.now()) / 1000; return Math.min(30, Math.max(3, Math.ceil(w) || 5)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* deals → trades */
const OUT = new Set(['DEAL_ENTRY_OUT', 'DEAL_ENTRY_OUT_BY', 'DEAL_ENTRY_INOUT']);
const TRADE_TYPES = new Set(['DEAL_TYPE_BUY', 'DEAL_TYPE_SELL']);
function splitTime(d) {
  const s = String(d.brokerTime || d.time || '').replace('T', ' ');
  return { date: s.slice(0, 10), time: s.slice(11, 16), full: s };
}
function dealsToTrades(deals, accountId) {
  const byPos = new Map(); let deposits = 0, withdrawals = 0;
  for (const d of deals) {
    if (d.type === 'DEAL_TYPE_BALANCE') { const p = +d.profit || 0; if (p >= 0) deposits += p; else withdrawals += -p; continue; }
    if (!TRADE_TYPES.has(d.type) || !d.positionId) continue;
    if (!byPos.has(d.positionId)) byPos.set(d.positionId, []);
    byPos.get(d.positionId).push(d);
  }
  const trades = [];
  for (const [pos, list] of byPos) {
    list.sort((a, b) => String(a.time).localeCompare(String(b.time)));
    const ins = list.filter(d => d.entryType === 'DEAL_ENTRY_IN'), outs = list.filter(d => OUT.has(d.entryType));
    if (!ins.length || !outs.length) continue;
    const vin = ins.reduce((a, d) => a + (+d.volume || 0), 0), vout = outs.reduce((a, d) => a + (+d.volume || 0), 0);
    if (vout + 1e-9 < vin) continue; // still open
    const side = ins[0].type === 'DEAL_TYPE_BUY' ? 'Long' : 'Short', dir = side === 'Long' ? 1 : -1;
    const entry = ins.reduce((a, d) => a + d.price * d.volume, 0) / vin, exit = outs.reduce((a, d) => a + d.price * d.volume, 0) / vout;
    const profit = list.reduce((a, d) => a + (+d.profit || 0), 0), comm = list.reduce((a, d) => a + (+d.commission || 0), 0), swap = list.reduce((a, d) => a + (+d.swap || 0), 0);
    const move = (exit - entry) * dir * vin, mult = Math.abs(move) > 1e-12 ? Math.abs(profit / move) : 1;
    const a = splitTime(ins[0]), b = splitTime(outs[outs.length - 1]);
    trades.push({
      extId: `mt:${accountId}:${pos}`, date: a.date, time: a.time, exitDate: b.date, exitTime: b.date === a.date ? b.time : '',
      symbol: String(ins[0].symbol || '').toUpperCase().slice(0, 20), side, qty: Math.round(vin * 1000) / 1000,
      entry: +entry.toFixed(6), exit: +exit.toFixed(6), mult: +mult.toPrecision(8), fees: Math.round(-(comm + swap) * 100) / 100,
      pnl: Math.round((profit + comm + swap) * 100) / 100, risk: 0
    });
  }
  trades.sort((x, y) => (x.date + x.time).localeCompare(y.date + y.time));
  return { trades, deposits: Math.round(deposits * 100) / 100, withdrawals: Math.round(withdrawals * 100) / 100 };
}

async function findExisting(login, server) {
  const r = await ma(`${PROV}/users/current/accounts`);
  if (r.status !== 200 || !Array.isArray(r.j)) return null;
  return r.j.find(a => String(a.login) === String(login) && String(a.server).toLowerCase() === String(server).toLowerCase()) || null;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });
    if (!process.env.LEDGERLINE_PASSWORD) return res.status(503).json({ error: 'LEDGERLINE_PASSWORD is not set in the Vercel project.' });
    if (!(await principal(req))) return res.status(401).json({ error: 'Not signed in.' });
    const b = await readBody(req), act = b.action;
    if (act === 'probe') return res.status(200).json({ configured: !!token() });
    if (!token()) return res.status(503).json({ error: 'Auto-sync needs a MetaApi token. Add METAAPI_TOKEN in Vercel → Settings → Environment Variables, then redeploy.' });
    const id = String(b.accountId || '').replace(/[^A-Za-z0-9-]/g, '');

    if (act === 'connect') {
      const login = String(b.login || '').replace(/\D/g, ''), server = String(b.server || '').trim(), platform = b.platform === 'mt4' ? 'mt4' : 'mt5';
      if (!login || !server || (!b.password && !b.txId)) return res.status(400).json({ error: 'Server, login and investor password are all required.' });
      if (!b.txId) { const ex = await findExisting(login, server); if (ex) { log('reusing linked account', ex._id || ex.id); return res.status(200).json({ accountId: ex._id || ex.id, state: ex.state, region: ex.region }); } }
      const txId = /^[a-f0-9]{32}$/.test(b.txId || '') ? b.txId : randomBytes(16).toString('hex');
      const r = await ma(`${PROV}/users/current/accounts`, { method: 'POST', headers: { 'transaction-id': txId }, body: JSON.stringify({ name: String(b.name || `Ledgerline ${login}`).slice(0, 60), login, password: String(b.password || ''), server, platform, magic: 0, type: 'cloud-g2', keywords: b.broker ? [String(b.broker)] : undefined, metadata: { app: 'ledgerline' } }) });
      if (r.status === 201) { log('linked', platform, server); return res.status(200).json({ accountId: r.j.id, state: r.j.state }); }
      if (r.status === 202) return res.status(200).json({ pending: true, txId, wait: retrySecs(r.retry) });
      log('connect failed', r.status, JSON.stringify(r.j).slice(0, 300));
      return res.status(400).json({ error: explain(r, `MetaApi returned ${r.status}.`) });
    }
    if (!id) return res.status(400).json({ error: 'Missing account.' });

    if (act === 'status') {
      const r = await ma(`${PROV}/users/current/accounts/${id}`);
      if (r.status !== 200) return res.status(r.status === 404 ? 404 : 400).json({ error: r.status === 404 ? 'This linked account no longer exists at MetaApi. Link it again.' : explain(r, `MetaApi returned ${r.status}.`) });
      if (r.j.state === 'UNDEPLOYED') await ma(`${PROV}/users/current/accounts/${id}/deploy`, { method: 'POST' });
      return res.status(200).json({ state: r.j.state, connectionStatus: r.j.connectionStatus, region: r.j.region || 'new-york', name: r.j.name });
    }
    if (act === 'fetch') {
      const base = `${clientUrl(String(b.region || '').replace(/[^a-z0-9-]/g, ''))}/users/current/accounts/${id}`;
      const from = new Date(b.from || Date.now() - 365 * 864e5), to = new Date(Date.now() + 864e5);
      if (isNaN(from)) return res.status(400).json({ error: 'Bad start date.' });
      const info = await ma(`${base}/account-information`);
      if (info.status !== 200) return res.status(info.status === 404 ? 409 : 400).json({ error: info.status === 404 ? 'The terminal is still connecting. Try again in a minute.' : explain(info, `MetaApi returned ${info.status}.`) });
      const deals = [];
      for (let offset = 0; offset < 20000; offset += 1000) {
        const r = await ma(`${base}/history-deals/time/${from.toISOString()}/${to.toISOString()}?offset=${offset}&limit=1000`);
        if (r.status !== 200) return res.status(400).json({ error: explain(r, `Couldn't read the trade history (${r.status}).`) });
        const page = Array.isArray(r.j) ? r.j : (r.j && r.j.deals) || []; deals.push(...page);
        if (page.length < 1000) break;
        await sleep(200);
      }
      const out = dealsToTrades(deals, id), I = info.j;
      log(`fetched ${deals.length} deals → ${out.trades.length} trades`);
      return res.status(200).json({ info: { name: I.name, server: I.server, login: I.login, balance: I.balance, equity: I.equity, currency: I.currency || 'USD', platform: I.platform }, ...out });
    }
    if (act === 'remove') {
      const r = await ma(`${PROV}/users/current/accounts/${id}`, { method: 'DELETE' });
      return res.status(200).json({ ok: r.status < 300 || r.status === 404 });
    }
    return res.status(400).json({ error: 'Unknown action.' });
  } catch (err) {
    console.error('[ledgerline:broker]', err && err.stack || err);
    return res.status(err.status || 500).json({ error: err.status ? err.message : 'The sync server hit an error. Check the Vercel logs.' });
  }
}

export { dealsToTrades };
