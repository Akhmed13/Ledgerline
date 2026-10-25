// Ledger Line AI (Vercel serverless function).
// Lets the journal's AI features (Ledgerline AI panel, Ask Claude, agents, reviews, backtest analysis) work on the website.
// Providers: OpenRouter (OPENROUTER_API_KEY, optional OPENROUTER_MODEL, default openrouter/auto) or
// Anthropic (ANTHROPIC_API_KEY, optional ANTHROPIC_MODEL). With both keys set, AI_PROVIDER=anthropic|openrouter picks one;
// otherwise OpenRouter is used.
// Only signed-in users can call it. The answer is streamed back as newline-delimited JSON: {"t":"text so far"} … {"done":true}.
import { principal } from './docs.js';

export const config = { maxDuration: 60 };
const PROVIDER = () => { const want = (process.env.AI_PROVIDER || '').toLowerCase(), or = !!process.env.OPENROUTER_API_KEY, an = !!process.env.ANTHROPIC_API_KEY; if (want === 'anthropic' && an) return 'anthropic'; if (want === 'openrouter' && or) return 'openrouter'; return or ? 'openrouter' : an ? 'anthropic' : null; };
const MODEL = () => PROVIDER() === 'openrouter' ? (process.env.OPENROUTER_MODEL || 'openrouter/auto') : (process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5');
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
  if (req.method === 'GET' && q.probe) return res.status(200).json({ configured: !!PROVIDER(), provider: PROVIDER(), model: MODEL() });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });
  let P;
  try { P = await principal(req); } catch (e) { return res.status(502).json({ error: 'The server could not reach the database.' }); }
  if (!P) return res.status(401).json({ error: 'Not signed in.' });
  const prov = PROVIDER();
  if (!prov) return res.status(503).json({ code: 'not_configured', error: 'The AI needs an API key. Add OPENROUTER_API_KEY (or ANTHROPIC_API_KEY) in Vercel → Settings → Environment Variables, then redeploy.' });
  if (limited(P.name)) return res.status(429).json({ code: 'rate_limited', error: 'Too many AI requests. Wait a few minutes and try again.' });
  let body; try { body = await readBody(req); } catch (e) { return res.status(400).json({ error: 'Bad request.' }); }
  const messages = cleanMessages(body.input);
  if (!messages.length) return res.status(400).json({ error: 'Nothing to send.' });

  const isOR = prov === 'openrouter', maxTokens = Math.min(4000, Math.max(256, +body.maxTokens || 2000));
  let up;
  try {
    up = isOR
      ? await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + process.env.OPENROUTER_API_KEY, 'content-type': 'application/json', 'HTTP-Referer': process.env.APP_URL || 'https://ledgerline.vercel.app', 'X-Title': 'Ledger Line' }, body: JSON.stringify({ model: MODEL(), max_tokens: maxTokens, stream: true, messages }) })
      : await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model: MODEL(), max_tokens: maxTokens, stream: true, messages }) });
  } catch (e) { return res.status(502).json({ error: `Couldn't reach ${isOR ? 'OpenRouter' : 'the Anthropic API'}. Try again.` }); }
  if (!up.ok) {
    let j = {}; try { j = await up.json(); } catch (e) {}
    const msg = (j.error && j.error.message) || `${isOR ? 'OpenRouter' : 'Anthropic API'} error ${up.status}`, who = isOR ? 'OpenRouter' : 'Anthropic', keyVar = isOR ? 'OPENROUTER_API_KEY' : 'ANTHROPIC_API_KEY';
    log('upstream error', prov, up.status, msg);
    if (up.status === 401 || up.status === 403) return res.status(503).json({ code: 'not_configured', error: `${who} rejected the API key. Check ${keyVar} in Vercel.` });
    if (up.status === 402) return res.status(503).json({ code: 'not_configured', error: 'Your OpenRouter account is out of credits. Add credits at openrouter.ai, then try again.' });
    if (up.status === 429 || up.status === 529 || up.status === 503) return res.status(429).json({ code: 'rate_limited', error: `${who} is busy or rate-limited right now. Try again in a moment.` });
    if (up.status === 400 || up.status === 404) return res.status(502).json({ code: 'upstream', error: `${msg}${/model/i.test(msg) ? '' : ''} (model: ${MODEL()}). Check ${isOR ? 'OPENROUTER_MODEL' : 'ANTHROPIC_MODEL'}.` });
    return res.status(502).json({ code: 'upstream', error: msg });
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
      buf = buf.replace(/\r\n/g, '\n');
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data:')) continue; const data = line.slice(5).trim(); if (!data || data === '[DONE]') continue;
          let ev; try { ev = JSON.parse(data); } catch (e) { continue; }
          let piece = '';
          if (isOR) { if (ev.error) { send({ error: ev.error.message || 'The model stopped with an error.', code: ev.error.code === 429 ? 'rate_limited' : 'upstream' }); res.end(); return; } piece = (ev.choices && ev.choices[0] && ev.choices[0].delta && ev.choices[0].delta.content) || ''; }
          else if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') piece = ev.delta.text;
          else if (ev.type === 'error') { send({ error: (ev.error && ev.error.message) || 'Claude stopped with an error.', code: ev.error && ev.error.type === 'overloaded_error' ? 'rate_limited' : 'upstream' }); res.end(); return; }
          if (piece) { text += piece; if (Date.now() - lastSent > 60) { send({ t: text }); lastSent = Date.now(); } }
        }
      }
    }
    if (!text) { send({ error: 'The model returned an empty answer. Try again or pick another model.', code: 'upstream' }); res.end(); return; }
    send({ t: text, done: true });
    log(`answered ${P.name} via ${prov} ${MODEL()} (${text.length} chars)`);
  } catch (e) { send({ error: 'The answer was cut off. Try again.' }); }
  res.end();
}
