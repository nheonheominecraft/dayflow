'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs'), path = require('path');
function openDb(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'dayflow.db'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
  CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, username TEXT NOT NULL, pw_hash TEXT NOT NULL, pw_salt TEXT NOT NULL, created_at INTEGER NOT NULL, prefs TEXT NOT NULL DEFAULT '{}', seq INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, device TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS resets(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS records(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, coll TEXT NOT NULL, id TEXT NOT NULL, data TEXT, version INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY(user_id, coll, id));
  CREATE INDEX IF NOT EXISTS records_seq ON records(user_id, seq);
  CREATE TABLE IF NOT EXISTS ops(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, op_id TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(user_id, op_id));
  CREATE TABLE IF NOT EXISTS providers(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, id TEXT NOT NULL, name TEXT NOT NULL, base_url TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', mname TEXT NOT NULL DEFAULT '', key_enc TEXT, price_in REAL, price_out REAL, verified INTEGER NOT NULL DEFAULT 0, is_default INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id, id));
  CREATE TABLE IF NOT EXISTS ai_settings(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, monthly_limit REAL, warn_pct INTEGER NOT NULL DEFAULT 80);
  CREATE TABLE IF NOT EXISTS ai_usage(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, ts INTEGER NOT NULL, provider_id TEXT, model TEXT, prompt_tokens INTEGER, completion_tokens INTEGER, est_cost REAL, status TEXT);
  CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, owner TEXT, created_at INTEGER NOT NULL);`);
  db.tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; } };
  return db;
}
module.exports = { openDb };
