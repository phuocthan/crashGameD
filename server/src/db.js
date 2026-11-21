// SQLite persistence using Node's built-in `node:sqlite` (no native deps to compile).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const DEFAULT_SETTINGS = {
  houseEdge: 0.03,        // 3% -> theoretical RTP 97%
  minBet: 100,            // all money values are integer cents (100 = 1.00 credit)
  maxBet: 100000,
  maxAutoCashout: 1000,   // highest auto cash-out multiplier a player may set
  bettingMs: 6000,        // betting window before the round launches
  crashedMs: 3000,        // pause after a crash before the next betting window
  startBalance: 100000,   // demo credits granted to new players
  bots: 12,               // display-only bots that make the lobby feel alive (never touch the ledger)
  paused: false,          // when true the engine stops after the current round
};

export function openDb(file) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      token TEXT NOT NULL UNIQUE,
      balance INTEGER NOT NULL,
      banned INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_seen INTEGER
    );

    CREATE TABLE IF NOT EXISTS chains (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      seed TEXT NOT NULL,              -- secret; never exposed
      terminal_hash TEXT NOT NULL,     -- public commitment
      salt TEXT NOT NULL,              -- public
      length INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chain_id INTEGER NOT NULL REFERENCES chains(id),
      chain_index INTEGER NOT NULL,
      hash TEXT NOT NULL,
      house_edge REAL NOT NULL,
      crash_point REAL NOT NULL,
      status TEXT NOT NULL,            -- betting | running | crashed
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      ended_at INTEGER,
      bet_count INTEGER NOT NULL DEFAULT 0,
      total_bet INTEGER NOT NULL DEFAULT 0,
      total_payout INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS bets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id INTEGER NOT NULL REFERENCES rounds(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      slot INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      auto_cashout REAL,
      cashout_at REAL,
      payout INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,            -- open | won | lost | cancelled
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bets_user ON bets(user_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_bets_round ON bets(round_id);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT
    );
  `);
  return db;
}

export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export class Settings {
  constructor(db) {
    this.db = db;
    this.values = { ...DEFAULT_SETTINGS };
    for (const row of db.prepare('SELECT key, value FROM settings').all()) {
      if (row.key in DEFAULT_SETTINGS) this.values[row.key] = JSON.parse(row.value);
    }
  }
  get(key) { return this.values[key]; }
  all() { return { ...this.values }; }
  update(patch) {
    const clean = {};
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in DEFAULT_SETTINGS)) continue;
      const def = DEFAULT_SETTINGS[k];
      const val = typeof def === 'boolean' ? Boolean(v) : Number(v);
      if (typeof def === 'number' && !Number.isFinite(val)) throw new Error(`Invalid value for ${k}`);
      clean[k] = val;
    }
    if ('houseEdge' in clean && (clean.houseEdge < 0 || clean.houseEdge > 0.5)) throw new Error('houseEdge must be 0..0.5');
    const next = { ...this.values, ...clean };
    if (next.minBet < 1 || next.maxBet < next.minBet) throw new Error('Bet limits invalid');
    if (next.maxAutoCashout < 1.01) throw new Error('maxAutoCashout must be >= 1.01');
    if (next.bettingMs < 2000 || next.crashedMs < 500) throw new Error('Timings too short');
    if (next.bots < 0 || next.bots > 100) throw new Error('bots must be 0..100');
    const stmt = this.db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const [k, v] of Object.entries(clean)) stmt.run(k, JSON.stringify(v));
    this.values = next;
    return clean;
  }
}

export function audit(db, actor, action, detail) {
  db.prepare('INSERT INTO audit_log(ts, actor, action, detail) VALUES (?, ?, ?, ?)')
    .run(Date.now(), actor, action, detail == null ? null : JSON.stringify(detail));
}
