// WebSocket hub: pushes game events to clients and accepts bet / cancel / cashout commands.
// Wire format: JSON { t: <type>, d: <payload> }. See docs/PROTOCOL.md.
import { WebSocketServer } from 'ws';
import { GameError } from './game.js';

export class Hub {
  constructor({ server, db, engine, settings }) {
    this.db = db;
    this.engine = engine;
    this.settings = settings;
    this.clients = new Set();
    this.userByToken = db.prepare('SELECT * FROM users WHERE token = ?');
    this.touch = db.prepare('UPDATE users SET last_seen = ? WHERE id = ?');

    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.wss.on('connection', (ws) => this.onConnection(ws));

    const forward = (type) => (d) => this.broadcast(type, d);
    engine.on('betting', forward('round:betting'));
    engine.on('running', forward('round:running'));
    engine.on('crashed', forward('round:crashed'));
    engine.on('paused', () => this.broadcast('round:paused', {}));
    engine.on('bet', forward('bet'));
    engine.on('cancel', forward('cancel'));
    engine.on('cashout', forward('cashout'));
    engine.on('balance', (userId, balance) => this.sendBalance(userId, balance));

    // Heartbeat: drop dead sockets.
    this.hb = setInterval(() => {
      for (const ws of this.clients) {
        if (!ws.alive) { ws.terminate(); continue; }
        ws.alive = false;
        ws.ping();
      }
    }, 15000);
    this.onlineTimer = setInterval(() => this.broadcast('online', { count: this.onlineCount() }), 5000);
  }

  onConnection(ws) {
    ws.alive = true;
    ws.user = null;
    ws.on('pong', () => { ws.alive = true; });
    this.clients.add(ws);
    ws.on('close', () => this.clients.delete(ws));
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      this.handle(ws, msg?.t, msg?.d || {});
    });
    this.send(ws, 'hello', {
      serverTime: Date.now(),
      config: this.publicConfig(),
      online: this.onlineCount(),
      ...this.engine.snapshot(),
    });
  }

  handle(ws, type, d) {
    const reply = (ok, data) => this.send(ws, 'ack', { reqId: d.reqId, ok, ...data });
    try {
      switch (type) {
        case 'ping':
          return this.send(ws, 'pong', { c: d.c, serverTime: Date.now() });
        case 'auth': {
          const user = this.userByToken.get(String(d.token || ''));
          if (!user || user.banned) return reply(false, { code: 'AUTH', error: 'Invalid session' });
          ws.user = { id: user.id, username: user.username };
          this.touch.run(Date.now(), user.id);
          return reply(true, { user: { id: user.id, username: user.username, balance: user.balance }, myBets: this.engine.myBets(user.id) });
        }
        case 'bet':
          this.requireAuth(ws);
          return reply(true, { bet: this.engine.placeBet(ws.user.id, d) });
        case 'cancel':
          this.requireAuth(ws);
          this.engine.cancelBet(ws.user.id, d.slot);
          return reply(true, {});
        case 'cashout':
          this.requireAuth(ws);
          return reply(true, { bet: this.engine.cashout(ws.user.id, d.slot) });
        default:
          return reply(false, { code: 'UNKNOWN', error: `Unknown message ${type}` });
      }
    } catch (e) {
      if (e instanceof GameError) return reply(false, { code: e.code, error: e.message });
      console.error(e);
      return reply(false, { code: 'INTERNAL', error: 'Server error' });
    }
  }

  requireAuth(ws) {
    if (!ws.user) throw new GameError('AUTH', 'Please log in first');
  }

  publicConfig() {
    const s = this.settings.all();
    return { minBet: s.minBet, maxBet: s.maxBet, maxAutoCashout: s.maxAutoCashout, houseEdge: s.houseEdge, bettingMs: s.bettingMs };
  }

  send(ws, t, d) {
    if (ws.readyState === 1) ws.send(JSON.stringify({ t, d }));
  }

  broadcast(t, d) {
    const data = JSON.stringify({ t, d });
    for (const ws of this.clients) if (ws.readyState === 1) ws.send(data);
  }

  broadcastConfig() {
    this.broadcast('config', this.publicConfig());
  }

  sendBalance(userId, balance) {
    for (const ws of this.clients) if (ws.user?.id === userId) this.send(ws, 'balance', { balance });
  }

  kickUser(userId) {
    for (const ws of this.clients) {
      if (ws.user?.id === userId) {
        this.send(ws, 'kicked', { reason: 'Account suspended' });
        ws.close();
      }
    }
  }

  onlineCount() {
    return this.clients.size;
  }

  onlineUserIds() {
    return new Set([...this.clients].filter((ws) => ws.user).map((ws) => ws.user.id));
  }

  close() {
    clearInterval(this.hb);
    clearInterval(this.onlineTimer);
    this.wss.close();
  }
}
