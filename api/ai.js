// Ledger Line AI (Vercel serverless function).
// Lets the journal's AI features (Ledgerline AI panel, Ask Claude, agents, reviews, backtest analysis) use Claude
// through the Anthropic API on the website. Needs process.env.ANTHROPIC_API_KEY; optional ANTHROPIC_MODEL.
// Only signed-in users can call it. The answer is streamed back as newline-delimited JSON: {"t":"text so far"} … {"done":true}.
import { principal } from './docs.js';

export const config = { maxDuration: 60 };
const MODEL = () => process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const log = (...a) => console.log('[ledgerline:ai]', ...a);
const hits = new Map(); // simple per-instance limit: 40 requests per user per 10 minutes
const limited = who => { const now = Date.now(), h = (hits.get(who) || []).filter(t => now - t < 10 * 60e3); h.push(now); hits.set(who, h); return h.length > 40; };

async function readBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) return JSON.parse(String(req.body) || '{}');
  const chunks = []; for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
function cleanMessages(input) {
  const raw = typeof input === 'string' ? [{ role: 'user', content: input }] : Array.isArray(input) ? input : [];
  const out = raw.filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim()).map(m => ({ role: m.role, content: m.content.slice(0, 120000) })).slice(-20);
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const q = req.query || Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  if (req.method === 'GET' && q.probe) return res.status(200).json({ configured: !!process.env.ANTHROPIC_API_KEY, model: MODEL() });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });
  let P;
  try { P = await principal(req); } catch (e) { return res.status(502).json({ error: 'The server could not reach the database.' }); }
  if (!P) return res.status(401).json({ error: 'Not signed in.' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ code: 'not_configured', error: 'The AI needs an Anthropic API key. Add ANTHROPIC_API_KEY in Vercel → Settings → Environment Variables, then redeploy.' });
  if (limited(P.name)) return res.status(429).json({ code: 'rate_limited', error: 'Too many AI requests. Wait a few minutes and try again.' });
  let body; try { body = await readBody(req); } catch (e) { return res.status(400).json({ error: 'Bad request.' }); }
  const messages = cleanMessages(body.input);
  if (!messages.length) return res.status(400).json({ error: 'Nothing to send.' });

  let up;
  try {
    up = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL(), max_tokens: Math.min(4000, Math.max(256, +body.maxTokens || 2000)), stream: true, messages })
    });
  } catch (e) { return res.status(502).json({ error: "Couldn't reach the Anthropic API. Try again." }); }
  if (!up.ok) {
    let j = {}; try { j = await up.json(); } catch (e) {}
    const msg = (j.error && j.error.message) || `Anthropic API error ${up.status}`;
    log('upstream error', up.status, msg);
    const status = up.status === 401 ? 503 : up.status === 429 || up.status === 529 ? 429 : 502;
    return res.status(status).json({ code: up.status === 429 || up.status === 529 ? 'rate_limited' : up.status === 401 ? 'not_configured' : 'upstream', error: up.status === 401 ? 'Anthropic rejected the API key. Check ANTHROPIC_API_KEY in Vercel.' : up.status === 529 ? 'Claude is busy right now. Try again in a moment.' : msg });
  }

  res.statusCode = 200;
  res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('x-accel-buffering', 'no');
  const send = o => res.write(JSON.stringify(o) + '\n');
  const reader = up.body.getReader(), dec = new TextDecoder();
  let buf = '', text = '', lastSent = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = chunk.split('\n').find(l => l.startsWith('data:')); if (!line) continue;
        let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch (e) { continue; }
        if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') { text += ev.delta.text; if (Date.now() - lastSent > 60) { send({ t: text }); lastSent = Date.now(); } }
        else if (ev.type === 'error') { send({ error: (ev.error && ev.error.message) || 'Claude stopped with an error.', code: ev.error && ev.error.type === 'overloaded_error' ? 'rate_limited' : 'upstream' }); res.end(); return; }
      }
    }
    send({ t: text, done: true });
    log(`answered ${P.name} (${text.length} chars)`);
  } catch (e) { send({ error: 'The answer was cut off. Try again.' }); }
  res.end();
}
