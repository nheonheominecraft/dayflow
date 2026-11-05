'use strict';
const crypto = require('node:crypto'), dns = require('node:dns').promises, net = require('node:net');
const { HttpError } = require('./util');
const enc = (key, text) => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv), ct = Buffer.concat([c.update(text, 'utf8'), c.final()]); return [iv, c.getAuthTag(), ct].map(b => b.toString('base64')).join('.'); };
const dec = (key, s) => { if (!s) return null; const [iv, tag, ct] = s.split('.').map(x => Buffer.from(x, 'base64')), d = crypto.createDecipheriv('aes-256-gcm', key, iv); d.setAuthTag(tag); return Buffer.concat([d.update(ct), d.final()]).toString('utf8'); };
function privateIp(ip) {
  if (net.isIPv4(ip)) { const [a, b] = ip.split('.').map(Number); return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127); }
  const l = ip.toLowerCase(); return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || (l.startsWith('::ffff:') && privateIp(l.slice(7)));
}
async function checkUrl(u, cfg) {
  let x; try { x = new URL(u); } catch { throw new HttpError(400, 'Invalid base URL'); }
  if (x.protocol !== 'https:' && !(cfg.allowHttp && x.protocol === 'http:')) throw new HttpError(400, 'Base URL must use https');
  if (x.username || x.password) throw new HttpError(400, 'Base URL must not contain credentials');
  if (!cfg.allowPrivate) {
    const host = x.hostname.replace(/^\[|\]$/g, '');
    const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => { throw new HttpError(400, 'Cannot resolve the provider host'); });
    if (addrs.some(a => privateIp(a.address))) throw new HttpError(400, 'Provider host is a private or local address');
  }
  return x.href.replace(/\/+$/, '');
}
const mapStatus = (status, text, retry) => {
  if (status === 401 || status === 403) return new HttpError(400, 'The provider rejected the API key', { code: 'invalid_key' });
  if (status === 404 || (status === 400 && /model/i.test(text || ''))) return new HttpError(404, 'The provider does not have the selected model', { code: 'model_not_found' });
  if (status === 429) return new HttpError(429, 'The provider rate limit was reached', { code: 'rate_limited', retryAfter: retry || null });
  return new HttpError(502, 'The provider returned an error (' + status + ')', { code: 'provider_error' });
};
module.exports = function aiRoutes(db, cfg) {
  const row = (uid, id) => { const p = db.prepare('SELECT * FROM providers WHERE user_id=? AND id=?').get(uid, id); if (!p) throw new HttpError(404, 'Provider not found'); return p; };
  const pubP = p => ({ id: p.id, name: p.name, base_url: p.base_url, model: p.model, mname: p.mname, hasKey: !!p.key_enc, price_in: p.price_in, price_out: p.price_out, verified: !!p.verified, is_default: !!p.is_default });
  async function upstream(p, path, init = {}) {
    const base = await checkUrl(p.base_url, cfg), key = dec(cfg.masterKey, p.key_enc);
    if (!key) throw new HttpError(400, 'No API key is saved for this provider', { code: 'no_key' });
    try { return await fetch(base + path, { ...init, redirect: 'error', headers: { ...init.headers, authorization: 'Bearer ' + key, 'user-agent': 'DayFlow/1.0' }, signal: init.signal || AbortSignal.timeout(60_000) }); }
    catch (e) { throw new HttpError(502, 'Could not reach the provider', { code: 'unreachable' }); }
  }
  async function fetchModels(p) {
    const r = await upstream(p, '/models');
    if (!r.ok) throw mapStatus(r.status, await r.text().catch(() => ''), r.headers.get('retry-after'));
    const j = await r.json().catch(() => ({})), arr = Array.isArray(j.data) ? j.data : Array.isArray(j) ? j : [];
    const models = arr.filter(m => m && typeof m.id === 'string').slice(0, 1000).map(m => ({ id: m.id, name: typeof m.name === 'string' ? m.name : m.id, ctx: Number(m.context_length || m.context_window) || null }));
    const verified = models.some(m => m.id === p.model) ? 1 : 0;
    db.prepare('UPDATE providers SET verified=? WHERE user_id=? AND id=?').run(verified, p.user_id, p.id);
    return { models, verified: !!verified };
  }
  const monthStart = () => { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); };
  const est = (p, pt, ct) => (p.price_in != null && p.price_out != null && pt != null && ct != null) ? pt / 1e6 * p.price_in + ct / 1e6 * p.price_out : null;
  function record(uid, p, model, usage, status) {
    const pt = usage && Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : null, ct = usage && Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : null;
    db.prepare('INSERT INTO ai_usage(user_id,ts,provider_id,model,prompt_tokens,completion_tokens,est_cost,status) VALUES(?,?,?,?,?,?,?,?)').run(uid, Date.now(), p.id, model, pt, ct, est(p, pt, ct), status);
  }
  function context(uid) {
    const recs = c => db.prepare('SELECT data FROM records WHERE user_id=? AND coll=? AND deleted=0').all(uid, c).map(r => JSON.parse(r.data));
    const today = new Date().toISOString().slice(0, 10), tasks = recs('tasks').filter(t => !t.done).sort((a, b) => String(a.d).localeCompare(String(b.d))).slice(0, 30);
    const events = recs('events').filter(e => e.date >= today).sort((a, b) => String(a.date).localeCompare(String(b.date))).slice(0, 20);
    return 'Read-only snapshot of the user\'s DayFlow data (today is ' + today + ').\nOpen tasks:\n' + (tasks.map(t => `- ${t.t} (due ${t.d}${t.tm ? ' ' + t.tm : ''}, ${t.p} priority)`).join('\n') || '- none') + '\nUpcoming events:\n' + (events.map(e => `- ${e.t} (${e.date} ${e.time || ''})`).join('\n') || '- none');
  }
  return {
    list: ctx => ({ providers: db.prepare('SELECT * FROM providers WHERE user_id=? ORDER BY rowid').all(ctx.auth.user.id).map(pubP) }),
    async put(id, b, ctx) {
      const uid = ctx.auth.user.id;
      if (!/^[\w-]{1,40}$/.test(id)) throw new HttpError(400, 'Invalid provider id');
      const name = String(b.name || '').trim(); if (!name || name.length > 60) throw new HttpError(400, 'Provider name must be 1-60 characters');
      const url = await checkUrl(String(b.url || ''), cfg), model = String(b.model || '').slice(0, 200), mname = String(b.mname || '').slice(0, 200);
      const price = v => v == null || v === '' ? null : (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : (() => { throw new HttpError(400, 'Prices must be non-negative numbers'); })());
      const ex = db.prepare('SELECT * FROM providers WHERE user_id=? AND id=?').get(uid, id);
      let keyEnc = ex ? ex.key_enc : null;
      if (typeof b.key === 'string' && b.key) { if (b.key.length > 500) throw new HttpError(400, 'API key is too long'); keyEnc = enc(cfg.masterKey, b.key.trim()); }
      else if (ex && ex.base_url !== url) keyEnc = null; // changing the endpoint drops the stored key so it cannot be redirected silently
      const verified = ex && ex.base_url === url && ex.model === model ? ex.verified : 0;
      db.tx(() => {
        if (b.is_default) db.prepare('UPDATE providers SET is_default=0 WHERE user_id=?').run(uid);
        db.prepare(`INSERT INTO providers(user_id,id,name,base_url,model,mname,key_enc,price_in,price_out,verified,is_default) VALUES(?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(user_id,id) DO UPDATE SET name=excluded.name,base_url=excluded.base_url,model=excluded.model,mname=excluded.mname,key_enc=excluded.key_enc,price_in=excluded.price_in,price_out=excluded.price_out,verified=excluded.verified,is_default=CASE WHEN ? THEN 1 ELSE providers.is_default END`)
          .run(uid, id, name, url, model, mname, keyEnc, price(b.price_in), price(b.price_out), verified, b.is_default ? 1 : 0, b.is_default ? 1 : 0);
      });
      return { provider: pubP(row(uid, id)) };
    },
    remove(id, ctx) {
      const uid = ctx.auth.user.id, n = db.prepare('SELECT COUNT(*) c FROM providers WHERE user_id=?').get(uid).c;
      if (n < 2) throw new HttpError(400, 'Keep at least one provider');
      const p = row(uid, id); db.prepare('DELETE FROM providers WHERE user_id=? AND id=?').run(uid, id);
      if (p.is_default) db.prepare('UPDATE providers SET is_default=1 WHERE rowid=(SELECT MIN(rowid) FROM providers WHERE user_id=?)').run(uid);
      return { ok: true };
    },
    async test(id, ctx) {
      const p = row(ctx.auth.user.id, id);
      try { const r = await fetchModels(p); return { ok: true, models: r.models.length, verified: r.verified }; }
      catch (e) { if (e instanceof HttpError && e.extra.code) return { ok: false, code: e.extra.code, message: e.message }; throw e; }
    },
    async models(id, ctx) { return fetchModels(row(ctx.auth.user.id, id)); },
    getSettings: ctx => db.prepare('SELECT monthly_limit,warn_pct FROM ai_settings WHERE user_id=?').get(ctx.auth.user.id) || { monthly_limit: null, warn_pct: 80 },
    putSettings(b, ctx) {
      const lim = b.monthly_limit == null || b.monthly_limit === '' ? null : Number(b.monthly_limit), warn = Math.round(Number(b.warn_pct ?? 80));
      if ((lim !== null && !(lim >= 0)) || !(warn >= 1 && warn <= 100)) throw new HttpError(400, 'Invalid limit or warning percentage');
      db.prepare('INSERT INTO ai_settings VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET monthly_limit=excluded.monthly_limit,warn_pct=excluded.warn_pct').run(ctx.auth.user.id, lim, warn);
      return { monthly_limit: lim, warn_pct: warn };
    },
    usage(query, ctx) {
      const uid = ctx.auth.user.id, m = query.get('month') || new Date().toISOString().slice(0, 7);
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw new HttpError(400, 'month must be YYYY-MM');
      const [y, mo] = m.split('-').map(Number), a = Date.UTC(y, mo - 1, 1), b = Date.UTC(y, mo, 1);
      const rows = db.prepare('SELECT model,provider_id,COUNT(*) n,SUM(prompt_tokens) pt,SUM(completion_tokens) ct,SUM(est_cost) cost,SUM(CASE WHEN est_cost IS NULL THEN 1 ELSE 0 END) unpriced FROM ai_usage WHERE user_id=? AND ts>=? AND ts<? GROUP BY model,provider_id').all(uid, a, b);
      const s = db.prepare('SELECT monthly_limit,warn_pct FROM ai_settings WHERE user_id=?').get(uid) || { monthly_limit: null, warn_pct: 80 };
      const sum = k => rows.reduce((t, r) => t + (r[k] || 0), 0);
      return { month: m, requests: sum('n'), prompt_tokens: sum('pt'), completion_tokens: sum('ct'), est_cost: sum('cost'), unpriced_requests: sum('unpriced'), by_model: rows, limit: s.monthly_limit, warn_pct: s.warn_pct,
        note: 'Cost is only estimated for requests where the provider returned token usage and you entered a price for the provider.' };
    },
    async chat(b, req, res, ctx) {
      const uid = ctx.auth.user.id, p = row(uid, String(b.provider || ''));
      const model = typeof b.model === 'string' && b.model ? b.model : p.model;
      if (!model) throw new HttpError(400, 'No model selected', { code: 'no_model' });
      const msgs = b.messages;
      if (!Array.isArray(msgs) || !msgs.length || msgs.length > 60 || msgs.some(m => !m || !['system', 'user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || m.content.length > 30_000)) throw new HttpError(400, 'Invalid messages');
      const s = db.prepare('SELECT monthly_limit FROM ai_settings WHERE user_id=?').get(uid);
      if (s && s.monthly_limit > 0 && p.price_in != null && p.price_out != null && !b.confirmOverLimit) {
        const spent = db.prepare('SELECT COALESCE(SUM(est_cost),0) c FROM ai_usage WHERE user_id=? AND ts>=?').get(uid, monthStart()).c;
        if (spent >= s.monthly_limit) throw new HttpError(402, 'Your monthly spending limit has been reached', { code: 'limit_reached', spent, limit: s.monthly_limit });
      }
      const messages = b.context ? [{ role: 'system', content: context(uid) }, ...msgs] : msgs, stream = !!b.stream;
      const ctl = new AbortController(); res.on('close', () => { if (!res.writableEnded) ctl.abort(); });
      let r;
      try { r = await upstream(p, '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctl.signal, body: JSON.stringify({ model, messages, stream, ...(stream ? { stream_options: { include_usage: true } } : {}) }) }); }
      catch (e) { record(uid, p, model, null, 'error'); throw e; }
      if (!r.ok) { record(uid, p, model, null, 'error'); throw mapStatus(r.status, await r.text().catch(() => ''), r.headers.get('retry-after')); }
      if (!stream) {
        const j = await r.json().catch(() => null); if (!j) { record(uid, p, model, null, 'error'); throw new HttpError(502, 'The provider returned an unreadable response', { code: 'provider_error' }); }
        record(uid, p, model, j.usage, 'ok');
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(JSON.stringify({ content: j.choices?.[0]?.message?.content ?? '', model: j.model || model, usage: j.usage || null }));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
      let tail = '', usage = null;
      try {
        for await (const chunk of r.body) {
          res.write(chunk); tail += Buffer.from(chunk).toString('utf8');
          const lines = tail.split('\n'); tail = lines.pop();
          for (const l of lines) if (l.startsWith('data: ') && l.includes('"usage"')) { try { const u = JSON.parse(l.slice(6)).usage; if (u) usage = u; } catch {} }
        }
        record(uid, p, model, usage, 'ok');
      } catch (e) { record(uid, p, model, usage, 'aborted'); res.write('data: ' + JSON.stringify({ error: 'The stream was interrupted' }) + '\n\n'); }
      res.end();
    },
  };
};
module.exports.checkUrl = checkUrl;
module.exports.dec = dec;
module.exports.enc = enc;
