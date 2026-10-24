// Ledgerline storage API (Vercel serverless function).
// Every create/read/update/delete runs here, against the database at process.env.DATABASE_URL.
// PostgreSQL (postgres://, postgresql://) uses the `pg` driver; MySQL/MariaDB (mysql://, mariadb://) uses `mysql2`.
// Access needs the password in process.env.LEDGERLINE_PASSWORD, sent by the page as the x-ledgerline-key header.
import { createHash, timingSafeEqual } from 'node:crypto';

const MAX_DOC_BYTES = 2_000_000; // per document (screenshots are stored inline as data URLs)
const MAX_PAGE_BYTES = 3_000_000; // keeps responses under Vercel's 4.5 MB limit
const PAGE_ROWS = 300;
const TABLE = 'ledgerline_docs';

const log = (...a) => console.log('[ledgerline]', ...a);
const dbUrl = () => process.env.DATABASE_URL || '';
const isMySQL = () => /^(mysql|mariadb):\/\//i.test(dbUrl());

/* ---------------- database adapters ---------------- */
let adapterPromise = null;

async function postgresAdapter() {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: dbUrl(), max: 3, connectionTimeoutMillis: 8000, idleTimeoutMillis: 10000 });
  pool.on('error', err => console.error('[ledgerline] idle database client error:', err.message));
  const q = (text, params) => pool.query(text, params).then(r => r.rows);
  await q(`create table if not exists ${TABLE} (
    path text primary key,
    parent text not null,
    data jsonb,
    deleted boolean not null default false,
    updated_at timestamptz not null default clock_timestamp()
  )`);
  await q(`create index if not exists ${TABLE}_updated_at on ${TABLE} (updated_at)`);
  return {
    kind: 'postgres',
    ping: () => q('select 1'),
    now: async () => new Date((await q('select clock_timestamp() as now'))[0].now).toISOString(),
    page: (after) => q(`select path, data from ${TABLE} where not deleted and path collate "C" > $1 order by path collate "C" limit ${PAGE_ROWS}`, [after]),
    since: (iso, exact) => q(`select path, data, deleted, updated_at from ${TABLE} where updated_at ${exact ? '>= $1::timestamptz' : "> $1::timestamptz - interval '15 seconds'"} order by updated_at, path collate "C" limit ${PAGE_ROWS}`, [iso])
      .then(rows => rows.map(r => ({ ...r, updated_at: new Date(r.updated_at).toISOString() }))),
    write: async ops => {
      const client = await pool.connect();
      try {
        await client.query('begin');
        for (const op of ops) {
          if (op.data === null) await client.query(`update ${TABLE} set data = null, deleted = true, updated_at = clock_timestamp() where path = $1`, [op.path]);
          else await client.query(`insert into ${TABLE} (path, parent, data, deleted, updated_at) values ($1, $2, $3::jsonb, false, clock_timestamp())
            on conflict (path) do update set data = excluded.data, deleted = false, updated_at = clock_timestamp()`, [op.path, op.parent, JSON.stringify(op.data)]);
        }
        await client.query('commit');
      } catch (err) { await client.query('rollback').catch(() => {}); throw err; }
      finally { client.release(); }
    }
  };
}

async function mysqlAdapter() {
  const { default: mysql } = await import('mysql2/promise');
  const pool = mysql.createPool({ uri: dbUrl(), connectionLimit: 3, connectTimeout: 8000, dateStrings: true, timezone: 'Z', supportBigNumbers: true });
  const q = (sql, params) => pool.query(sql, params).then(([rows]) => rows);
  const toIso = s => String(s).replace(' ', 'T') + 'Z';
  const toSql = iso => new Date(iso).toISOString().replace('T', ' ').replace('Z', '');
  const parse = v => v == null ? null : typeof v === 'string' ? JSON.parse(v) : v;
  await q(`create table if not exists ${TABLE} (
    path varchar(1000) character set ascii collate ascii_bin not null primary key,
    parent varchar(1000) character set ascii collate ascii_bin not null,
    data longtext,
    deleted tinyint(1) not null default 0,
    updated_at datetime(6) not null,
    index ${TABLE}_updated_at (updated_at)
  ) character set utf8mb4`);
  return {
    kind: 'mysql',
    ping: () => q('select 1'),
    now: async () => toIso((await q('select utc_timestamp(6) as now'))[0].now),
    page: async (after) => (await q(`select path, data from ${TABLE} where deleted = 0 and path > ? order by path limit ${PAGE_ROWS}`, [after])).map(r => ({ path: r.path, data: parse(r.data) })),
    since: async (iso, exact) => (await q(`select path, data, deleted, updated_at from ${TABLE} where updated_at ${exact ? '>= ?' : '> (? - interval 15 second)'} order by updated_at, path limit ${PAGE_ROWS}`, [toSql(iso)]))
      .map(r => ({ path: r.path, data: parse(r.data), deleted: !!r.deleted, updated_at: toIso(r.updated_at) })),
    write: async ops => {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        for (const op of ops) {
          if (op.data === null) await conn.query(`update ${TABLE} set data = null, deleted = 1, updated_at = utc_timestamp(6) where path = ?`, [op.path]);
          else await conn.query(`insert into ${TABLE} (path, parent, data, deleted, updated_at) values (?, ?, ?, 0, utc_timestamp(6))
            on duplicate key update data = values(data), deleted = 0, updated_at = utc_timestamp(6)`, [op.path, op.parent, JSON.stringify(op.data)]);
        }
        await conn.commit();
      } catch (err) { await conn.rollback().catch(() => {}); throw err; }
      finally { conn.release(); }
    }
  };
}

function db() {
  if (!dbUrl()) throw Object.assign(new Error('DATABASE_URL is not set in the Vercel project.'), { status: 503 });
  if (!adapterPromise) {
    adapterPromise = (isMySQL() ? mysqlAdapter() : postgresAdapter())
      .then(a => { log(`connected to ${a.kind} database`); return a; })
      .catch(err => { adapterPromise = null; throw err; });
  }
  return adapterPromise;
}

/* Turn driver errors into a message the journal owner can act on (shown only after sign-in). */
function explain(err) {
  const c = err && (err.code || err.errno);
  const where = (() => { try { const u = new URL(dbUrl()); return `${u.hostname}:${u.port || (isMySQL() ? 3306 : 5432)}`; } catch (e) { return 'the database'; } })();
  if (c === 'ECONNREFUSED') return `Connection to ${where} was refused. Check that the database container is running and the port is forwarded on your router.`;
  if (c === 'ETIMEDOUT' || c === 'ESOCKETTIMEDOUT' || /timeout/i.test(err && err.message || '')) return `Connecting to ${where} timed out. The port isn't reachable from the internet: check port forwarding and the NAS firewall.`;
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return `The host in DATABASE_URL (${where}) couldn't be found. Use your public IP address or a DDNS name.`;
  if (c === '28P01' || c === '28000' || c === 'ER_ACCESS_DENIED_ERROR' || c === 1045) return 'The database rejected the username or password in DATABASE_URL.';
  if (c === '3D000' || c === 'ER_BAD_DB_ERROR' || c === 1049) return 'The database name in DATABASE_URL does not exist on the server.';
  if (c === 'ECONNRESET' || /ssl|tls/i.test(err && err.message || '')) return `The connection to ${where} was dropped, often an SSL mismatch. Add ?sslmode=disable (PostgreSQL) or remove SSL options if your NAS database has no certificate.`;
  if (c === '42501' || c === 'ER_TABLEACCESS_DENIED_ERROR' || c === 1142) return 'The database user is not allowed to create or change tables.';
  return `The database request failed (${c || (err && err.message) || 'unknown error'}).`;
}

/* ---------------- request handling ---------------- */
const digest = s => createHash('sha256').update(String(s)).digest();
function authorized(req) {
  const want = process.env.LEDGERLINE_PASSWORD;
  const got = req.headers['x-ledgerline-key'];
  return !!want && typeof got === 'string' && got.length > 0 && timingSafeEqual(digest(got), digest(want));
}
const PATH_RE = /^(?!\.\.?(?:\/|$))[A-Za-z0-9_\-.~:@+]{1,200}(?:\/(?!\.\.?(?:\/|$))[A-Za-z0-9_\-.~:@+]{1,200}){1,15}$/;
const validPath = p => typeof p === 'string' && p.length <= 1000 && PATH_RE.test(p) && p.split('/').length % 2 === 0;
const parentOf = p => p.split('/').slice(0, -1).join('/');
function capPage(rows, toEntry) {
  const out = []; let bytes = 0;
  for (const r of rows) {
    const size = r.data == null ? 0 : JSON.stringify(r.data).length;
    if (out.length && bytes + size > MAX_PAGE_BYTES) break;
    out.push(toEntry(r)); bytes += size;
  }
  return out;
}
async function readBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) return JSON.parse(String(req.body) || '{}');
  const chunks = []; for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const q = req.query || Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  try {
    if (req.method === 'GET' && q.probe) {
      return res.status(200).json({ backend: true, configured: { db: !!dbUrl(), password: !!process.env.LEDGERLINE_PASSWORD } });
    }
    if (!process.env.LEDGERLINE_PASSWORD) return res.status(503).json({ error: 'LEDGERLINE_PASSWORD is not set in the Vercel project.' });
    if (!authorized(req)) { log('rejected request with a wrong password'); return res.status(401).json({ error: 'Wrong password.' }); }

    const store = await db();

    if (q.check) { await store.ping(); return res.status(200).json({ ok: true, database: store.kind }); }

    if (req.method === 'GET' && q.since) {
      const since = new Date(q.since);
      if (isNaN(since)) return res.status(400).json({ error: 'Bad cursor.' });
      const now = await store.now();
      const rows = await store.since(since.toISOString(), !!q.exact);
      const page = capPage(rows, r => [r.path, r.deleted ? null : r.data]);
      const more = page.length < rows.length || rows.length === PAGE_ROWS;
      return res.status(200).json({ changes: page, cursor: more ? rows[page.length - 1].updated_at : now, more });
    }

    if (req.method === 'GET') {
      const after = typeof q.after === 'string' ? q.after : '';
      const now = await store.now();
      const rows = await store.page(after);
      const page = capPage(rows, r => [r.path, r.data]);
      const next = page.length < rows.length || rows.length === PAGE_ROWS ? page[page.length - 1][0] : null;
      if (!after) log(`loaded journal (${rows.length}${next ? '+' : ''} documents)`);
      return res.status(200).json({ docs: page, next, cursor: now });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const ops = Array.isArray(body.ops) ? body.ops : null;
      if (!ops || !ops.length || ops.length > 500) return res.status(400).json({ error: 'Send between 1 and 500 operations.' });
      for (const op of ops) {
        if (!validPath(op.path)) return res.status(400).json({ error: `Invalid path: ${String(op.path).slice(0, 80)}` });
        if (op.data !== null && (typeof op.data !== 'object' || Array.isArray(op.data))) return res.status(400).json({ error: 'Each document must be a JSON object or null.' });
        if (op.data !== null && JSON.stringify(op.data).length > MAX_DOC_BYTES) return res.status(413).json({ error: 'A document is too large (over 2 MB).' });
      }
      await store.write(ops.map(op => ({ path: op.path, parent: parentOf(op.path), data: op.data })));
      const dels = ops.filter(o => o.data === null).length;
      log(`saved ${ops.length - dels} and deleted ${dels} document(s)`);
      return res.status(200).json({ ok: true, count: ops.length });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('[ledgerline] database error:', err && err.code, err && err.message);
    return res.status(502).json({ error: explain(err) });
  }
}
