// Ledger Line shared notes (Vercel serverless function).
// POST (signed in): { action: 'save', id?, title, meta, html } creates or updates a read-only copy and returns its id;
//                   { action: 'stop', id } removes it. Only the person who shared a note can change or stop it.
// GET ?t=<id>: the public read-only page. Shared copies live at __shares/<id>, outside every journal, so the
// docs API never lists them. The page is served with a strict Content-Security-Policy (no scripts at all).
import { randomBytes } from 'node:crypto';
import { db, principal } from './docs.js';

const SH = '__shares';
const log = (...a) => console.log('[ledgerline:share]', ...a);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Defence in depth: the journal already sanitises notes, and the CSP blocks scripts; this strips anything active anyway.
const clean = h => String(h || '').slice(0, 1_500_000)
  .replace(/<\s*(script|style|iframe|object|embed|form|input|button|textarea|select|link|meta|base|svg|math)[\s\S]*?(<\s*\/\s*\1\s*>|$)/gi, '')
  .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  .replace(/(href|src)\s*=\s*("|')\s*(javascript|vbscript|data:(?!image\/))[^"']*\2/gi, '$1="#"');
async function readBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) return JSON.parse(String(req.body) || '{}');
  const chunks = []; for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
const page = d => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(d.title)} · Ledger Line</title><style>
:root{color-scheme:light dark;--ink:#16181f;--muted:#6b7280;--line:#e5e7eb;--bg:#f6f6fa;--card:#fff;--gain:#16a34a;--loss:#dc2626;--accent:#6a4ae0}
@media (prefers-color-scheme:dark){:root{--ink:#e8e9f0;--muted:#9aa0ae;--line:#2a2d3a;--bg:#0f1016;--card:#171923}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:820px;margin:32px auto;padding:28px 32px;background:var(--card);border:1px solid var(--line);border-radius:14px}
h1.t{font-size:26px;margin:0 0 4px}.meta{color:var(--muted);font-size:13px;margin-bottom:6px}.sum{font-weight:700;margin:6px 0 18px}
.gain{color:var(--gain)}.loss{color:var(--loss)}table{border-collapse:collapse;width:100%;margin:10px 0}td,th{border:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top}th{background:var(--bg)}
img{max-width:100%;border-radius:8px}blockquote{border-left:3px solid var(--accent);margin:8px 0;padding:2px 12px;color:var(--muted)}pre,code{background:var(--bg);border-radius:4px;padding:1px 5px}
details{border:1px solid var(--line);border-radius:10px;padding:6px 12px;margin:8px 0}summary{font-weight:700}li.todo{list-style:none}li.todo::before{content:"☐ ";color:var(--muted)}li.todo.done::before{content:"☑ ";color:var(--gain)}li.todo.done{color:var(--muted);text-decoration:line-through}
.hl-violet,.hl-red,.hl-green,.hl-blue,.hl-amber{display:inline-block;color:#fff;padding:2px 10px;border-radius:3px;text-transform:uppercase}.hl-violet{background:#a855f7}.hl-red{background:#dc2626}.hl-green{background:#16a34a}.hl-blue{background:#2563eb}.hl-amber{background:#d97706}
footer{max-width:820px;margin:0 auto 32px;color:var(--muted);font-size:12px;text-align:center}
@media (max-width:640px){main{margin:0;border-radius:0;padding:20px 16px}}
</style></head><body><main><h1 class="t">${esc(d.title)}</h1><div class="meta">Shared by ${esc(d.by || 'a trader')} · updated ${esc(String(d.updatedAt || '').slice(0, 16).replace('T', ' '))} UTC</div>
${d.meta ? `<div class="sum ${d.tone === 'gain' ? 'gain' : d.tone === 'loss' ? 'loss' : ''}">${esc(d.meta)}</div>` : ''}${clean(d.html)}</main><footer>Read-only note shared from a Ledger Line trading journal.</footer></body></html>`;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const store = await db();
    if (req.method === 'GET') {
      const q = req.query || Object.fromEntries(new URL(req.url, 'http://x').searchParams);
      const id = String(q.t || '').replace(/[^A-Za-z0-9_-]/g, '');
      const d = id ? await store.get(`${SH}/${id}`) : null;
      res.setHeader('Content-Security-Policy', "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
      res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('content-type', 'text/html; charset=utf-8');
      if (!d) { res.statusCode = 404; return res.end('<!doctype html><meta charset="utf-8"><title>Not found</title><p style="font:16px system-ui;margin:40px">This note isn\'t shared any more.</p>'); }
      res.statusCode = 200; return res.end(page(d));
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Use GET or POST.' });
    const P = await principal(req, store); if (!P) return res.status(401).json({ error: 'Not signed in.' });
    const b = await readBody(req), id = String(b.id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
    const cur = id ? await store.get(`${SH}/${id}`) : null;
    if (cur && cur.owner !== P.name) return res.status(403).json({ error: 'That shared note belongs to someone else.' });
    if (b.action === 'stop') { if (cur) await store.write([{ path: `${SH}/${id}`, parent: SH, data: null }]); log(P.name, 'stopped sharing', id); return res.status(200).json({ ok: true }); }
    if (b.action !== 'save') return res.status(400).json({ error: 'Unknown action.' });
    const html = String(b.html || ''); if (html.length > 1_500_000) return res.status(413).json({ error: 'This note is too large to share (images make notes big).' });
    const nid = cur ? id : randomBytes(12).toString('base64url');
    await store.write([{ path: `${SH}/${nid}`, parent: SH, data: { owner: P.name, by: String(b.by || '').slice(0, 40), title: String(b.title || 'Note').slice(0, 140), meta: String(b.meta || '').slice(0, 200), tone: b.tone === 'gain' || b.tone === 'loss' ? b.tone : '', html, createdAt: (cur && cur.createdAt) || new Date().toISOString(), updatedAt: new Date().toISOString() } }]);
    if (!cur) log(P.name, 'shared a note', nid);
    return res.status(200).json({ ok: true, id: nid });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[ledgerline:share]', err && err.message);
    return res.status(502).json({ error: 'The server could not reach the database.' });
  }
}
