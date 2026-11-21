// Network + state layer. Pure TypeScript with no renderer dependency, so it can be reused
// as-is in a Cocos Creator project (Cocos also runs TS and has WebSocket).
//
// Events emitted:
//   'status'  (connected: boolean)
//   'round'   (RoundInfo)              phase changes
//   'bets'    ()                       round bet list changed
//   'cashout' (PublicBet)
//   'history' (number[])
//   'user'    (User | null)
//   'balance' (number)
//   'online'  (number)
//   'config'  (GameConfig)
//   'kicked'  (reason: string)
import { Emitter } from './emitter';
import { multiplierAt } from './curve';
import type { Ack, GameConfig, PublicBet, RoundInfo, User } from './types';

export class GameClient extends Emitter {
  round: RoundInfo = { phase: 'connecting' };
  bets = new Map<string, PublicBet>();
  history: number[] = [];
  config: GameConfig = { minBet: 100, maxBet: 100000, maxAutoCashout: 1000, houseEdge: 0.03, bettingMs: 6000 };
  user: User | null = null;
  online = 0;
  connected = false;

  private ws: WebSocket | null = null;
  private reqId = 0;
  private pending = new Map<number, (a: Ack) => void>();
  private clockOffset = 0;   // serverTime - localTime
  private bestRtt = Infinity;
  private retry = 0;
  private pingTimer: number | undefined;
  private token: string | null;

  constructor(private url: string, private apiBase = '') {
    super();
    this.token = safeGet('nova.token');
  }

  // ---------- clock ----------
  serverNow() { return Date.now() + this.clockOffset; }

  elapsedMs() {
    if (this.round.phase === 'running' && this.round.startedAt) return Math.max(0, this.serverNow() - this.round.startedAt);
    if (this.round.phase === 'crashed' && this.round.crashedAtMs != null) return this.round.crashedAtMs;
    return 0;
  }

  multiplier() {
    if (this.round.phase === 'crashed') return this.round.crashPoint ?? 1;
    if (this.round.phase !== 'running') return 1;
    const m = multiplierAt(this.elapsedMs());
    // Never display past the crash point if it's known (it isn't until the crash message).
    return m;
  }

  bettingRemainingMs() {
    if (this.round.phase !== 'betting' || !this.round.bettingEndsAt) return 0;
    return Math.max(0, this.round.bettingEndsAt - this.serverNow());
  }

  myBet(slot: number) {
    return this.user ? this.bets.get(`${this.user.username}:${slot}`) : undefined;
  }

  // ---------- auth ----------
  async login(username: string) {
    const res = await fetch(`${this.apiBase}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    this.token = data.token;
    safeSet('nova.token', data.token);
    await this.auth();
  }

  logout() {
    this.token = null;
    safeSet('nova.token', null);
    this.user = null;
    this.emit('user', null);
    this.ws?.close();
  }

  async fetchMyBets() {
    if (!this.token) return [];
    const res = await fetch(`${this.apiBase}/api/my-bets`, { headers: { authorization: `Bearer ${this.token}` } });
    return res.ok ? (await res.json()).bets : [];
  }

  private async auth() {
    if (!this.token || !this.connected) return;
    const a = await this.request('auth', { token: this.token });
    if (a.ok) {
      this.user = a.user as User;
      for (const b of (a.myBets as PublicBet[]) || []) this.bets.set(`${b.username}:${b.slot}`, b);
      this.emit('user', this.user);
      this.emit('bets');
    } else {
      this.token = null;
      safeSet('nova.token', null);
      this.emit('user', null);
    }
  }

  // ---------- commands ----------
  placeBet(slot: number, amount: number, autoCashout: number | null) {
    return this.request('bet', { slot, amount, autoCashout });
  }
  cancelBet(slot: number) { return this.request('cancel', { slot }); }
  cashout(slot: number) { return this.request('cashout', { slot }); }

  request(t: string, d: Record<string, unknown> = {}): Promise<Ack> {
    return new Promise((resolve) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return resolve({ reqId: 0, ok: false, code: 'OFFLINE', error: 'Not connected' });
      }
      const reqId = ++this.reqId;
      this.pending.set(reqId, resolve);
      this.ws.send(JSON.stringify({ t, d: { ...d, reqId } }));
      setTimeout(() => {
        if (this.pending.delete(reqId)) resolve({ reqId, ok: false, code: 'TIMEOUT', error: 'Request timed out' });
      }, 8000);
    });
  }

  // ---------- connection ----------
  connect() {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.retry = 0;
      this.bestRtt = Infinity;
      this.emit('status', true);
      this.ping();
      clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.ping(), 5000);
    };
    ws.onmessage = (e) => {
      try {
        const { t, d } = JSON.parse(e.data);
        this.onMessage(t, d);
      } catch (err) {
        console.error('bad message', err);
      }
    };
    ws.onclose = () => {
      this.connected = false;
      clearInterval(this.pingTimer);
      for (const resolve of this.pending.values()) resolve({ reqId: 0, ok: false, code: 'OFFLINE', error: 'Disconnected' });
      this.pending.clear();
      this.round = { phase: 'connecting' };
      this.emit('status', false);
      this.emit('round', this.round);
      const delay = Math.min(10000, 500 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
  }

  private ping() {
    this.ws?.readyState === WebSocket.OPEN && this.ws.send(JSON.stringify({ t: 'ping', d: { c: Date.now() } }));
  }

  private onMessage(t: string, d: any) {
    switch (t) {
      case 'hello':
        this.clockOffset = d.serverTime - Date.now();
        this.config = d.config;
        this.online = d.online;
        this.history = d.history;
        this.setRound(d.round);
        this.bets.clear();
        for (const b of d.bets as PublicBet[]) this.bets.set(`${b.username}:${b.slot}`, b);
        this.emit('config', this.config);
        this.emit('online', this.online);
        this.emit('history', this.history);
        this.emit('bets');
        this.auth();
        break;
      case 'pong': {
        const now = Date.now();
        const rtt = now - d.c;
        if (rtt <= this.bestRtt) {
          this.bestRtt = rtt;
          this.clockOffset = d.serverTime - (d.c + rtt / 2);
        }
        break;
      }
      case 'ack': {
        const resolve = this.pending.get(d.reqId);
        if (resolve) { this.pending.delete(d.reqId); resolve(d); }
        break;
      }
      case 'round:betting':
        this.bets.clear();
        this.setRound(d);
        this.emit('bets');
        break;
      case 'round:running':
        this.setRound(d);
        break;
      case 'round:crashed':
        this.history = [d.crashPoint, ...this.history].slice(0, 30);
        this.setRound(d);
        this.emit('history', this.history);
        break;
      case 'round:paused':
        this.bets.clear();
        this.setRound({ phase: 'paused' });
        this.emit('bets');
        break;
      case 'bet':
        this.bets.set(`${d.username}:${d.slot}`, d);
        this.emit('bets');
        break;
      case 'cancel':
        this.bets.delete(`${d.username}:${d.slot}`);
        this.emit('bets');
        break;
      case 'cashout':
        this.bets.set(`${d.username}:${d.slot}`, d);
        this.emit('cashout', d);
        this.emit('bets');
        break;
      case 'balance':
        if (this.user) this.user.balance = d.balance;
        this.emit('balance', d.balance);
        break;
      case 'online':
        this.online = d.count;
        this.emit('online', this.online);
        break;
      case 'config':
        this.config = d;
        this.emit('config', this.config);
        break;
      case 'kicked':
        this.logout();
        this.emit('kicked', d.reason);
        break;
    }
  }

  private setRound(r: RoundInfo) {
    this.round = r;
    this.emit('round', r);
  }
}

function safeGet(k: string) {
  try { return localStorage.getItem(k); } catch { return null; }
}
function safeSet(k: string, v: string | null) {
  try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* storage unavailable */ }
}
