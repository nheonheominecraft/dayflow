'use strict';
const crypto = require('node:crypto'), { promisify } = require('node:util');
const { HttpError, rateLimit, str } = require('./util');
const scrypt = promisify(crypto.scrypt);
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const SESSION_MS = 30 * 864e5;
const hashPw = async (pw, salt) => (await scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 })).toString('hex');
const DUMMY_SALT = crypto.randomBytes(16).toString('hex');
const pub = u => ({ id: u.id, email: u.email, username: u.username, created_at: u.created_at });
const checkPw = pw => { if (typeof pw !== 'string' || pw.length < 8 || pw.length > 200) throw new HttpError(400, 'Password must be 8-200 characters'); return pw; };
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
function mkSession(db, userId, device) {
  const token = crypto.randomBytes(32).toString('base64url'), now = Date.now();
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(sha(token), userId, String(device || '').slice(0, 80), now, now + SESSION_MS);
  return token;
}
function authenticate(db, req) {
  const m = /^Bearer (\S+)$/.exec(req.headers.authorization || '');
  if (!m) throw new HttpError(401, 'Sign in required');
  const s = db.prepare('SELECT * FROM sessions WHERE token_hash=?').get(sha(m[1]));
  if (!s || s.expires_at < Date.now()) throw new HttpError(401, 'Session expired. Please sign in again.');
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(s.user_id);
  if (!u) throw new HttpError(401, 'Sign in required');
  if (s.expires_at - Date.now() < SESSION_MS / 2) db.prepare('UPDATE sessions SET expires_at=? WHERE token_hash=?').run(Date.now() + SESSION_MS, s.token_hash);
  return { user: u, tokenHash: s.token_hash };
}
function authRoutes(db, cfg, deleteUserFiles) {
  return {
    async register(body, ctx) {
      rateLimit('reg:' + ctx.ip, 10, 60_000);
      const email = str(body.email, 3, 200, 'Email').toLowerCase(), username = str(body.username, 2, 40, 'Username');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address');
      checkPw(body.password);
      if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) throw new HttpError(409, 'An account with this email already exists');
      const salt = crypto.randomBytes(16).toString('hex'), id = crypto.randomUUID(), h = await hashPw(body.password, salt);
      db.tx(() => {
        db.prepare('INSERT INTO users(id,email,username,pw_hash,pw_salt,created_at) VALUES(?,?,?,?,?,?)').run(id, email, username, h, salt, Date.now());
        db.prepare('INSERT INTO providers(user_id,id,name,base_url,model,mname,is_default) VALUES(?,?,?,?,?,?,1)').run(id, 'vyceai', 'VyceAI', 'https://vyceai.com/v1', 'deepseek-v4.1', 'DeepSeek V4.1 Flash');
      });
      return { token: mkSession(db, id, body.device), user: pub(db.prepare('SELECT * FROM users WHERE id=?').get(id)) };
    },
    async login(body, ctx) {
      rateLimit('login:' + ctx.ip, 10, 60_000);
      const email = String(body.email || '').toLowerCase().trim(), u = db.prepare('SELECT * FROM users WHERE email=?').get(email);
      const h = await hashPw(String(body.password || '').slice(0, 200), u ? u.pw_salt : DUMMY_SALT);
      if (!u || !same(h, u.pw_hash)) throw new HttpError(401, 'Invalid email or password');
      return { token: mkSession(db, u.id, body.device), user: pub(u) };
    },
    logout(ctx) { db.prepare('DELETE FROM sessions WHERE token_hash=?').run(ctx.auth.tokenHash); return { ok: true }; },
    me(ctx) {
      const n = db.prepare('SELECT COUNT(*) c FROM records WHERE user_id=? AND deleted=0').get(ctx.auth.user.id).c;
      return { user: pub(ctx.auth.user), recordCount: n };
    },
    async forgot(body, ctx) {
      rateLimit('forgot:' + ctx.ip, 5, 600_000);
      const u = db.prepare('SELECT id FROM users WHERE email=?').get(String(body.email || '').toLowerCase().trim());
      const out = { ok: true, message: 'If that account exists, a reset code has been issued.' };
      if (u) {
        const token = crypto.randomBytes(24).toString('base64url');
        db.prepare('INSERT INTO resets VALUES(?,?,?)').run(sha(token), u.id, Date.now() + 3600_000);
        if (cfg.devReset) out.devToken = token; // Email delivery is NOT implemented; dev mode exposes the code for testing.
      }
      return out;
    },
    async reset(body, ctx) {
      rateLimit('reset:' + ctx.ip, 10, 600_000);
      checkPw(body.password);
      const r = db.prepare('SELECT * FROM resets WHERE token_hash=?').get(sha(String(body.token || '')));
      if (!r || r.expires_at < Date.now()) throw new HttpError(400, 'Reset code is invalid or expired');
      const salt = crypto.randomBytes(16).toString('hex'), h = await hashPw(body.password, salt);
      db.tx(() => {
        db.prepare('UPDATE users SET pw_hash=?, pw_salt=? WHERE id=?').run(h, salt, r.user_id);
        db.prepare('DELETE FROM sessions WHERE user_id=?').run(r.user_id);
        db.prepare('DELETE FROM resets WHERE user_id=?').run(r.user_id);
      });
      return { ok: true };
    },
    async deleteAccount(body, ctx) {
      const u = ctx.auth.user, h = await hashPw(String(body.password || '').slice(0, 200), u.pw_salt);
      if (!same(h, u.pw_hash)) throw new HttpError(403, 'Password is incorrect');
      deleteUserFiles(u.id);
      db.prepare('DELETE FROM users WHERE id=?').run(u.id);
      return { ok: true };
    },
    exportData(ctx) {
      const id = ctx.auth.user.id, all = (sql, ...a) => db.prepare(sql).all(...a);
      return {
        exported_at: new Date().toISOString(), user: pub(ctx.auth.user),
        records: all('SELECT coll,id,version,updated_at,data FROM records WHERE user_id=? AND deleted=0', id).map(r => ({ ...r, data: JSON.parse(r.data) })),
        providers: all('SELECT id,name,base_url,model,mname,price_in,price_out,verified,is_default FROM providers WHERE user_id=?', id),
        ai_settings: db.prepare('SELECT monthly_limit,warn_pct FROM ai_settings WHERE user_id=?').get(id) || null,
        ai_usage: all('SELECT ts,provider_id,model,prompt_tokens,completion_tokens,est_cost,status FROM ai_usage WHERE user_id=?', id),
        files: all('SELECT id,name,mime,size,owner,created_at FROM files WHERE user_id=?', id),
        note: 'API keys are never exported.',
      };
    },
  };
}
module.exports = { authRoutes, authenticate };
