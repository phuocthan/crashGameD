// Provably fair crash points via a pre-committed SHA-256 hash chain.
//
// A chain is built from a secret seed: h[0] = sha256(seed), h[k] = sha256(h[k-1]).
// The last element h[L-1] (the "terminal hash") is published before any game is played.
// Games consume the chain backwards: game #0 uses h[L-2], game #1 uses h[L-3], ...
// After each game the hash is revealed, and anyone can check that
//   sha256(gameHash) === previous game's hash (or the terminal hash for the first game),
// which proves the operator could not change results after committing to the chain.
import { createHash, createHmac, randomBytes } from 'node:crypto';

export const MAX_CRASH = 10000;
export const GROWTH = 0.00006; // multiplier(t) = e^(GROWTH * t_ms)

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export function crashPointFromHash(hash, salt, houseEdge) {
  const h = createHmac('sha256', hash).update(salt).digest('hex');
  const r = parseInt(h.slice(0, 13), 16);   // 52 bits
  const x = r / 2 ** 52;                    // uniform in [0, 1)
  const cp = Math.floor(((1 - houseEdge) / (1 - x)) * 100) / 100;
  return Math.min(MAX_CRASH, Math.max(1, cp)); // P(crash >= m) = (1 - edge) / m
}

export function multiplierAt(elapsedMs) {
  if (elapsedMs <= 0) return 1;
  return Math.floor(Math.exp(GROWTH * elapsedMs) * 100) / 100;
}

export function msForMultiplier(m) {
  return Math.ceil(Math.log(m) / GROWTH);
}

export function buildChain(seed, length) {
  const arr = new Array(length);
  arr[0] = sha256(seed);
  for (let i = 1; i < length; i++) arr[i] = sha256(arr[i - 1]);
  return arr;
}

export class FairChain {
  constructor(db) {
    this.db = db;
    this.load();
  }

  load() {
    let row = this.db.prepare('SELECT * FROM chains WHERE active = 1 ORDER BY id DESC LIMIT 1').get();
    if (!row || row.used >= row.length - 1) row = this.create();
    this.row = row;
    this.hashes = buildChain(row.seed, row.length);
  }

  create(length = 10001) {
    const seed = randomBytes(32).toString('hex');
    const salt = randomBytes(16).toString('hex');
    const terminal = buildChain(seed, length)[length - 1];
    this.db.prepare('UPDATE chains SET active = 0').run();
    const info = this.db.prepare(
      'INSERT INTO chains(seed, terminal_hash, salt, length, used, active, created_at) VALUES (?, ?, ?, ?, 0, 1, ?)'
    ).run(seed, terminal, salt, length, Date.now());
    return this.db.prepare('SELECT * FROM chains WHERE id = ?').get(info.lastInsertRowid);
  }

  rotate() {
    this.row = this.create();
    this.hashes = buildChain(this.row.seed, this.row.length);
    return this.publicInfo();
  }

  /** Returns the next game hash and advances the chain. */
  next() {
    if (this.row.used >= this.row.length - 1) this.rotate();
    const index = this.row.used;
    const hash = this.hashes[this.row.length - 2 - index];
    this.row.used++;
    this.db.prepare('UPDATE chains SET used = ? WHERE id = ?').run(this.row.used, this.row.id);
    return { chainId: this.row.id, index, hash, salt: this.row.salt };
  }

  publicInfo() {
    return {
      chainId: this.row.id,
      terminalHash: this.row.terminal_hash,
      salt: this.row.salt,
      length: this.row.length - 1,
      used: this.row.used,
      createdAt: this.row.created_at,
    };
  }
}
