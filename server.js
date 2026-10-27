/**
 * ClipNote — 多端互通的剪切板 & 笔记本
 * 技术栈: Node.js + Express + PostgreSQL
 * 部署: Render (Web Service + PostgreSQL)
 *
 * 环境变量:
 *   DATABASE_URL  PostgreSQL 连接串（Render 会自动注入）
 *   ACCESS_CODE   访问码，保护你的数据；不设置则为开放模式
 *   PORT          监听端口（Render 自动注入）
 */
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL || '';
const ACCESS_CODE = process.env.ACCESS_CODE || '';
const COOKIE_NAME = 'cn_auth';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 天
const MAX_CLIP = 200000;  // 单条剪切板 200KB
const MAX_NOTE = 1000000; // 单条笔记 1MB

/* ---------------- 数据库 ---------------- */
let dbReady = false;
const isLocalDb = /localhost|127\.0\.0\.1/.test(DATABASE_URL);
const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: isLocalDb ? undefined : { rejectUnauthorized: false },
      max: 5,
    })
  : null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS clips (
  id         SERIAL PRIMARY KEY,
  content    TEXT NOT NULL,
  pinned     BOOLEAN NOT NULL DEFAULT FALSE,
  device     TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS notes (
  id         SERIAL PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT '',
  content    TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS clips_created_idx ON clips (created_at DESC);
CREATE INDEX IF NOT EXISTS notes_updated_idx ON notes (updated_at DESC);
`;

async function initDb() {
  if (!pool) {
    console.warn('[db] 未设置 DATABASE_URL，数据接口暂不可用');
    return;
  }
  try {
    await pool.query(SCHEMA);
    dbReady = true;
    console.log('[db] 数据库就绪');
  } catch (err) {
    dbReady = false;
    console.error('[db] 初始化失败，5 秒后重试:', err.message);
    setTimeout(initDb, 5000);
  }
}
initDb();

/* ---------------- 鉴权 ---------------- */
const secret = ACCESS_CODE
  ? crypto.createHash('sha256').update('clipnote|' + ACCESS_CODE).digest()
  : null;

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function makeToken() {
  const payload = String(Date.now() + SESSION_TTL_MS);
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return payload + '.' + sig;
}

function isValidToken(token) {
  if (!secret || typeof token !== 'string') return false;
  const i = token.lastIndexOf('.');
  if (i < 1) return false;
  const payload = token.slice(0, i);
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(payload).digest('base64url'));
  const got = Buffer.from(token.slice(i + 1));
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) return false;
  const exp = Number(payload);
  return Number.isFinite(exp) && Date.now() < exp;
}

// 登录失败限速：每 IP 连续失败 10 次锁定 15 分钟
const loginFails = new Map();
function isLimited(ip) {
  const rec = loginFails.get(ip);
  return !!rec && rec.until > Date.now();
}
function recordFail(ip) {
  const rec = loginFails.get(ip) || { count: 0, until: 0 };
  rec.count += 1;
  if (rec.count >= 10) {
    rec.until = Date.now() + 15 * 60 * 1000;
    rec.count = 0;
  }
  loginFails.set(ip, rec);
}

function requireAuth(req, res, next) {
  // 未设置 ACCESS_CODE = 开放模式（仅建议临时测试用）
  if (!ACCESS_CODE) return next();
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (isValidToken(token)) return next();
  res.status(401).json({ error: 'unauthorized' });
}

function dbGuard(req, res, next) {
  if (!dbReady) return res.status(503).json({ error: '数据库尚未就绪，请稍后重试' });
  next();
}

/* ---------------- 应用 ---------------- */
const app = express();
app.enable('trust proxy');
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const clientIp = (req) =>
  (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '?';

app.post('/api/login', (req, res) => {
  if (!ACCESS_CODE) return res.json({ ok: true, open: true });
  const ip = clientIp(req);
  if (isLimited(ip)) return res.status(429).json({ error: '尝试过于频繁，请 15 分钟后再试' });
  const code = String((req.body && req.body.code) || '');
  const a = crypto.createHash('sha256').update(code).digest();
  const b = crypto.createHash('sha256').update(ACCESS_CODE).digest();
  if (code.length !== ACCESS_CODE.length || !crypto.timingSafeEqual(a, b)) {
    recordFail(ip);
    return res.status(401).json({ error: '访问码错误' });
  }
  loginFails.delete(ip);
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.cookie(COOKIE_NAME, makeToken(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: isHttps,
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

/* ---------------- 剪切板 ---------------- */
app.get('/api/data', requireAuth, dbGuard, async (req, res) => {
  try {
    const [clips, notes] = await Promise.all([
      pool.query(
        'SELECT id, content, pinned, device, created_at FROM clips ORDER BY pinned DESC, created_at DESC LIMIT 200'
      ),
      pool.query(
        'SELECT id, title, updated_at FROM notes ORDER BY updated_at DESC LIMIT 500'
      ),
    ]);
    res.json({ clips: clips.rows, notes: notes.rows, serverTime: Date.now() });
  } catch (e) {
    console.error('[api] /api/data:', e.message);
    res.status(500).json({ error: '读取失败' });
  }
});

app.post('/api/clips', requireAuth, dbGuard, async (req, res) => {
  const content = String((req.body && req.body.content) || '');
  const device = String((req.body && req.body.device) || '').slice(0, 64);
  if (!content.trim()) return res.status(400).json({ error: '内容不能为空' });
  if (content.length > MAX_CLIP) return res.status(413).json({ error: '单条内容超过 200KB 限制' });
  try {
    const r = await pool.query(
      'INSERT INTO clips (content, device) VALUES ($1, $2) RETURNING id, content, pinned, device, created_at',
      [content, device]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    console.error('[api] POST /api/clips:', e.message);
    res.status(500).json({ error: '保存失败' });
  }
});

app.patch('/api/clips/:id', requireAuth, dbGuard, async (req, res) => {
  const pinned = !!(req.body && req.body.pinned);
  try {
    const r = await pool.query('UPDATE clips SET pinned = $1 WHERE id = $2 RETURNING id', [
      pinned,
      req.params.id,
    ]);
    if (!r.rows.length) return res.status(404).json({ error: '内容不存在' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: '操作失败' });
  }
});

app.delete('/api/clips/:id', requireAuth, dbGuard, async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM clips WHERE id = $1', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: '内容不存在' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: '删除失败' });
  }
});

/* ---------------- 笔记本 ---------------- */
app.get('/api/notes/:id', requireAuth, dbGuard, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, title, content, created_at, updated_at FROM notes WHERE id = $1',
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: '笔记不存在' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: '读取失败' });
  }
});

app.post('/api/notes', requireAuth, dbGuard, async (req, res) => {
  const title = String((req.body && req.body.title) || '').slice(0, 200);
  const content = String((req.body && req.body.content) || '');
  if (!title.trim() && !content.trim()) return res.status(400).json({ error: '标题和内容不能同时为空' });
  if (content.length > MAX_NOTE) return res.status(413).json({ error: '内容超过 1MB 限制' });
  try {
    const r = await pool.query(
      'INSERT INTO notes (title, content) VALUES ($1, $2) RETURNING id, title, created_at, updated_at',
      [title, content]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    console.error('[api] POST /api/notes:', e.message);
    res.status(500).json({ error: '保存失败' });
  }
});

app.put('/api/notes/:id', requireAuth, dbGuard, async (req, res) => {
  const title = String((req.body && req.body.title) || '').slice(0, 200);
  const content = String((req.body && req.body.content) || '');
  if (!title.trim() && !content.trim()) return res.status(400).json({ error: '标题和内容不能同时为空' });
  if (content.length > MAX_NOTE) return res.status(413).json({ error: '内容超过 1MB 限制' });
  try {
    const r = await pool.query(
      'UPDATE notes SET title = $1, content = $2, updated_at = NOW() WHERE id = $3 RETURNING id, title, updated_at',
      [title, content, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: '笔记不存在' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: '保存失败' });
  }
});

app.delete('/api/notes/:id', requireAuth, dbGuard, async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM notes WHERE id = $1', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: '笔记不存在' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: '删除失败' });
  }
});

/* ---------------- 健康检查 ---------------- */
app.get('/api/health', (req, res) => {
  res.json({ ok: true, db: dbReady, auth: !!ACCESS_CODE });
});

app.listen(PORT, () => {
  console.log(`ClipNote 已启动: http://localhost:${PORT}`);
  console.log(`访问码保护: ${ACCESS_CODE ? '已开启' : '未设置 ACCESS_CODE（开放模式，任何人都可访问！）'}`);
});

process.on('SIGTERM', async () => {
  try {
    if (pool) await pool.end();
  } catch (_) {}
  process.exit(0);
});
