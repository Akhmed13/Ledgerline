// Ledgerline sign-in and user management (Vercel serverless function).
// The owner signs in as "admin" with LEDGERLINE_PASSWORD and can create users, each with their own password and
// their own private journal. Passwords are stored as scrypt hashes in the ledgerline_docs table (path __users/<name>).
import { db, principal, signToken, hashPw, checkPw, validName, adminPasswordOk, USERS, OWNER } from './docs.js';

const log = (...a) => console.log('[ledgerline:auth]', ...a);
async function readBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) return JSON.parse(String(req.body) || '{}');
  const chunks = []; for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
const pub = (name, u) => ({ name, admin: !!u.admin, disabled: !!u.disabled, created: u.created || null, lastLogin: u.lastLogin || null });
const save = (store, name, u) => store.write([{ path: `${USERS}/${name}`, parent: USERS, data: u }]);
const pwProblem = pw => typeof pw !== 'string' || pw.length < 8 ? 'Passwords need at least 8 characters.' : pw.length > 200 ? 'That password is too long.' : '';
const fails = new Map();
const tooMany = key => { const f = fails.get(key); return f && f.n >= 8 && Date.now() - f.t < 10 * 60e3; };
const failed = key => { const f = fails.get(key) || { n: 0, t: 0 }; fails.set(key, { n: Date.now() - f.t > 10 * 60e3 ? 1 : f.n + 1, t: Date.now() }); };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });
    if (!process.env.LEDGERLINE_PASSWORD) return res.status(503).json({ error: 'LEDGERLINE_PASSWORD is not set in the Vercel project.' });
    const b = await readBody(req), act = b.action, store = await db();

    if (act === 'login') {
      const name = String(b.username || '').trim().toLowerCase(), pw = String(b.password || '');
      const key = name + '|' + (req.headers['x-forwarded-for'] || '').split(',')[0];
      if (tooMany(key)) return res.status(429).json({ error: 'Too many attempts. Wait 10 minutes and try again.' });
      if (!name || name === 'admin') {
        if (!adminPasswordOk(pw)) { failed(key); log('failed owner sign-in'); return res.status(401).json({ error: 'Wrong username or password.' }); }
        log('owner signed in'); return res.status(200).json({ token: signToken({ name: 'admin' }), user: { name: 'admin', admin: true, owner: true } });
      }
      const u = await store.get(`${USERS}/${name}`);
      if (!u || u.disabled || !checkPw(pw, u)) { failed(key); log('failed sign-in for', name); return res.status(401).json({ error: u && u.disabled ? 'This account is turned off. Ask the owner.' : 'Wrong username or password.' }); }
      await save(store, name, { ...u, lastLogin: new Date().toISOString() });
      log('signed in:', name);
      return res.status(200).json({ token: signToken({ name, hash: u.hash }), user: { name, admin: !!u.admin, owner: false } });
    }

    const P = await principal(req, store);
    if (!P) return res.status(401).json({ error: 'Not signed in.' });

    if (act === 'me') return res.status(200).json({ user: { name: P.name, admin: P.admin, owner: P.owner } });

    if (act === 'changePassword') {
      if (P.owner) return res.status(400).json({ error: 'The owner password is LEDGERLINE_PASSWORD. Change it in Vercel and redeploy.' });
      const u = await store.get(`${USERS}/${P.name}`);
      if (!checkPw(String(b.current || ''), u)) return res.status(400).json({ error: 'Your current password is wrong.' });
      const prob = pwProblem(b.next); if (prob) return res.status(400).json({ error: prob });
      const n = { ...u, ...hashPw(b.next) }; await save(store, P.name, n);
      log('password changed:', P.name);
      return res.status(200).json({ ok: true, token: signToken({ name: P.name, hash: n.hash }) });
    }

    if (!P.admin) return res.status(403).json({ error: 'Only an admin can manage users.' });

    if (act === 'users') {
      const rows = await store.list(USERS);
      return res.status(200).json({ users: [{ name: 'admin', admin: true, owner: true, disabled: false }, ...rows.map(r => pub(r.path.split('/').pop(), r.data))] });
    }
    const name = String(b.username || '').trim().toLowerCase();
    if (!validName(name)) return res.status(400).json({ error: 'Usernames are 2–32 characters: lowercase letters, numbers, dot, dash or underscore ("admin" is reserved).' });
    const cur = await store.get(`${USERS}/${name}`);

    if (act === 'createUser') {
      if (cur) return res.status(409).json({ error: 'That username is taken.' });
      const prob = pwProblem(b.password); if (prob) return res.status(400).json({ error: prob });
      await save(store, name, { ...hashPw(b.password), admin: !!b.admin, created: new Date().toISOString(), createdBy: P.name });
      log(P.name, 'created user', name);
      return res.status(200).json({ ok: true });
    }
    if (!cur) return res.status(404).json({ error: 'No user with that name.' });
    if (act === 'resetPassword') {
      const prob = pwProblem(b.password); if (prob) return res.status(400).json({ error: prob });
      await save(store, name, { ...cur, ...hashPw(b.password) }); log(P.name, 'reset password for', name);
      return res.status(200).json({ ok: true });
    }
    if (act === 'setUser') {
      if (name === P.name && b.admin === false) return res.status(400).json({ error: "You can't remove your own admin rights." });
      await save(store, name, { ...cur, ...(b.admin != null ? { admin: !!b.admin } : {}), ...(b.disabled != null ? { disabled: !!b.disabled } : {}) });
      return res.status(200).json({ ok: true });
    }
    if (act === 'deleteUser') {
      if (name === P.name) return res.status(400).json({ error: "You can't delete yourself." });
      await store.write([{ path: `${USERS}/${name}`, parent: USERS, data: null }]);
      if (b.deleteData) await store.dropScope({ lo: `u/${name}/`, hi: `u/${name}0` });
      log(P.name, 'deleted user', name, b.deleteData ? 'and their data' : '(data kept)');
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'Unknown action.' });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[ledgerline:auth]', err && err.code, err && err.message);
    return res.status(502).json({ error: 'The server could not reach the database. Check the Vercel logs.' });
  }
}
export { OWNER };
