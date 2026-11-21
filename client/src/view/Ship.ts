import { Container, Graphics } from 'pixi.js';

/**
 * The "Nova Pod" - an original vector ship drawn with Graphics (no external art).
 * Points along +X; the scene rotates it along the curve tangent.
 */
export class Ship extends Container {
  private glow = new Graphics();
  private body = new Graphics();
  private time = 0;

  constructor() {
    super();
    this.drawGlow();
    this.drawBody();
    this.addChild(this.glow, this.body);
  }

  private drawGlow() {
    const g = this.glow;
    for (let i = 5; i >= 1; i--) g.circle(-4, 0, 10 + i * 5).fill({ color: 0x3df5d0, alpha: 0.035 });
  }

  private drawBody() {
    const g = this.body;
    // Rear fins
    g.poly([-14, -6, -26, -18, -20, -18, -6, -8]).fill(0xff7a45);
    g.poly([-14, 6, -26, 18, -20, 18, -6, 8]).fill(0xff7a45);
    // Hull: rounded capsule with a pointed nose
    g.moveTo(-18, -9)
      .lineTo(10, -9)
      .quadraticCurveTo(26, -7, 30, 0)
      .quadraticCurveTo(26, 7, 10, 9)
      .lineTo(-18, 9)
      .quadraticCurveTo(-23, 0, -18, -9)
      .fill(0xe9f1ff);
    // Belly stripe
    g.rect(-16, 3, 26, 3).fill(0x7b5cff);
    // Cockpit
    g.ellipse(9, -1.5, 7, 5).fill(0x1b2350);
    g.ellipse(10.5, -3, 3, 1.6).fill({ color: 0x9ffcf0, alpha: 0.9 });
    // Engine nozzle
    g.roundRect(-24, -5, 6, 10, 2).fill(0x5a6488);
    // Hull outline for crispness on dark backgrounds
    g.moveTo(-18, -9)
      .lineTo(10, -9)
      .quadraticCurveTo(26, -7, 30, 0)
      .quadraticCurveTo(26, 7, 10, 9)
      .lineTo(-18, 9)
      .quadraticCurveTo(-23, 0, -18, -9)
      .stroke({ width: 1.5, color: 0x9aa6d8, alpha: 0.8 });
  }

  /** Idle bobbing on the launch pad. */
  idle(dt: number) {
    this.time += dt;
    this.body.y = Math.sin(this.time * 3) * 2;
    this.glow.alpha = 0.7 + Math.sin(this.time * 5) * 0.3;
  }

  flying(dt: number) {
    this.time += dt;
    this.body.y = Math.sin(this.time * 18) * 0.8; // engine vibration
    this.glow.alpha = 1;
  }
}
