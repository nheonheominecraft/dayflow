'use strict';
const fs = require('fs'), path = require('path'), crypto = require('node:crypto');
const { HttpError, readBody } = require('./util');
const MAX = 10 * 1024 * 1024, QUOTA = 200 * 1024 * 1024;
const TYPES = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
const MAGIC = { pdf: b => b.subarray(0, 4).toString() === '%PDF', png: b => b.subarray(0, 4).toString('hex') === '89504e47', jpg: b => b.subarray(0, 3).toString('hex') === 'ffd8ff', jpeg: b => b.subarray(0, 3).toString('hex') === 'ffd8ff',
  gif: b => b.subarray(0, 4).toString() === 'GIF8', webp: b => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP',
  docx: b => b[0] === 0x50 && b[1] === 0x4b, xlsx: b => b[0] === 0x50 && b[1] === 0x4b, pptx: b => b[0] === 0x50 && b[1] === 0x4b };
const cleanName = n => path.basename(String(n || 'file')).replace(/[\x00-\x1f\\/:*?"<>|]/g, '_').slice(0, 120) || 'file';
module.exports = function fileRoutes(db, dir) {
  const udir = uid => path.join(dir, 'files', uid);
  return {
    async upload(req, query, ctx) {
      const uid = ctx.auth.user.id, name = cleanName(decodeURIComponent(req.headers['x-filename'] || 'file')), ext = (name.split('.').pop() || '').toLowerCase();
      if (!TYPES[ext]) throw new HttpError(415, 'This file type is not allowed. Allowed: ' + Object.keys(TYPES).join(', '));
      const owner = query.get('owner') || null;
      if (owner && !/^(chat|task|note|class|event):[\w.-]{1,64}$/.test(owner)) throw new HttpError(400, 'Invalid owner');
      if (Number(req.headers['content-length']) > MAX) throw new HttpError(413, 'File is larger than 10 MB');
      const buf = await readBody(req, MAX);
      if (!buf.length) throw new HttpError(400, 'File is empty');
      if (MAGIC[ext] ? !MAGIC[ext](buf) : buf.subarray(0, 2048).includes(0)) throw new HttpError(415, 'File content does not match its type');
      const used = db.prepare('SELECT COALESCE(SUM(size),0) s FROM files WHERE user_id=?').get(uid).s;
      if (used + buf.length > QUOTA) throw new HttpError(413, 'Storage quota (200 MB) exceeded');
      const id = crypto.randomUUID();
      fs.mkdirSync(udir(uid), { recursive: true });
      fs.writeFileSync(path.join(udir(uid), id), buf);
      db.prepare('INSERT INTO files VALUES(?,?,?,?,?,?,?)').run(id, uid, name, TYPES[ext], buf.length, owner, Date.now());
      return { id, name, mime: TYPES[ext], size: buf.length, owner };
    },
    list(query, ctx) {
      const o = query.get('owner');
      return { files: db.prepare('SELECT id,name,mime,size,owner,created_at FROM files WHERE user_id=?' + (o ? ' AND owner=?' : '')).all(...(o ? [ctx.auth.user.id, o] : [ctx.auth.user.id])) };
    },
    download(id, res, ctx) {
      const f = db.prepare('SELECT * FROM files WHERE id=? AND user_id=?').get(id, ctx.auth.user.id);
      if (!f) throw new HttpError(404, 'File not found');
      res.writeHead(200, { 'content-type': f.mime, 'content-length': f.size, 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`, 'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store' });
      fs.createReadStream(path.join(udir(f.user_id), f.id)).pipe(res);
    },
    remove(id, ctx) {
      const f = db.prepare('SELECT * FROM files WHERE id=? AND user_id=?').get(id, ctx.auth.user.id);
      if (!f) throw new HttpError(404, 'File not found');
      fs.rmSync(path.join(udir(f.user_id), f.id), { force: true });
      db.prepare('DELETE FROM files WHERE id=?').run(id);
      return { ok: true };
    },
    deleteUserFiles(uid) { fs.rmSync(udir(uid), { recursive: true, force: true }); },
  };
};
