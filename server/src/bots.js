// Display-only bots so a local demo lobby doesn't look empty.
// They never touch the database or real balances and are excluded from all stats.
const ADJ = ['Lucky', 'Swift', 'Cosmic', 'Neon', 'Silent', 'Brave', 'Pixel', 'Turbo', 'Solar', 'Frosty', 'Rapid', 'Zen'];
const NOUN = ['Fox', 'Comet', 'Otter', 'Pilot', 'Nova', 'Hawk', 'Panda', 'Raven', 'Lynx', 'Orbit', 'Tiger', 'Moth'];

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

export class BotCrowd {
  constructor(engine) {
    this.engine = engine;
    this.timers = [];
    this.names = Array.from({ length: 100 }, () => `${pick(ADJ)}${pick(NOUN)}${Math.floor(rand(10, 99))}`);
  }

  onBetting(count, windowMs) {
    this.clear();
    const n = Math.floor(count * rand(0.6, 1));
    const names = [...this.names].sort(() => Math.random() - 0.5).slice(0, n);
    for (const username of names) {
      const t = setTimeout(() => {
        const amount = Math.round(pick([1, 2, 5, 10, 20, 50, 100, 250]) * rand(1, 3)) * 100;
        // Heavy-tailed auto cash-out targets, most between 1.2x and 3x.
        const autoCashout = Math.floor(Math.min(50, 1.1 + Math.pow(Math.random(), 3) * 20) * 100) / 100;
        this.engine.addBotBet({ username, slot: 0, amount, autoCashout });
      }, rand(200, windowMs - 300));
      this.timers.push(t);
    }
  }

  clear() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}
