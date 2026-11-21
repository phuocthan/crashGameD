// Authoritative crash game loop: betting -> running -> crashed -> betting ...
import { EventEmitter } from 'node:events';
import { tx } from './db.js';
import { crashPointFromHash, multiplierAt, msForMultiplier } from './fair.js';
import { BotCrowd } from './bots.js';

const TICK_MS = 25;

export class GameError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export class GameEngine extends EventEmitter {
  constructor({ db, settings, fair }) {
    super();
    this.db = db;
    this.settings = settings;
    this.fair = fair;
    this.phase = 'idle';      // idle | paused | betting | running | crashed
    this.round = null;
    this.bets = new Map();    // `${userKey}:${slot}` -> bet
    this.history = [];        // recent crash points (newest first)
    this.timer = null;
    this.ticker = null;
    this.bots = new BotCrowd(this);

    this.q = {
      user: db.prepare('SELECT * FROM users WHERE id = ?'),
      debit: db.prepare('UPDATE users SET balance = balance - ? WHERE id = ? AND balance >= ?'),
      credit: db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?'),
      balance: db.prepare('SELECT balance FROM users WHERE id = ?'),
      insertRound: db.prepare(`INSERT INTO rounds(chain_id, chain_index, hash, house_edge, crash_point, status, created_at)
                               VALUES (?, ?, ?, ?, ?, 'betting', ?)`),
      startRound: db.prepare(`UPDATE rounds SET status = 'running', started_at = ? WHERE id = ?`),
      endRound: db.prepare(`UPDATE rounds SET status = 'crashed', ended_at = ?, bet_count = ?, total_bet = ?, total_payout = ? WHERE id = ?`),
      insertBet: db.prepare(`INSERT INTO bets(round_id, user_id, slot, amount, auto_cashout, status, created_at)
                             VALUES (?, ?, ?, ?, ?, 'open', ?)`),
      cancelBet: db.prepare(`UPDATE bets SET status = 'cancelled' WHERE id = ?`),
      winBet: db.prepare(`UPDATE bets SET status = 'won', cashout_at = ?, payout = ? WHERE id = ?`),
      loseBets: db.prepare(`UPDATE bets SET status = 'lost' WHERE round_id = ? AND status = 'open'`),
      recent: db.prepare(`SELECT crash_point FROM rounds WHERE status = 'crashed' ORDER BY id DESC LIMIT 30`),
    };
  }

  start() {
    // Any round left half-finished by a previous crash/restart is refunded.
    tx(this.db, () => {
      const open = this.db.prepare(`SELECT b.id, b.user_id, b.amount FROM bets b JOIN rounds r ON r.id = b.round_id
                                    WHERE b.status = 'open' AND r.status != 'crashed'`).all();
      for (const b of open) {
        this.q.credit.run(b.amount, b.user_id);
        this.q.cancelBet.run(b.id);
      }
      this.db.prepare(`UPDATE rounds SET status = 'crashed', ended_at = ? WHERE status != 'crashed'`).run(Date.now());
    });
    this.history = this.q.recent.all().map((r) => r.crash_point);
    this.nextRound();
  }

  stop() {
    clearTimeout(this.timer);
    clearInterval(this.ticker);
    this.bots.clear();
  }

  // ---------- phases ----------

  nextRound() {
    if (this.settings.get('paused')) {
      if (this.phase !== 'paused') {
        this.phase = 'paused';
        this.round = null;
        this.emit('paused');
      }
      this.timer = setTimeout(() => this.nextRound(), 1000);
      return;
    }
    const edge = this.settings.get('houseEdge');
    const { chainId, index, hash, salt } = this.fair.next();
    const crashPoint = crashPointFromHash(hash, salt, edge);
    const now = Date.now();
    const info = this.q.insertRound.run(chainId, index, hash, edge, crashPoint, now);
    this.bets.clear();
    this.round = {
      id: Number(info.lastInsertRowid),
      hash, salt, houseEdge: edge, crashPoint,
      bettingEndsAt: now + this.settings.get('bettingMs'),
      startedAt: null, endedAt: null,
    };
    this.phase = 'betting';
    this.emit('betting', this.publicRound());
    this.bots.onBetting(this.settings.get('bots'), this.settings.get('bettingMs'));
    this.timer = setTimeout(() => this.launch(), this.settings.get('bettingMs'));
  }

  launch() {
    this.bots.clear();
    this.phase = 'running';
    this.round.startedAt = Date.now();
    this.q.startRound.run(this.round.startedAt, this.round.id);
    this.emit('running', this.publicRound());
    this.ticker = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  currentMultiplier(now = Date.now()) {
    if (this.phase !== 'running') return 1;
    return multiplierAt(now - this.round.startedAt);
  }

  tick() {
    const m = this.currentMultiplier();
    // Auto cash-outs are settled at exactly the requested multiplier.
    for (const bet of this.bets.values()) {
      if (bet.cashoutAt == null && bet.autoCashout && bet.autoCashout <= m && bet.autoCashout <= this.round.crashPoint) {
        this.settleWin(bet, bet.autoCashout);
      }
    }
    if (m >= this.round.crashPoint) this.crash();
  }

  crash() {
    clearInterval(this.ticker);
    const r = this.round;
    // Catch auto cash-outs that fell between two ticks right before the crash.
    for (const bet of this.bets.values()) {
      if (bet.cashoutAt == null && bet.autoCashout && bet.autoCashout <= r.crashPoint) this.settleWin(bet, bet.autoCashout);
    }
    r.endedAt = Date.now();
    this.phase = 'crashed';

    let count = 0, totalBet = 0, totalPayout = 0;
    for (const bet of this.bets.values()) {
      if (bet.isBot) continue;
      count++; totalBet += bet.amount; totalPayout += bet.payout;
    }
    tx(this.db, () => {
      this.q.loseBets.run(r.id);
      this.q.endRound.run(r.endedAt, count, totalBet, totalPayout, r.id);
    });
    this.history.unshift(r.crashPoint);
    this.history.length = Math.min(this.history.length, 30);
    this.emit('crashed', { ...this.publicRound(), crashPoint: r.crashPoint, hash: r.hash });
    this.timer = setTimeout(() => this.nextRound(), this.settings.get('crashedMs'));
  }

  // ---------- player actions ----------

  placeBet(userId, { slot, amount, autoCashout }) {
    if (this.phase !== 'betting') throw new GameError('NOT_BETTING', 'Bets are closed for this round');
    slot = Number(slot);
    amount = Math.floor(Number(amount));
    if (slot !== 0 && slot !== 1) throw new GameError('BAD_SLOT', 'Invalid bet slot');
    const min = this.settings.get('minBet'), max = this.settings.get('maxBet');
    if (!Number.isFinite(amount) || amount < min || amount > max) throw new GameError('BAD_AMOUNT', `Bet must be between ${min / 100} and ${max / 100}`);
    let auto = null;
    if (autoCashout != null && autoCashout !== '') {
      auto = Math.floor(Number(autoCashout) * 100) / 100;
      if (!Number.isFinite(auto) || auto < 1.01 || auto > this.settings.get('maxAutoCashout')) {
        throw new GameError('BAD_AUTO', `Auto cash-out must be 1.01 - ${this.settings.get('maxAutoCashout')}`);
      }
    }
    const key = `${userId}:${slot}`;
    if (this.bets.has(key)) throw new GameError('DUP_BET', 'You already have a bet in this slot');
    const user = this.q.user.get(userId);
    if (!user) throw new GameError('NO_USER', 'Unknown user');
    if (user.banned) throw new GameError('BANNED', 'Your account is suspended');

    const bet = tx(this.db, () => {
      const res = this.q.debit.run(amount, userId, amount);
      if (res.changes === 0) throw new GameError('NO_FUNDS', 'Insufficient balance');
      const info = this.q.insertBet.run(this.round.id, userId, slot, amount, auto, Date.now());
      return { id: Number(info.lastInsertRowid), key, userId, username: user.username, slot, amount, autoCashout: auto, cashoutAt: null, payout: 0, isBot: false };
    });
    this.bets.set(key, bet);
    this.emit('bet', this.publicBet(bet));
    this.emit('balance', userId, this.q.balance.get(userId).balance);
    return this.publicBet(bet);
  }

  cancelBet(userId, slot) {
    if (this.phase !== 'betting') throw new GameError('NOT_BETTING', 'Too late to cancel');
    const key = `${userId}:${Number(slot)}`;
    const bet = this.bets.get(key);
    if (!bet) throw new GameError('NO_BET', 'No bet to cancel');
    tx(this.db, () => {
      this.q.credit.run(bet.amount, userId);
      this.q.cancelBet.run(bet.id);
    });
    this.bets.delete(key);
    this.emit('cancel', { username: bet.username, slot: bet.slot });
    this.emit('balance', userId, this.q.balance.get(userId).balance);
  }

  cashout(userId, slot) {
    if (this.phase !== 'running') throw new GameError('NOT_RUNNING', 'Round is not in flight');
    const bet = this.bets.get(`${userId}:${Number(slot)}`);
    if (!bet) throw new GameError('NO_BET', 'No active bet');
    if (bet.cashoutAt != null) throw new GameError('DONE', 'Already cashed out');
    const m = this.currentMultiplier();
    if (m >= this.round.crashPoint) {
      this.crash();
      throw new GameError('CRASHED', 'Too late - it crashed');
    }
    this.settleWin(bet, m);
    return this.publicBet(bet);
  }

  settleWin(bet, multiplier) {
    bet.cashoutAt = multiplier;
    bet.payout = Math.floor(bet.amount * multiplier);
    if (!bet.isBot) {
      tx(this.db, () => {
        this.q.winBet.run(multiplier, bet.payout, bet.id);
        this.q.credit.run(bet.payout, bet.userId);
      });
      this.emit('balance', bet.userId, this.q.balance.get(bet.userId).balance);
    }
    this.emit('cashout', this.publicBet(bet));
  }

  // ---------- bots (display only) ----------

  addBotBet(bet) {
    if (this.phase !== 'betting') return;
    const key = `bot-${bet.username}:${bet.slot}`;
    if (this.bets.has(key)) return;
    const b = { ...bet, key, userId: null, cashoutAt: null, payout: 0, isBot: true };
    this.bets.set(key, b);
    this.emit('bet', this.publicBet(b));
  }

  // ---------- views ----------

  publicRound() {
    const r = this.round;
    if (!r) return { phase: this.phase };
    return {
      phase: this.phase,
      roundId: r.id,
      bettingEndsAt: r.bettingEndsAt,
      startedAt: r.startedAt,
      ...(this.phase === 'crashed' ? { crashPoint: r.crashPoint, hash: r.hash, crashedAtMs: msForMultiplier(r.crashPoint) } : {}),
    };
  }

  publicBet(b) {
    return { username: b.username, slot: b.slot, amount: b.amount, autoCashout: b.autoCashout, cashoutAt: b.cashoutAt, payout: b.payout };
  }

  snapshot() {
    return {
      round: this.publicRound(),
      bets: [...this.bets.values()].map((b) => this.publicBet(b)),
      history: this.history,
    };
  }

  myBets(userId) {
    return [...this.bets.values()].filter((b) => b.userId === userId).map((b) => this.publicBet(b));
  }

  /** Admin-only view including the secret crash point of the live round. */
  adminView() {
    const real = [...this.bets.values()].filter((b) => !b.isBot);
    return {
      ...this.publicRound(),
      crashPoint: this.round?.crashPoint,
      multiplier: this.currentMultiplier(),
      realBets: real.length,
      botBets: this.bets.size - real.length,
      wagered: real.reduce((s, b) => s + b.amount, 0),
      paidOut: real.reduce((s, b) => s + b.payout, 0),
      bets: real.map((b) => this.publicBet(b)),
    };
  }
}
