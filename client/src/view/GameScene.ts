// PixiJS renderer. Reads state from GameClient every frame; owns no game logic.
// When porting to Cocos, this is the only layer that needs to be rewritten.
import { Application, Container, Graphics, Sprite, Text, TextStyle, Texture } from 'pixi.js';
import type { GameClient } from '../core/GameClient';
import { msForMultiplier, rawMultiplierAt } from '../core/curve';
import type { PublicBet } from '../core/types';
import { Ship } from './Ship';

const PAD = { left: 54, right: 28, top: 24, bottom: 34 };
const COLORS = {
  curve: 0x3df5d0,
  crash: 0xff4d6d,
  grid: 0x2a3263,
  label: 0x7f8bc4,
  text: 0xffffff,
  win: 0x3df5d0,
};

interface Particle { s: Sprite; vx: number; vy: number; life: number; max: number; scale: number; }
interface Star { s: Sprite; speed: number; }
interface Floater { t: Text; life: number; }

export class GameScene {
  app = new Application();
  private world = new Container();
  private bg!: Sprite;
  private stars: Star[] = [];
  private grid = new Graphics();
  private curve = new Graphics();
  private fx = new Container();
  private ship = new Ship();
  private ring = new Graphics();
  private yLabels: Text[] = [];
  private xLabels: Text[] = [];
  private bigText!: Text;
  private subText!: Text;
  private bar = new Graphics();
  private particles: Particle[] = [];
  private floaters: Floater[] = [];
  private dot!: Texture;
  private shake = 0;
  private ringT = -1;
  private lastPhase = '';
  private scale = { maxT: 8000, maxM: 1.8 };

  constructor(private game: GameClient) {}

  async init(host: HTMLElement) {
    await this.app.init({ resizeTo: host, antialias: true, background: 0x0b0e24, resolution: Math.min(2, window.devicePixelRatio || 1), autoDensity: true });
    host.appendChild(this.app.canvas);

    this.bg = new Sprite(this.makeBackground());
    this.dot = this.makeDot();
    this.app.stage.addChild(this.bg, this.world);

    const starLayer = new Container();
    for (let i = 0; i < 140; i++) {
      const s = new Sprite(this.dot);
      s.anchor.set(0.5);
      const size = Math.random();
      s.scale.set(0.04 + size * 0.1);
      s.alpha = 0.25 + size * 0.6;
      s.x = Math.random() * 2000;
      s.y = Math.random() * 1200;
      starLayer.addChild(s);
      this.stars.push({ s, speed: 0.3 + size * 1.2 });
    }

    const font = 'Rajdhani, Inter, sans-serif';
    this.bigText = new Text({ text: '', style: new TextStyle({ fontFamily: font, fontWeight: '700', fontSize: 96, fill: COLORS.text, dropShadow: { color: 0x000000, alpha: 0.6, blur: 12, distance: 0, angle: 0 } }) });
    this.bigText.anchor.set(0.5);
    this.subText = new Text({ text: '', style: new TextStyle({ fontFamily: font, fontWeight: '600', fontSize: 22, fill: 0xb8c2ff, letterSpacing: 3 }) });
    this.subText.anchor.set(0.5);

    const labelStyle = new TextStyle({ fontFamily: 'Inter, sans-serif', fontSize: 11, fill: COLORS.label });
    for (let i = 0; i < 8; i++) {
      this.yLabels.push(new Text({ text: '', style: labelStyle }));
      this.xLabels.push(new Text({ text: '', style: labelStyle }));
    }

    this.world.addChild(starLayer, this.grid, ...this.yLabels, ...this.xLabels, this.curve, this.fx, this.ring, this.ship, this.bar, this.subText, this.bigText);

    this.game.on('cashout', (b: PublicBet) => this.onCashout(b));
    this.app.ticker.add((t) => this.update(t.deltaMS / 1000));
  }

  // ---------- helpers ----------

  private makeBackground() {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 512;
    const ctx = c.getContext('2d')!;
    const lin = ctx.createLinearGradient(0, 0, 0, 512);
    lin.addColorStop(0, '#0d1030');
    lin.addColorStop(1, '#070917');
    ctx.fillStyle = lin;
    ctx.fillRect(0, 0, 512, 512);
    const blob = (x: number, y: number, r: number, color: string) => {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, color);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 512, 512);
    };
    blob(420, 80, 260, 'rgba(123,92,255,0.28)');
    blob(80, 460, 220, 'rgba(61,245,208,0.12)');
    blob(300, 300, 160, 'rgba(255,122,69,0.06)');
    return Texture.from(c);
  }

  private makeDot() {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d')!;
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.8)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    return Texture.from(c);
  }

  private plot() {
    const { width, height } = this.app.screen;
    return { x0: PAD.left, y0: height - PAD.bottom, w: width - PAD.left - PAD.right, h: height - PAD.top - PAD.bottom };
  }

  private toScreen(t: number, m: number) {
    const p = this.plot();
    return {
      x: p.x0 + (t / this.scale.maxT) * p.w,
      y: p.y0 - ((m - 1) / (this.scale.maxM - 1)) * p.h,
    };
  }

  private spawn(x: number, y: number, vx: number, vy: number, life: number, scale: number, tint: number) {
    let p = this.particles.find((q) => q.life <= 0);
    if (!p) {
      const s = new Sprite(this.dot);
      s.anchor.set(0.5);
      s.blendMode = 'add';
      this.fx.addChild(s);
      p = { s, vx: 0, vy: 0, life: 0, max: 1, scale: 1 };
      this.particles.push(p);
    }
    Object.assign(p, { vx, vy, life, max: life, scale });
    p.s.position.set(x, y);
    p.s.tint = tint;
    p.s.visible = true;
  }

  private onCashout(b: PublicBet) {
    if (this.game.round.phase !== 'running' || b.cashoutAt == null) return;
    const mine = b.username === this.game.user?.username;
    if (!mine && this.floaters.length > 6) return;
    const t = new Text({
      text: `${mine ? 'YOU' : b.username} ${b.cashoutAt.toFixed(2)}x`,
      style: new TextStyle({ fontFamily: 'Rajdhani, sans-serif', fontWeight: '700', fontSize: mine ? 22 : 13, fill: mine ? COLORS.win : 0xc9d1ff }),
    });
    t.anchor.set(0.5);
    const head = this.toScreen(this.game.elapsedMs(), rawMultiplierAt(this.game.elapsedMs()));
    t.position.set(head.x - 30 - Math.random() * 60, head.y + 20 + Math.random() * 30);
    this.world.addChild(t);
    this.floaters.push({ t, life: mine ? 1.8 : 1.2 });
  }

  private niceStep(range: number, target: number, steps: number[]) {
    for (const s of steps) if (range / s <= target) return s;
    return steps[steps.length - 1];
  }

  // ---------- frame ----------

  private update(dt: number) {
    const g = this.game;
    const { width, height } = this.app.screen;
    const phase = g.round.phase;
    this.bg.width = width;
    this.bg.height = height;

    if (phase !== this.lastPhase) {
      if (phase === 'crashed') this.explode();
      this.lastPhase = phase;
    }

    const t = g.elapsedMs();
    const mRaw = phase === 'crashed' ? (g.round.crashPoint ?? 1) : rawMultiplierAt(t);
    const flying = phase === 'running' || phase === 'crashed';

    // Axis scale: keep the head at ~80% width / ~75% height once it outgrows the default view.
    const targetT = flying ? Math.max(8000, t / 0.8) : 8000;
    const targetM = flying ? Math.max(1.8, 1 + (mRaw - 1) / 0.75) : 1.8;
    this.scale.maxT += (targetT - this.scale.maxT) * Math.min(1, dt * 8);
    this.scale.maxM += (targetM - this.scale.maxM) * Math.min(1, dt * 8);

    // Stars drift faster as the multiplier grows.
    const speed = phase === 'running' ? 40 + Math.log(mRaw) * 220 : 12;
    for (const st of this.stars) {
      st.s.x -= st.speed * speed * dt;
      st.s.y += st.speed * speed * dt * 0.35;
      if (st.s.x < -10) st.s.x += width + 20;
      if (st.s.y > height + 10) st.s.y -= height + 20;
    }

    this.drawGrid();
    this.drawCurve(phase, t, mRaw);
    this.drawShip(phase, t, mRaw, dt);
    this.drawHud(phase, width, height);
    this.updateFx(dt);

    // Screen shake after a crash.
    if (this.shake > 0) {
      this.shake -= dt;
      const k = Math.max(0, this.shake) * 18;
      this.world.position.set((Math.random() - 0.5) * k, (Math.random() - 0.5) * k);
    } else {
      this.world.position.set(0, 0);
    }
  }

  private drawGrid() {
    const p = this.plot();
    const gr = this.grid.clear();
    const mRange = this.scale.maxM - 1;
    const yStep = this.niceStep(mRange, 4, [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 500, 1000, 2000, 5000]);
    let i = 0;
    for (let v = 1; v <= this.scale.maxM + 1e-9 && i < this.yLabels.length; v += yStep, i++) {
      const y = p.y0 - ((v - 1) / mRange) * p.h;
      gr.moveTo(p.x0, y).lineTo(p.x0 + p.w, y).stroke({ width: 1, color: COLORS.grid, alpha: v === 1 ? 0.9 : 0.5 });
      const lbl = this.yLabels[i];
      lbl.visible = true;
      lbl.text = `${v.toFixed(yStep < 1 ? 1 : 0)}x`;
      lbl.position.set(p.x0 - 8 - lbl.width, y - lbl.height / 2);
    }
    for (; i < this.yLabels.length; i++) this.yLabels[i].visible = false;

    const tSec = this.scale.maxT / 1000;
    const xStep = this.niceStep(tSec, 6, [1, 2, 5, 10, 15, 30, 60, 120, 300]);
    i = 0;
    for (let s = xStep; s <= tSec && i < this.xLabels.length; s += xStep, i++) {
      const x = p.x0 + (s / tSec) * p.w;
      gr.moveTo(x, p.y0).lineTo(x, p.y0 + 5).stroke({ width: 1, color: COLORS.grid });
      const lbl = this.xLabels[i];
      lbl.visible = true;
      lbl.text = `${s}s`;
      lbl.position.set(x - lbl.width / 2, p.y0 + 9);
    }
    for (; i < this.xLabels.length; i++) this.xLabels[i].visible = false;
    gr.moveTo(p.x0, p.y0).lineTo(p.x0 + p.w, p.y0).stroke({ width: 1.5, color: COLORS.grid });
  }

  private drawCurve(phase: string, t: number, mEnd: number) {
    const c = this.curve.clear();
    if (phase !== 'running' && phase !== 'crashed') return;
    const color = phase === 'crashed' ? COLORS.crash : COLORS.curve;
    const tEnd = phase === 'crashed' ? msForMultiplier(Math.max(1.0001, mEnd)) : t;
    const pts: number[] = [];
    const N = 64;
    for (let i = 0; i <= N; i++) {
      const tt = (tEnd * i) / N;
      const s = this.toScreen(tt, rawMultiplierAt(tt));
      pts.push(s.x, s.y);
    }
    const p = this.plot();
    const last = pts.length - 2;
    c.poly([...pts, pts[last], p.y0, p.x0, p.y0]).fill({ color, alpha: 0.12 });
    for (const [w, a] of [[12, 0.08], [6, 0.2], [3, 1]] as const) {
      c.moveTo(pts[0], pts[1]);
      for (let i = 2; i < pts.length; i += 2) c.lineTo(pts[i], pts[i + 1]);
      c.stroke({ width: w, color, alpha: a, cap: 'round', join: 'round' });
    }
  }

  private drawShip(phase: string, t: number, m: number, dt: number) {
    const ship = this.ship;
    if (phase === 'running') {
      const head = this.toScreen(t, m);
      const ahead = this.toScreen(t + 250, rawMultiplierAt(t + 250));
      const angle = Math.atan2(ahead.y - head.y, ahead.x - head.x);
      ship.visible = true;
      ship.alpha = 1;
      ship.position.set(head.x, head.y);
      ship.rotation += (angle - ship.rotation) * Math.min(1, dt * 10);
      ship.scale.set(1.15);
      ship.flying(dt);
      // Engine exhaust.
      const back = { x: head.x - Math.cos(ship.rotation) * 26, y: head.y - Math.sin(ship.rotation) * 26 };
      for (let i = 0; i < 3; i++) {
        const sp = 80 + Math.random() * 120;
        const a = ship.rotation + Math.PI + (Math.random() - 0.5) * 0.6;
        this.spawn(back.x, back.y, Math.cos(a) * sp, Math.sin(a) * sp, 0.35 + Math.random() * 0.25, 0.28 + Math.random() * 0.15, Math.random() < 0.5 ? 0xff7a45 : 0xffc857);
      }
    } else if (phase === 'betting' || phase === 'paused' || phase === 'connecting') {
      const p = this.plot();
      ship.visible = true;
      ship.alpha = phase === 'betting' ? 1 : 0.5;
      ship.rotation = -0.35;
      ship.scale.set(1.15);
      ship.position.set(p.x0 + 34, p.y0 - 26);
      ship.idle(dt);
      if (phase === 'betting' && Math.random() < 0.5) {
        this.spawn(ship.x - 28, ship.y + 10, -20 - Math.random() * 30, 10 + Math.random() * 20, 0.4, 0.15, 0xff7a45);
      }
    } else {
      ship.visible = false;
    }
  }

  private drawHud(phase: string, width: number, height: number) {
    const g = this.game;
    const cx = width / 2;
    const cy = height * 0.42;
    const big = this.bigText;
    const sub = this.subText;
    const bar = this.bar.clear();
    big.style.fontSize = Math.max(48, Math.min(110, width / 7));
    big.position.set(cx, cy);
    sub.position.set(cx, cy + big.height / 2 + 18);

    if (phase === 'running') {
      big.text = `${g.multiplier().toFixed(2)}x`;
      big.style.fill = COLORS.text;
      sub.text = '';
    } else if (phase === 'crashed') {
      big.text = `${(g.round.crashPoint ?? 1).toFixed(2)}x`;
      big.style.fill = COLORS.crash;
      sub.text = 'CRASHED';
      sub.style.fill = COLORS.crash;
    } else if (phase === 'betting') {
      const rem = g.bettingRemainingMs();
      big.text = `${(rem / 1000).toFixed(1)}s`;
      big.style.fill = COLORS.text;
      sub.text = 'PLACE YOUR BETS';
      sub.style.fill = 0xb8c2ff;
      const total = g.config.bettingMs || 6000;
      const bw = Math.min(320, width * 0.5);
      const by = sub.y + 24;
      bar.roundRect(cx - bw / 2, by, bw, 6, 3).fill({ color: 0xffffff, alpha: 0.12 });
      bar.roundRect(cx - bw / 2, by, bw * Math.min(1, rem / total), 6, 3).fill(COLORS.curve);
    } else if (phase === 'paused') {
      big.text = 'PAUSED';
      big.style.fill = 0xffc857;
      sub.text = 'THE OPERATOR HAS PAUSED THE GAME';
      sub.style.fill = 0xb8c2ff;
    } else {
      big.text = '...';
      big.style.fill = COLORS.label;
      sub.text = 'CONNECTING';
      sub.style.fill = COLORS.label;
    }
  }

  private explode() {
    const g = this.game;
    const t = g.elapsedMs();
    const head = this.toScreen(t, g.round.crashPoint ?? 1);
    for (let i = 0; i < 70; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 60 + Math.random() * 360;
      const tint = [0xff4d6d, 0xff7a45, 0xffc857, 0xffffff][i % 4];
      this.spawn(head.x, head.y, Math.cos(a) * sp, Math.sin(a) * sp, 0.6 + Math.random() * 0.7, 0.2 + Math.random() * 0.5, tint);
    }
    this.ring.position.set(head.x, head.y);
    this.ringT = 0;
    this.shake = 0.45;
  }

  private updateFx(dt: number) {
    for (const p of this.particles) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) { p.s.visible = false; continue; }
      p.vx *= 1 - dt * 2.2;
      p.vy *= 1 - dt * 2.2;
      p.s.x += p.vx * dt;
      p.s.y += p.vy * dt;
      const k = p.life / p.max;
      p.s.alpha = k;
      p.s.scale.set(p.scale * (0.4 + k * 0.6));
    }
    if (this.ringT >= 0) {
      this.ringT += dt;
      const k = this.ringT / 0.6;
      this.ring.clear();
      if (k >= 1) this.ringT = -1;
      else this.ring.circle(0, 0, 10 + k * 90).stroke({ width: 4 * (1 - k), color: 0xffc857, alpha: 1 - k });
    }
    this.floaters = this.floaters.filter((f) => {
      f.life -= dt;
      f.t.y -= dt * 40;
      f.t.alpha = Math.min(1, f.life * 2);
      if (f.life <= 0) { f.t.destroy(); return false; }
      return true;
    });
  }
}
