'use strict';
class HttpError extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra || {}; } }
const send = (res, code, obj, headers = {}) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(obj));
};
const readBody = (req, max) => new Promise((resolve, reject) => {
  let n = 0; const chunks = [];
  req.on('data', d => { n += d.length; if (n > max) { reject(new HttpError(413, 'Payload too large')); req.destroy(); return; } chunks.push(d); });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});
const readJson = async (req, max = 2_000_000) => {
  const b = await readBody(req, max);
  if (!b.length) return {};
  try { return JSON.parse(b.toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON'); }
};
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now(); let b = buckets.get(key);
  if (!b || now - b.t > windowMs) b = { n: 0, t: now };
  b.n++; buckets.set(key, b);
  if (b.n > max) throw new HttpError(429, 'Too many requests. Please try again shortly.');
}
const str = (v, min, max, name) => {
  if (typeof v !== 'string' || v.trim().length < min || v.length > max) throw new HttpError(400, `${name} must be ${min}-${max} characters`);
  return v.trim();
};
module.exports = { HttpError, send, readBody, readJson, rateLimit, str };
