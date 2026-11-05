'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { loadConfig, createServer } = require('../server/index');
const { checkUrl } = require('../server/ai');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dayflow-test-'));
const calls = [];
const mock = http.createServer((req, res) => {
  let body = ''; req.on('data', d => body += d); req.on('end', () => {
    const auth = req.headers.authorization;
    if (auth !== 'Bearer good-key') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"bad key"}'); }
    if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'deepseek-v4.1', context_length: 64000 }, { id: 'other-model' }] })); }
    if (req.url === '/v1/chat/completions') {
      const b = JSON.parse(body); calls.push(b);
      if (b.model === 'missing-model') { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"error":"model missing"}'); }
      if (b.model === 'ratelimit-model') { res.writeHead(429, { 'retry-after': '7' }); return res.end('{}'); }
      if (b.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'); res.write('data: {"choices":[{"delta":{"content":" world"}}]}\n\n');
        res.write('data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n'); return res.end('data: [DONE]\n\n');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ model: b.model, choices: [{ message: { content: 'Hi there' } }], usage: { prompt_tokens: 1000000, completion_tokens: 0 } }));
    }
    res.writeHead(404); res.end();
  });
});
let srv, base, mockUrl, cfg;
const start = () => new Promise(r => { srv = createServer(cfg); srv.listen(0, '127.0.0.1', () => { base = 'http://127.0.0.1:' + srv.address().port; r(); }); });
const call = async (method, p, body, token, raw) => {
  const r = await fetch(base + p, { method, headers: { ...(body !== undefined && !raw ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}), ...(raw || {}) }, body: raw ? body : body !== undefined ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { s: r.status, j, r, t };
};
const A = {}, B = {};
test.before(async () => {
  await new Promise(r => mock.listen(0, '127.0.0.1', r)); mockUrl = 'http://127.0.0.1:' + mock.address().port + '/v1';
  cfg = loadConfig({ DAYFLOW_DATA_DIR: dir, DAYFLOW_ALLOW_HTTP: '1', DAYFLOW_ALLOW_PRIVATE: '1', DAYFLOW_DEV_RESET: '1' }); await start();
});
test.after(() => { srv.close(); mock.close(); srv.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('auth: validation, register, login, logout, hashing', async () => {
  assert.equal((await call('GET', '/api/health')).s, 200);
  assert.equal((await call('POST', '/api/auth/register', { email: 'bad', username: 'ab', password: 'longenough1' })).s, 400);
  assert.equal((await call('POST', '/api/auth/register', { email: 'a@x.com', username: 'ab', password: 'short' })).s, 400);
  let r = await call('POST', '/api/auth/register', { email: 'a@x.com', username: 'Alice', password: 'correct horse 1' }); assert.equal(r.s, 200); A.tok = r.j.token; A.id = r.j.user.id;
  assert.equal((await call('POST', '/api/auth/register', { email: 'A@x.com', username: 'Dup', password: 'correct horse 1' })).s, 409);
  r = await call('POST', '/api/auth/register', { email: 'b@x.com', username: 'Bob', password: 'another pass 22' }); B.tok = r.j.token; B.id = r.j.user.id;
  assert.equal((await call('GET', '/api/auth/me', undefined, A.tok)).j.user.email, 'a@x.com');
  assert.equal((await call('POST', '/api/auth/login', { email: 'a@x.com', password: 'wrong password' })).s, 401);
  r = await call('POST', '/api/auth/login', { email: 'a@x.com', password: 'correct horse 1' }); assert.equal(r.s, 200);
  const t2 = r.j.token; assert.equal((await call('POST', '/api/auth/logout', {}, t2)).s, 200); assert.equal((await call('GET', '/api/auth/me', undefined, t2)).s, 401);
  assert.equal((await call('GET', '/api/auth/me')).s, 401);
  const raw = srv.db.prepare('SELECT pw_hash,pw_salt FROM users WHERE id=?').get(A.id); assert.ok(!raw.pw_hash.includes('correct') && raw.pw_hash.length === 128);
  assert.equal(srv.db.prepare('SELECT COUNT(*) c FROM sessions WHERE token_hash=?').get(A.tok).c, 0, 'session tokens are stored hashed');
});

test('sync: push, pull, idempotency, conflict, delete, isolation', async () => {
  const task = { id: 1, t: 'Physics lab', done: false };
  let r = await call('POST', '/api/sync/push', { ops: [{ opId: 'o1', coll: 'tasks', id: '1', base: 0, data: task }] }, A.tok);
  assert.equal(r.j.results[0].status, 'ok'); assert.equal(r.j.results[0].version, 1);
  r = await call('POST', '/api/sync/push', { ops: [{ opId: 'o1', coll: 'tasks', id: '1', base: 0, data: task }] }, A.tok);
  assert.equal(r.j.results[0].dup, true); assert.equal(srv.db.prepare("SELECT COUNT(*) c FROM records WHERE user_id=? AND coll='tasks'").get(A.id).c, 1);
  let p = await call('GET', '/api/sync/pull?since=0', undefined, A.tok); assert.equal(p.j.records.length, 1); const seq1 = p.j.seq;
  r = await call('POST', '/api/sync/push', { ops: [{ opId: 'o2', coll: 'tasks', id: '1', base: 1, data: { ...task, t: 'Physics lab v2' } }] }, A.tok); assert.equal(r.j.results[0].version, 2);
  r = await call('POST', '/api/sync/push', { ops: [{ opId: 'o3', coll: 'tasks', id: '1', base: 1, data: { ...task, t: 'Other device edit' } }] }, A.tok);
  assert.equal(r.j.results[0].status, 'conflict'); assert.equal(r.j.results[0].server.data.t, 'Physics lab v2');
  assert.equal(srv.db.prepare("SELECT data FROM records WHERE user_id=? AND id='1'").get(A.id).data.includes('v2'), true, 'conflict does not overwrite');
  r = await call('POST', '/api/sync/push', { ops: [{ opId: 'o4', coll: 'tasks', id: '1', base: 1, data: { ...task, t: 'Physics lab v2' } }] }, A.tok); assert.equal(r.j.results[0].status, 'ok', 'identical content is not a conflict');
  p = await call('GET', '/api/sync/pull?since=' + seq1, undefined, A.tok); assert.equal(p.j.records.length, 1); assert.equal(p.j.records[0].version, 2);
  r = await call('POST', '/api/sync/push', { ops: [{ opId: 'o5', coll: 'tasks', id: '1', base: 2, deleted: true }] }, A.tok); assert.equal(r.j.results[0].version, 3);
  p = await call('GET', '/api/sync/pull?since=0', undefined, A.tok); assert.equal(p.j.records[0].deleted, true);
  assert.equal((await call('GET', '/api/sync/pull?since=0', undefined, B.tok)).j.records.length, 0, 'user B sees nothing');
  r = await call('POST', '/api/sync/push', { ops: [{ opId: 'o1', coll: 'tasks', id: '1', base: 0, data: { id: 1, t: 'Bob task' } }] }, B.tok);
  assert.equal(r.j.results[0].status, 'ok', 'op ids and record ids are per user');
  assert.equal((await call('POST', '/api/sync/push', { ops: [{ opId: 'x', coll: 'evil', id: '1', data: {} }] }, A.tok)).s, 400);
  assert.equal((await call('POST', '/api/sync/push', { ops: [{ opId: 'x', coll: 'tasks', id: '../1', data: {} }] }, A.tok)).s, 400);
  assert.equal((await call('POST', '/api/sync/push', { ops: [{ opId: 'big', coll: 'notes', id: '9', data: { b: 'x'.repeat(300000) } }] }, A.tok)).s, 400);
  await call('POST', '/api/sync/push', { ops: [{ opId: 'o6', coll: 'tasks', id: '7', base: 0, data: { id: 7, t: 'Finish essay', done: false, d: '2026-11-10', p: 'high' } }] }, A.tok);
});

test('ai: default provider, key handling, test, models, chat, usage, limits', async () => {
  let r = await call('GET', '/api/ai/providers', undefined, A.tok);
  assert.equal(r.j.providers[0].name, 'VyceAI'); assert.equal(r.j.providers[0].base_url, 'https://vyceai.com/v1'); assert.equal(r.j.providers[0].mname, 'DeepSeek V4.1 Flash'); assert.equal(r.j.providers[0].hasKey, false); assert.equal(r.j.providers[0].verified, false);
  assert.equal((await call('POST', '/api/ai/chat', { provider: 'vyceai', messages: [{ role: 'user', content: 'hi' }] }, A.tok)).j.code, 'no_key');
  r = await call('PUT', '/api/ai/providers/vyceai', { name: 'VyceAI', url: mockUrl, model: 'deepseek-v4.1', mname: 'DeepSeek V4.1 Flash', key: 'bad-key', is_default: true }, A.tok); assert.equal(r.s, 200); assert.equal(r.j.provider.hasKey, true);
  assert.ok(!r.t.includes('bad-key'));
  r = await call('POST', '/api/ai/providers/vyceai/test', {}, A.tok); assert.deepEqual([r.j.ok, r.j.code], [false, 'invalid_key']);
  await call('PUT', '/api/ai/providers/vyceai', { name: 'VyceAI', url: mockUrl, model: 'deepseek-v4.1', mname: 'DeepSeek V4.1 Flash', key: 'good-key' }, A.tok);
  r = await call('POST', '/api/ai/providers/vyceai/test', {}, A.tok); assert.equal(r.j.ok, true);
  r = await call('GET', '/api/ai/providers/vyceai/models', undefined, A.tok); assert.equal(r.j.models.length, 2); assert.equal(r.j.models[0].ctx, 64000); assert.equal(r.j.verified, true);
  assert.equal((await call('GET', '/api/ai/providers', undefined, A.tok)).j.providers[0].verified, true);
  const blob = [path.join(dir, 'dayflow.db'), path.join(dir, 'dayflow.db-wal')].filter(f => fs.existsSync(f)).map(f => fs.readFileSync(f).toString('latin1')).join('');
  assert.ok(!blob.includes('good-key') && !blob.includes('bad-key'), 'API keys are not stored in plaintext');
  assert.equal((await call('GET', '/api/ai/providers', undefined, B.tok)).j.providers[0].hasKey, false, 'B has own providers');
  assert.equal((await call('POST', '/api/ai/providers/vyceai/test', {}, B.tok)).j.ok, false);
  const msgs = [{ role: 'user', content: 'hello' }];
  r = await call('POST', '/api/ai/chat', { provider: 'vyceai', model: 'deepseek-v4.1', messages: msgs }, A.tok); assert.equal(r.j.content, 'Hi there'); assert.equal(calls.at(-1).model, 'deepseek-v4.1');
  r = await call('POST', '/api/ai/chat', { provider: 'vyceai', model: 'deepseek-v4.1', messages: msgs, stream: true, context: true }, A.tok);
  assert.ok(r.t.includes('Hello') && r.t.includes('[DONE]')); const last = calls.at(-1); assert.equal(last.stream, true); assert.ok(last.messages[0].content.includes('Finish essay'), 'context includes the user\'s own tasks'); assert.ok(!last.messages[0].content.includes('Bob task'));
  const n = calls.length;
  r = await call('POST', '/api/ai/chat', { provider: 'vyceai', model: 'missing-model', messages: msgs }, A.tok); assert.equal(r.s, 404); assert.equal(r.j.code, 'model_not_found'); assert.equal(calls.length, n + 1, 'no retry with another model'); assert.equal(calls.at(-1).model, 'missing-model');
  r = await call('POST', '/api/ai/chat', { provider: 'vyceai', model: 'ratelimit-model', messages: msgs }, A.tok); assert.equal(r.s, 429); assert.equal(r.j.retryAfter, '7');
  assert.equal((await call('POST', '/api/ai/chat', { provider: 'vyceai', messages: [{ role: 'tool', content: 'x' }] }, A.tok)).s, 400);
  let u = (await call('GET', '/api/ai/usage', undefined, A.tok)).j; assert.equal(u.requests, 5); assert.equal(u.prompt_tokens, 1000010); assert.equal(u.est_cost, 0); assert.ok(u.unpriced_requests >= 3, 'cost unknown without a price');
  await call('PUT', '/api/ai/providers/vyceai', { name: 'VyceAI', url: mockUrl, model: 'deepseek-v4.1', mname: 'x', price_in: 2, price_out: 4 }, A.tok);
  r = await call('PUT', '/api/ai/settings', { monthly_limit: 1, warn_pct: 80 }, A.tok); assert.equal(r.j.monthly_limit, 1);
  r = await call('POST', '/api/ai/chat', { provider: 'vyceai', model: 'deepseek-v4.1', messages: msgs }, A.tok); assert.equal(r.s, 200, 'spend 0 < limit');
  r = await call('POST', '/api/ai/chat', { provider: 'vyceai', model: 'deepseek-v4.1', messages: msgs }, A.tok); assert.equal(r.s, 402); assert.equal(r.j.code, 'limit_reached');
  r = await call('POST', '/api/ai/chat', { provider: 'vyceai', model: 'deepseek-v4.1', messages: msgs, confirmOverLimit: true }, A.tok); assert.equal(r.s, 200);
  u = (await call('GET', '/api/ai/usage', undefined, A.tok)).j; assert.ok(u.est_cost >= 4 && u.limit === 1);
  r = await call('PUT', '/api/ai/providers/vyceai', { name: 'VyceAI', url: 'http://127.0.0.1:1/v1', model: 'm' }, A.tok); assert.equal(r.j.provider.hasKey, false, 'changing the base URL drops the stored key');
  r = await call('PUT', '/api/ai/providers/custom1', { name: 'Custom', url: mockUrl, model: '' }, A.tok); assert.equal(r.s, 200);
  assert.equal((await call('DELETE', '/api/ai/providers/custom1', undefined, A.tok)).s, 200); assert.equal((await call('DELETE', '/api/ai/providers/vyceai', undefined, A.tok)).s, 400);
});

test('ai: provider URL validation (SSRF)', async () => {
  const strict = { allowPrivate: false, allowHttp: false };
  for (const u of ['http://example.com/v1', 'https://127.0.0.1/v1', 'https://10.0.0.5/v1', 'https://192.168.1.2/v1', 'https://169.254.169.254/latest', 'https://[::1]/v1', 'https://user:pw@example.com/v1', 'not a url'])
    await assert.rejects(() => checkUrl(u, strict), { status: 400 }, u);
});

test('files: upload, download, validation, ownership, delete', async () => {
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(64, 1)]);
  let r = await call('POST', '/api/files?owner=chat:1', png, A.tok, { 'x-filename': 'diagram.png', 'content-type': 'application/octet-stream' }); assert.equal(r.s, 200); const id = r.j.id;
  r = await fetch(base + '/api/files/' + id, { headers: { authorization: 'Bearer ' + A.tok } }); assert.equal(r.status, 200); assert.deepEqual(Buffer.from(await r.arrayBuffer()), png); assert.ok(r.headers.get('content-disposition').startsWith('attachment'));
  assert.equal((await call('GET', '/api/files/' + id, undefined, B.tok)).s, 404); assert.equal((await call('DELETE', '/api/files/' + id, undefined, B.tok)).s, 404); assert.equal((await call('GET', '/api/files/' + id)).s, 401);
  assert.equal((await call('POST', '/api/files', png, A.tok, { 'x-filename': 'fake.pdf' })).s, 415);
  assert.equal((await call('POST', '/api/files', Buffer.from('MZ'), A.tok, { 'x-filename': 'run.exe' })).s, 415);
  assert.equal((await call('POST', '/api/files?owner=../x', png, A.tok, { 'x-filename': 'a.png' })).s, 400);
  r = await call('POST', '/api/files', Buffer.alloc(11 * 1024 * 1024, 65), A.tok, { 'x-filename': 'big.txt' }); assert.equal(r.s, 413);
  assert.equal((await call('GET', '/api/files?owner=chat:1', undefined, A.tok)).j.files.length, 1);
  assert.equal((await call('GET', '/api/files', undefined, B.tok)).j.files.length, 0);
  assert.equal((await call('DELETE', '/api/files/' + id, undefined, A.tok)).s, 200); assert.equal((await call('GET', '/api/files/' + id, undefined, A.tok)).s, 404);
  await call('POST', '/api/files', png, A.tok, { 'x-filename': 'keep.png' });
});

test('export, password reset, restart persistence', async () => {
  const x = (await call('GET', '/api/account/export', undefined, A.tok)).j; assert.ok(x.records.length >= 1 && x.providers.length >= 1); assert.ok(!JSON.stringify(x).includes('good-key')); assert.ok(!('key_enc' in x.providers[0]));
  assert.equal((await call('POST', '/api/auth/reset', { token: 'nope', password: 'newpassword1' })).s, 400);
  const f = (await call('POST', '/api/auth/forgot', { email: 'b@x.com' })).j; assert.ok(f.devToken); assert.equal((await call('POST', '/api/auth/forgot', { email: 'nobody@x.com' })).j.devToken, undefined);
  assert.equal((await call('POST', '/api/auth/reset', { token: f.devToken, password: 'brand new pw 33' })).s, 200);
  assert.equal((await call('GET', '/api/auth/me', undefined, B.tok)).s, 401, 'old sessions revoked'); assert.equal((await call('POST', '/api/auth/reset', { token: f.devToken, password: 'brand new pw 33' })).s, 400, 'code is single use');
  assert.equal((await call('POST', '/api/auth/login', { email: 'b@x.com', password: 'another pass 22' })).s, 401); const l = await call('POST', '/api/auth/login', { email: 'b@x.com', password: 'brand new pw 33' }); assert.equal(l.s, 200); B.tok = l.j.token;
  await new Promise(r => srv.close(r)); srv.db.close(); await start();
  assert.equal((await call('GET', '/api/auth/me', undefined, A.tok)).s, 200, 'session survives a server restart');
  assert.ok((await call('GET', '/api/sync/pull?since=0', undefined, A.tok)).j.records.length >= 2, 'data survives a server restart');
  assert.equal((await call('GET', '/api/ai/providers', undefined, A.tok)).j.providers.length, 1);
});

test('account deletion removes everything', async () => {
  assert.equal((await call('DELETE', '/api/account', { password: 'wrong' }, A.tok)).s, 403);
  assert.ok(fs.existsSync(path.join(dir, 'files', A.id)));
  assert.equal((await call('DELETE', '/api/account', { password: 'correct horse 1' }, A.tok)).s, 200);
  for (const t of ['records', 'providers', 'ai_usage', 'files', 'sessions', 'ai_settings']) assert.equal(srv.db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE user_id=?`).get(A.id).c, 0, t);
  assert.ok(!fs.existsSync(path.join(dir, 'files', A.id)));
  assert.equal((await call('POST', '/api/auth/login', { email: 'a@x.com', password: 'correct horse 1' })).s, 401);
  assert.equal((await call('GET', '/api/sync/pull?since=0', undefined, B.tok)).s, 200, 'other users unaffected');
});

test('rate limiting on login', async () => {
  let last; for (let i = 0; i < 14; i++) last = await call('POST', '/api/auth/login', { email: 'z@x.com', password: 'whatever12' });
  assert.equal(last.s, 429);
});
