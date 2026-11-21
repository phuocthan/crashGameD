// REST API: player endpoints (/api/*) and admin endpoints (/api/admin/*).
import express from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { audit, tx } from './db.js';
import { crashPointFromHash, sha256, MAX_CRASH, GROWTH } from './fair.js';

const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;

export function createApi({ db, settings, fair, engine, hub, adminPassword }) {
  const api = express.Router();
  api.use(express.json());

  const userByToken = db.prepare('SELECT * FROM users WHERE token = ?');
  const publicUser = (u) => ({ id: u.id, username: u.username, balance: u.balance, banned: !!u.banned });

  const requireUser = (req, res, next) => {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    const user = token && userByToken.get(token);
    if (!user) return res.status(401).json({ error: 'Not logged in' });
    req.user = user;
    next();
  };

  // ---------------- player ----------------

  // Demo login: username only. A real deployment would add passwords / OAuth.
  api.post('/login', (req, res) => {
    const username = String(req.body?.username || '').trim();
    if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'Username: 3-16 letters, digits or _' });
    let user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) {
      const token = randomBytes(24).toString('hex');
      const info = db.prepare('INSERT INTO users(username, token, balance, created_at) VALUES (?, ?, ?, ?)')
        .run(username, token, settings.get('startBalance'), Date.now());
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    }
    if (user.banned) return res.status(403).json({ error: 'Account suspended' });
    res.json({ token: user.token, user: publicUser(user) });
  });

  api.get('/me', requireUser, (req, res) => res.json({ user: publicUser(req.user) }));

  api.get('/my-bets', requireUser, (req, res) => {
    const rows = db.prepare(`SELECT b.id, b.round_id AS roundId, b.slot, b.amount, b.auto_cashout AS autoCashout, b.cashout_at AS cashoutAt,
                                    b.payout, b.status, b.created_at AS createdAt, r.crash_point AS crashPoint
                             FROM bets b JOIN rounds r ON r.id = b.round_id
                             WHERE b.user_id = ? AND b.status != 'cancelled' ORDER BY b.id DESC LIMIT 50`).all(req.user.id);
    res.json({ bets: rows });
  });

  api.get('/config', (_req, res) => {
    const s = settings.all();
    res.json({ minBet: s.minBet, maxBet: s.maxBet, maxAutoCashout: s.maxAutoCashout, houseEdge: s.houseEdge, growth: GROWTH });
  });

  api.get('/fair', (_req, res) => {
    res.json({
      ...fair.publicInfo(),
      houseEdge: settings.get('houseEdge'),
      formula: 'h = HMAC_SHA256(key=gameHash, msg=salt); x = int(h[0:13], 16) / 2^52; crash = max(1, floor((1 - houseEdge) / (1 - x) * 100) / 100)',
      chainRule: 'sha256(gameHash_n) == gameHash_(n-1); the first game of a chain hashes to terminalHash',
      maxCrash: MAX_CRASH,
    });
  });

  api.get('/rounds/recent', (_req, res) => {
    const rows = db.prepare(`SELECT r.id, r.hash, r.house_edge AS houseEdge, r.crash_point AS crashPoint, r.ended_at AS endedAt, c.salt
                             FROM rounds r JOIN chains c ON c.id = r.chain_id
                             WHERE r.status = 'crashed' ORDER BY r.id DESC LIMIT 30`).all();
    res.json({ rounds: rows });
  });

  api.post('/verify', (req, res) => {
    const { hash, salt, houseEdge } = req.body || {};
    if (!/^[0-9a-f]{64}$/.test(hash || '')) return res.status(400).json({ error: 'hash must be 64 hex chars' });
    res.json({ crashPoint: crashPointFromHash(hash, String(salt || ''), Number(houseEdge ?? 0.03)), previousHash: sha256(hash) });
  });

  // ---------------- admin ----------------

  const adminTokens = new Map(); // token -> expiry
  const ADMIN_TTL = 12 * 3600 * 1000;

  api.post('/admin/login', (req, res) => {
    const a = Buffer.from(String(req.body?.password || ''));
    const b = Buffer.from(adminPassword);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      audit(db, 'system', 'admin.login_failed', { ip: req.ip });
      return res.status(401).json({ error: 'Wrong password' });
    }
    const token = randomBytes(24).toString('hex');
    adminTokens.set(token, Date.now() + ADMIN_TTL);
    audit(db, 'admin', 'admin.login', { ip: req.ip });
    res.json({ token });
  });

  const admin = express.Router();
  admin.use((req, res, next) => {
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    const exp = adminTokens.get(token);
    if (!exp || exp < Date.now()) return res.status(401).json({ error: 'Admin login required' });
    next();
  });

  admin.get('/stats', (_req, res) => {
    const totals = db.prepare(`SELECT COUNT(*) AS rounds, COALESCE(SUM(bet_count),0) AS bets, COALESCE(SUM(total_bet),0) AS wagered,
                                      COALESCE(SUM(total_payout),0) AS paid FROM rounds WHERE status = 'crashed'`).get();
    const day = db.prepare(`SELECT COUNT(*) AS rounds, COALESCE(SUM(total_bet),0) AS wagered, COALESCE(SUM(total_payout),0) AS paid
                            FROM rounds WHERE status = 'crashed' AND ended_at > ?`).get(Date.now() - 86400000);
    const users = db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(balance),0) AS balances, SUM(banned) AS banned FROM users`).get();
    const series = db.prepare(`SELECT id, crash_point AS crashPoint, total_bet AS wagered, total_payout AS paid, bet_count AS bets
                               FROM rounds WHERE status = 'crashed' ORDER BY id DESC LIMIT 120`).all().reverse();
    const s = settings.all();
    res.json({
      online: hub.onlineCount(),
      live: engine.adminView(),
      totals: { ...totals, profit: totals.wagered - totals.paid, rtp: totals.wagered ? totals.paid / totals.wagered : null },
      last24h: { ...day, profit: day.wagered - day.paid },
      users,
      theoreticalRtp: 1 - s.houseEdge,
      paused: s.paused,
      series,
    });
  });

  admin.get('/users', (req, res) => {
    const q = `%${String(req.query.q || '').trim()}%`;
    const page = Math.max(0, Number(req.query.page) || 0);
    const rows = db.prepare(`SELECT u.id, u.username, u.balance, u.banned, u.created_at AS createdAt, u.last_seen AS lastSeen,
                                    (SELECT COUNT(*) FROM bets b WHERE b.user_id = u.id AND b.status IN ('won','lost')) AS bets,
                                    (SELECT COALESCE(SUM(amount),0) FROM bets b WHERE b.user_id = u.id AND b.status IN ('won','lost')) AS wagered,
                                    (SELECT COALESCE(SUM(payout),0) FROM bets b WHERE b.user_id = u.id AND b.status IN ('won','lost')) AS paid
                             FROM users u WHERE u.username LIKE ? ORDER BY u.id DESC LIMIT 50 OFFSET ?`).all(q, page * 50);
    const online = hub.onlineUserIds();
    res.json({ users: rows.map((u) => ({ ...u, banned: !!u.banned, online: online.has(u.id) })) });
  });

  admin.get('/users/:id/bets', (req, res) => {
    const rows = db.prepare(`SELECT b.id, b.round_id AS roundId, b.slot, b.amount, b.auto_cashout AS autoCashout, b.cashout_at AS cashoutAt,
                                    b.payout, b.status, b.created_at AS createdAt, r.crash_point AS crashPoint
                             FROM bets b JOIN rounds r ON r.id = b.round_id WHERE b.user_id = ? ORDER BY b.id DESC LIMIT 100`).all(req.params.id);
    res.json({ bets: rows });
  });

  admin.post('/users/:id/balance', (req, res) => {
    const id = Number(req.params.id);
    const delta = Math.round(Number(req.body?.delta) * 100);
    const reason = String(req.body?.reason || '').slice(0, 200);
    if (!Number.isFinite(delta) || delta === 0) return res.status(400).json({ error: 'delta must be a non-zero number' });
    try {
      const balance = tx(db, () => {
        const u = db.prepare('SELECT balance FROM users WHERE id = ?').get(id);
        if (!u) throw new Error('User not found');
        if (u.balance + delta < 0) throw new Error('Balance cannot go below zero');
        db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(delta, id);
        return u.balance + delta;
      });
      audit(db, 'admin', 'user.balance', { userId: id, delta, reason });
      hub.sendBalance(id, balance);
      res.json({ balance });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  admin.post('/users/:id/ban', (req, res) => {
    const id = Number(req.params.id);
    const banned = !!req.body?.banned;
    const info = db.prepare('UPDATE users SET banned = ? WHERE id = ?').run(banned ? 1 : 0, id);
    if (!info.changes) return res.status(404).json({ error: 'User not found' });
    audit(db, 'admin', banned ? 'user.ban' : 'user.unban', { userId: id });
    if (banned) hub.kickUser(id);
    res.json({ ok: true });
  });

  admin.get('/rounds', (req, res) => {
    const page = Math.max(0, Number(req.query.page) || 0);
    const rows = db.prepare(`SELECT id, hash, house_edge AS houseEdge, crash_point AS crashPoint, status, started_at AS startedAt, ended_at AS endedAt,
                                    bet_count AS bets, total_bet AS wagered, total_payout AS paid
                             FROM rounds WHERE status = 'crashed' ORDER BY id DESC LIMIT 50 OFFSET ?`).all(page * 50);
    res.json({ rounds: rows });
  });

  admin.get('/rounds/:id', (req, res) => {
    const round = db.prepare('SELECT * FROM rounds WHERE id = ?').get(req.params.id);
    if (!round) return res.status(404).json({ error: 'Round not found' });
    const bets = db.prepare(`SELECT b.id, u.username, b.slot, b.amount, b.auto_cashout AS autoCashout, b.cashout_at AS cashoutAt, b.payout, b.status
                             FROM bets b JOIN users u ON u.id = b.user_id WHERE b.round_id = ? ORDER BY b.id`).all(req.params.id);
    res.json({ round, bets });
  });

  admin.get('/settings', (_req, res) => res.json({ settings: settings.all() }));

  admin.put('/settings', (req, res) => {
    try {
      const changed = settings.update(req.body || {});
      audit(db, 'admin', 'settings.update', changed);
      hub.broadcastConfig();
      res.json({ settings: settings.all() });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  admin.get('/chain', (_req, res) => res.json({ chain: fair.publicInfo() }));

  admin.post('/chain/rotate', (_req, res) => {
    const prev = fair.publicInfo();
    const chain = fair.rotate();
    audit(db, 'admin', 'chain.rotate', { from: prev.chainId, to: chain.chainId, usedOfPrev: prev.used });
    res.json({ chain });
  });

  admin.get('/audit', (_req, res) => {
    const rows = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200').all();
    res.json({ log: rows.map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null })) });
  });

  api.use('/admin', admin);
  return api;
}
