'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('node:crypto');
const { openDb } = require('./db'), { authRoutes, authenticate } = require('./auth'), syncRoutes = require('./sync'), aiRoutes = require('./ai'), fileRoutes = require('./files');
const { HttpError, send, readJson } = require('./util');

function loadConfig(env = process.env) {
  const dataDir = path.resolve(env.DAYFLOW_DATA_DIR || path.join(__dirname, '..', 'data'));
  fs.mkdirSync(dataDir, { recursive: true });
  let hex = env.DAYFLOW_MASTER_KEY;
  if (!hex) {
    const f = path.join(dataDir, 'master.key');
    if (!fs.existsSync(f)) { fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 }); console.warn('[dayflow] No DAYFLOW_MASTER_KEY set. Generated data/master.key. Back it up: without it stored API keys cannot be decrypted.'); }
    hex = fs.readFileSync(f, 'utf8').trim();
  }
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('DAYFLOW_MASTER_KEY must be 64 hex characters (32 bytes)');
  return { dataDir, masterKey: Buffer.from(hex, 'hex'), port: Number(env.PORT || 8787), allowPrivate: env.DAYFLOW_ALLOW_PRIVATE === '1', allowHttp: env.DAYFLOW_ALLOW_HTTP === '1',
    devReset: env.DAYFLOW_DEV_RESET === '1', trustProxy: env.DAYFLOW_TRUST_PROXY === '1', corsOrigins: (env.DAYFLOW_CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean), publicDir: path.join(__dirname, '..', 'public') };
}
function createServer(cfg) {
  const db = openDb(cfg.dataDir), files = fileRoutes(db, cfg.dataDir), auth = authRoutes(db, cfg, files.deleteUserFiles), sync = syncRoutes(db), ai = aiRoutes(db, cfg);
  const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'";
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x'), p = url.pathname, m = req.method;
    const ip = cfg.trustProxy ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress : req.socket.remoteAddress;
    const origin = req.headers.origin;
    if (origin && cfg.corsOrigins.includes(origin)) { res.setHeader('access-control-allow-origin', origin); res.setHeader('vary', 'origin'); res.setHeader('access-control-allow-headers', 'authorization,content-type,x-filename'); res.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS'); }
    if (m === 'OPTIONS') { res.writeHead(204); return res.end(); }
    res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('referrer-policy', 'no-referrer');
    try {
      if (m === 'GET' && (p === '/' || p === '/index.html')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP, 'cache-control': 'no-cache' }); return res.end(fs.readFileSync(path.join(cfg.publicDir, 'index.html'))); }
      if (!p.startsWith('/api/')) throw new HttpError(404, 'Not found');
      if (p === '/api/health') return send(res, 200, { ok: true });
      const ctx = { ip };
      const open = { 'POST /api/auth/register': 'register', 'POST /api/auth/login': 'login', 'POST /api/auth/forgot': 'forgot', 'POST /api/auth/reset': 'reset' }[m + ' ' + p];
      if (open) return send(res, 200, await auth[open](await readJson(req, 20_000), ctx));
      ctx.auth = authenticate(db, req);
      let mt;
      if (m === 'POST' && p === '/api/auth/logout') return send(res, 200, auth.logout(ctx));
      if (m === 'GET' && p === '/api/auth/me') return send(res, 200, auth.me(ctx));
      if (m === 'DELETE' && p === '/api/account') return send(res, 200, await auth.deleteAccount(await readJson(req, 20_000), ctx));
      if (m === 'GET' && p === '/api/account/export') return send(res, 200, auth.exportData(ctx), { 'content-disposition': 'attachment; filename="dayflow-export.json"' });
      if (m === 'POST' && p === '/api/sync/push') return send(res, 200, sync.push(await readJson(req, 5_000_000), ctx));
      if (m === 'GET' && p === '/api/sync/pull') return send(res, 200, sync.pull(url.searchParams, ctx));
      if (m === 'GET' && p === '/api/ai/providers') return send(res, 200, ai.list(ctx));
      if ((mt = /^\/api\/ai\/providers\/([\w-]+)(\/test|\/models)?$/.exec(p))) {
        if (m === 'PUT' && !mt[2]) return send(res, 200, await ai.put(mt[1], await readJson(req, 20_000), ctx));
        if (m === 'DELETE' && !mt[2]) return send(res, 200, ai.remove(mt[1], ctx));
        if (m === 'POST' && mt[2] === '/test') return send(res, 200, await ai.test(mt[1], ctx));
        if (m === 'GET' && mt[2] === '/models') return send(res, 200, await ai.models(mt[1], ctx));
      }
      if (p === '/api/ai/settings') return send(res, 200, m === 'PUT' ? ai.putSettings(await readJson(req, 5_000), ctx) : ai.getSettings(ctx));
      if (m === 'GET' && p === '/api/ai/usage') return send(res, 200, ai.usage(url.searchParams, ctx));
      if (m === 'POST' && p === '/api/ai/chat') return await ai.chat(await readJson(req, 1_000_000), req, res, ctx);
      if (m === 'POST' && p === '/api/files') return send(res, 200, await files.upload(req, url.searchParams, ctx));
      if (m === 'GET' && p === '/api/files') return send(res, 200, files.list(url.searchParams, ctx));
      if ((mt = /^\/api\/files\/([0-9a-f-]{36})$/.exec(p))) {
        if (m === 'GET') return files.download(mt[1], res, ctx);
        if (m === 'DELETE') return send(res, 200, files.remove(mt[1], ctx));
      }
      throw new HttpError(404, 'Not found');
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error('[dayflow] internal error:', e && e.message);
      if (res.headersSent) return res.end();
      send(res, status, { error: status === 500 ? 'Something went wrong on the server' : e.message, ...(e.extra || {}) });
    }
  });
  server.db = db;
  return server;
}
module.exports = { loadConfig, createServer };
if (require.main === module) {
  const cfg = loadConfig(); createServer(cfg).listen(cfg.port, () => console.log(`DayFlow server listening on http://localhost:${cfg.port}`));
}
