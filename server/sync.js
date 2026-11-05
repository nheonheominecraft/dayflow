'use strict';
const { HttpError } = require('./util');
const COLLS = new Set(['tasks', 'events', 'classes', 'rem', 'notes', 'chats', 'set', 'wb']);
const MAX_RECORD = 262_144;
const view = r => ({ coll: r.coll, id: r.id, version: r.version, deleted: !!r.deleted, updated_at: r.updated_at, data: r.data ? JSON.parse(r.data) : null });
module.exports = function syncRoutes(db) {
  const getRec = db.prepare('SELECT * FROM records WHERE user_id=? AND coll=? AND id=?');
  const upsert = db.prepare(`INSERT INTO records(user_id,coll,id,data,version,deleted,updated_at,seq) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id,coll,id) DO UPDATE SET data=excluded.data,version=excluded.version,deleted=excluded.deleted,updated_at=excluded.updated_at,seq=excluded.seq`);
  const nextSeq = uid => { db.prepare('UPDATE users SET seq=seq+1 WHERE id=?').run(uid); return db.prepare('SELECT seq FROM users WHERE id=?').get(uid).seq; };
  return {
    push(body, ctx) {
      const uid = ctx.auth.user.id, ops = body.ops;
      if (!Array.isArray(ops) || ops.length > 100) throw new HttpError(400, 'ops must be an array of at most 100 items');
      for (const o of ops) {
        if (!o || typeof o.opId !== 'string' || o.opId.length > 80 || !COLLS.has(o.coll) || typeof o.id !== 'string' || !/^[\w.:-]{1,64}$/.test(o.id)) throw new HttpError(400, 'Invalid operation');
        if (!o.deleted && (typeof o.data !== 'object' || o.data === null || JSON.stringify(o.data).length > MAX_RECORD)) throw new HttpError(400, 'Record data is invalid or too large');
      }
      return db.tx(() => {
        const results = [];
        for (const o of ops) {
          const prev = db.prepare('SELECT result FROM ops WHERE user_id=? AND op_id=?').get(uid, o.opId);
          if (prev) { results.push({ ...JSON.parse(prev.result), opId: o.opId, dup: true }); continue; }
          const ex = getRec.get(uid, o.coll, o.id), base = Number(o.base) || 0, json = o.deleted ? null : JSON.stringify(o.data);
          let res;
          if (ex && ex.version !== base && !(ex.deleted && o.deleted) && !(json !== null && !ex.deleted && ex.data === json)) {
            res = { status: 'conflict', server: view(ex) };
          } else if (ex && ex.version !== base) {
            res = { status: 'ok', version: ex.version };            // identical content or both deleted: nothing to change
          } else if (ex && ex.deleted === (o.deleted ? 1 : 0) && ex.data === json) {
            res = { status: 'ok', version: ex.version };
          } else {
            const version = ex ? ex.version + 1 : 1;
            upsert.run(uid, o.coll, o.id, json, version, o.deleted ? 1 : 0, Date.now(), nextSeq(uid));
            res = { status: 'ok', version };
          }
          db.prepare('INSERT INTO ops VALUES(?,?,?)').run(uid, o.opId, JSON.stringify(res));
          results.push({ ...res, opId: o.opId });
        }
        return { results, seq: db.prepare('SELECT seq FROM users WHERE id=?').get(uid).seq };
      });
    },
    pull(query, ctx) {
      const uid = ctx.auth.user.id, since = Math.max(0, parseInt(query.get('since') || '0', 10) || 0);
      const rows = db.prepare('SELECT * FROM records WHERE user_id=? AND seq>? ORDER BY seq LIMIT 500').all(uid, since);
      const more = rows.length === 500;
      const seq = rows.length ? rows[rows.length - 1].seq : db.prepare('SELECT seq FROM users WHERE id=?').get(uid).seq;
      return { records: rows.map(view), seq: Math.max(seq, since), more };
    },
  };
};
