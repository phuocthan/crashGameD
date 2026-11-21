// One betting slot (the UI shows two). DOM-based; logic only talks to GameClient.
import type { GameClient } from '../core/GameClient';
import { money } from '../core/curve';
import { toast } from './toast';

type View = 'login' | 'idle' | 'queued' | 'placed' | 'active' | 'won' | 'lost' | 'busy';

export class BetPanel {
  el: HTMLElement;
  private amountInput: HTMLInputElement;
  private autoToggle: HTMLInputElement;
  private autoInput: HTMLInputElement;
  private autoBetToggle: HTMLInputElement;
  private btn: HTMLButtonElement;
  private btnMain: HTMLElement;
  private btnSub: HTMLElement;
  private queued = false;
  private busy = false;
  private lastKey = '';

  constructor(private game: GameClient, private slot: number, private onLogin: () => void) {
    this.el = document.createElement('div');
    this.el.className = 'bet-panel';
    this.el.innerHTML = `
      <div class="bp-row">
        <div class="stepper">
          <button data-step="-1" aria-label="Decrease">−</button>
          <input class="amount" type="number" inputmode="decimal" min="1" step="1" value="${slot === 0 ? 10 : 5}" aria-label="Bet amount" />
          <button data-step="1" aria-label="Increase">+</button>
        </div>
        <div class="quick">
          <button data-q="half">½</button><button data-q="double">2×</button>
          <button data-q="10">10</button><button data-q="50">50</button><button data-q="100">100</button>
        </div>
      </div>
      <div class="bp-row opts">
        <label class="switch"><input type="checkbox" class="auto-toggle" /><span></span>Auto cash-out</label>
        <div class="auto-wrap"><input class="auto" type="number" step="0.01" min="1.01" value="2.00" aria-label="Auto cash-out multiplier" /><b>x</b></div>
        <label class="switch"><input type="checkbox" class="autobet-toggle" /><span></span>Auto bet</label>
      </div>
      <button class="bet-btn"><span class="main"></span><span class="sub"></span></button>`;
    this.amountInput = this.el.querySelector('.amount')!;
    this.autoToggle = this.el.querySelector('.auto-toggle')!;
    this.autoInput = this.el.querySelector('.auto')!;
    this.autoBetToggle = this.el.querySelector('.autobet-toggle')!;
    this.btn = this.el.querySelector('.bet-btn')!;
    this.btnMain = this.btn.querySelector('.main')!;
    this.btnSub = this.btn.querySelector('.sub')!;

    this.el.querySelectorAll<HTMLButtonElement>('[data-step]').forEach((b) =>
      b.addEventListener('click', () => this.setAmount(this.amount() / 100 + Number(b.dataset.step))));
    this.el.querySelectorAll<HTMLButtonElement>('[data-q]').forEach((b) =>
      b.addEventListener('click', () => {
        const q = b.dataset.q!;
        const cur = this.amount() / 100;
        this.setAmount(q === 'half' ? cur / 2 : q === 'double' ? cur * 2 : Number(q));
      }));
    this.btn.addEventListener('click', () => this.onClick());

    game.on('round', () => {
      if (game.round.phase === 'betting' && (this.queued || this.autoBetToggle.checked) && game.user && !game.myBet(slot)) {
        this.queued = false;
        this.place();
      }
    });
  }

  private amount() {
    return Math.round(Number(this.amountInput.value) * 100) || 0;
  }

  private setAmount(v: number) {
    const { minBet, maxBet } = this.game.config;
    const clamped = Math.min(maxBet, Math.max(minBet, Math.round(v * 100)));
    this.amountInput.value = String(clamped / 100);
  }

  private autoValue() {
    return this.autoToggle.checked ? Number(this.autoInput.value) : null;
  }

  private async place() {
    this.busy = true;
    const a = await this.game.placeBet(this.slot, this.amount(), this.autoValue());
    this.busy = false;
    if (!a.ok) {
      toast(a.error || 'Bet failed', 'error');
      if (a.code === 'NO_FUNDS') this.autoBetToggle.checked = false;
    }
  }

  private async onClick() {
    const view = this.view();
    if (view === 'login') return this.onLogin();
    if (view === 'busy' || view === 'won' || view === 'lost') return;
    if (view === 'queued') { this.queued = false; return; }
    if (view === 'idle') {
      if (this.game.round.phase === 'betting') return this.place();
      this.queued = true;
      return;
    }
    if (view === 'placed') {
      this.busy = true;
      const a = await this.game.cancelBet(this.slot);
      this.busy = false;
      if (!a.ok) toast(a.error || 'Cancel failed', 'error');
      return;
    }
    if (view === 'active') {
      this.busy = true;
      const a = await this.game.cashout(this.slot);
      this.busy = false;
      if (!a.ok) toast(a.error || 'Cash-out failed', 'error');
      else toast(`Cashed out ${money((a.bet as any).payout)} at ${(a.bet as any).cashoutAt.toFixed(2)}x`, 'win');
    }
  }

  private view(): View {
    const g = this.game;
    if (!g.user) return 'login';
    if (this.busy) return 'busy';
    const bet = g.myBet(this.slot);
    const phase = g.round.phase;
    if (bet) {
      if (bet.cashoutAt != null) return 'won';
      if (phase === 'betting') return 'placed';
      if (phase === 'running') return 'active';
      if (phase === 'crashed') return 'lost';
    }
    if (this.queued) return 'queued';
    return 'idle';
  }

  /** Called every animation frame; only touches the DOM when something visible changed. */
  render() {
    const g = this.game;
    const view = this.view();
    const bet = g.myBet(this.slot);
    let main = '', sub = '';
    switch (view) {
      case 'login': main = 'LOG IN TO PLAY'; break;
      case 'busy': main = '...'; break;
      case 'idle':
        main = 'BET';
        sub = `${money(this.amount())}${g.round.phase === 'betting' ? '' : ' · next round'}`;
        break;
      case 'queued': main = 'WAITING'; sub = 'next round · tap to cancel'; break;
      case 'placed': main = 'CANCEL'; sub = `${money(bet!.amount)} placed`; break;
      case 'active': main = 'CASH OUT'; sub = money(Math.floor(bet!.amount * g.multiplier())); break;
      case 'won': main = `WON ${money(bet!.payout)}`; sub = `at ${bet!.cashoutAt!.toFixed(2)}x`; break;
      case 'lost': main = 'LOST'; sub = money(bet!.amount); break;
    }
    const key = `${view}|${main}|${sub}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.btn.dataset.view = view;
    this.btnMain.textContent = main;
    this.btnSub.textContent = sub;
    const locked = view === 'placed' || view === 'active' || view === 'won' || view === 'lost' || view === 'queued';
    this.el.classList.toggle('locked', locked);
    for (const input of this.el.querySelectorAll<HTMLInputElement | HTMLButtonElement>('.bp-row input:not(.autobet-toggle), .bp-row button')) {
      input.disabled = locked;
    }
  }
}
