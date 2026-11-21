import './style.css';
import { GameClient } from './core/GameClient';
import { money } from './core/curve';
import type { PublicBet } from './core/types';
import { GameScene } from './view/GameScene';
import { BetPanel } from './ui/BetPanel';
import { openFairness } from './ui/fairness';
import { toast } from './ui/toast';

const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
const game = new GameClient(wsUrl);

const app = document.getElementById('app')!;
app.innerHTML = `
  <header class="top">
    <div class="brand"><span class="logo-mark"></span>NOVA<b>RUSH</b></div>
    <div class="top-right">
      <span class="online" title="Players online"><i></i><span class="online-n">0</span></span>
      <button class="ghost fair-btn" title="Provably fair">Fairness</button>
      <div class="wallet" hidden><span class="muted">Balance</span><b class="balance">0.00</b></div>
      <button class="user-btn primary">Log in</button>
    </div>
  </header>
  <main class="layout">
    <section class="stage">
      <div class="history" aria-label="Recent crash points"></div>
      <div class="canvas-host"></div>
      <div class="panels"></div>
    </section>
    <aside class="side">
      <div class="tabs" role="tablist">
        <button class="tab active" data-tab="round" role="tab">This round</button>
        <button class="tab" data-tab="mine" role="tab">My bets</button>
      </div>
      <div class="round-summary"><span><b class="bet-count">0</b> bets</span><span>Total <b class="bet-total">0.00</b></span></div>
      <div class="list round-list"></div>
      <div class="list mine-list" hidden></div>
    </aside>
  </main>
  <div class="modal" hidden><div class="modal-card" role="dialog" aria-modal="true">
    <div class="modal-head"><h3></h3><button class="ghost close" aria-label="Close">✕</button></div>
    <div class="modal-body"></div>
  </div></div>`;

const $ = <T extends HTMLElement = HTMLElement>(s: string) => app.querySelector<T>(s)!;

// ---------- modal ----------
const modalEl = $('.modal');
function openModal(title: string, body: HTMLElement) {
  modalEl.querySelector('h3')!.textContent = title;
  const b = modalEl.querySelector('.modal-body')!;
  b.replaceChildren(body);
  modalEl.hidden = false;
}
const closeModal = () => { modalEl.hidden = true; };
modalEl.addEventListener('click', (e) => { if (e.target === modalEl) closeModal(); });
modalEl.querySelector('.close')!.addEventListener('click', closeModal);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

function openLogin() {
  const form = document.createElement('form');
  form.className = 'login';
  form.innerHTML = `
    <p class="muted">Demo mode: pick a username to get free play credits. No password, no real money.</p>
    <input name="u" placeholder="Username" autocomplete="username" required minlength="3" maxlength="16" pattern="[A-Za-z0-9_]+" />
    <button class="primary">Start playing</button>`;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await game.login(String(new FormData(form).get('u')));
      closeModal();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  });
  openModal('Join Nova Rush', form);
  setTimeout(() => form.querySelector('input')!.focus(), 0);
}

$('.user-btn').addEventListener('click', () => {
  if (game.user) {
    if (confirm(`Log out ${game.user.username}?`)) game.logout();
  } else openLogin();
});
$('.fair-btn').addEventListener('click', () => openFairness(openModal));

// ---------- header ----------
const renderUser = () => {
  $('.user-btn').textContent = game.user ? game.user.username : 'Log in';
  $('.user-btn').classList.toggle('primary', !game.user);
  $('.wallet').hidden = !game.user;
  if (game.user) $('.balance').textContent = money(game.user.balance);
};
game.on('user', renderUser);
game.on('balance', renderUser);
game.on('online', (n: number) => { $('.online-n').textContent = String(n); });
game.on('kicked', (reason: string) => toast(reason, 'error'));
game.on('status', (ok: boolean) => { if (!ok) toast('Connection lost - reconnecting…', 'error'); });

// ---------- history ----------
const tier = (m: number) => (m >= 10 ? 't4' : m >= 3 ? 't3' : m >= 2 ? 't2' : 't1');
game.on('history', (h: number[]) => {
  $('.history').innerHTML = h.slice(0, 20).map((m) => `<span class="pill ${tier(m)}">${m.toFixed(2)}x</span>`).join('');
});

// ---------- bet panels ----------
const panels = [0, 1].map((slot) => new BetPanel(game, slot, openLogin));
panels.forEach((p) => $('.panels').appendChild(p.el));

// ---------- side lists ----------
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
let listDirty = true;
game.on('bets', () => { listDirty = true; });
game.on('round', () => { listDirty = true; });

function renderRoundList() {
  const bets = [...game.bets.values()].sort((a, b) => b.amount - a.amount);
  $('.bet-count').textContent = String(bets.length);
  $('.bet-total').textContent = money(bets.reduce((s, b) => s + b.amount, 0));
  const crashed = game.round.phase === 'crashed';
  const me = game.user?.username;
  $('.round-list').innerHTML = bets.map((b: PublicBet) => {
    const state = b.cashoutAt != null ? 'won' : crashed ? 'lost' : '';
    return `<div class="bet-row ${state} ${b.username === me ? 'me' : ''}">
      <span class="name">${esc(b.username)}</span>
      <span class="amt">${money(b.amount)}</span>
      <span class="mult">${b.cashoutAt != null ? b.cashoutAt.toFixed(2) + 'x' : ''}</span>
      <span class="pay">${b.cashoutAt != null ? money(b.payout) : crashed ? '–' : ''}</span>
    </div>`;
  }).join('') || '<p class="empty">No bets yet</p>';
}

async function renderMine() {
  const list = $('.mine-list');
  if (!game.user) { list.innerHTML = '<p class="empty">Log in to see your bets</p>'; return; }
  const bets = await game.fetchMyBets();
  list.innerHTML = bets.map((b: any) => `<div class="bet-row ${b.status}">
      <span class="name">#${b.roundId}</span>
      <span class="amt">${money(b.amount)}</span>
      <span class="mult">${b.cashoutAt != null ? b.cashoutAt.toFixed(2) + 'x' : b.crashPoint.toFixed(2) + 'x'}</span>
      <span class="pay">${b.status === 'won' ? '+' + money(b.payout) : b.status === 'lost' ? '-' + money(b.amount) : 'open'}</span>
    </div>`).join('') || '<p class="empty">No bets yet</p>';
}

let tab = 'round';
app.querySelectorAll<HTMLButtonElement>('.tab').forEach((b) => b.addEventListener('click', () => {
  tab = b.dataset.tab!;
  app.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === b));
  $('.round-list').hidden = tab !== 'round';
  $('.round-summary').hidden = tab !== 'round';
  $('.mine-list').hidden = tab !== 'mine';
  if (tab === 'mine') renderMine();
}));
game.on('round', () => { if (tab === 'mine' && game.round.phase === 'crashed') setTimeout(renderMine, 300); });
game.on('user', () => { if (tab === 'mine') renderMine(); });

// ---------- loop ----------
function frame() {
  panels.forEach((p) => p.render());
  if (listDirty && tab === 'round') { listDirty = false; renderRoundList(); }
  requestAnimationFrame(frame);
}

(async () => {
  // Wait briefly for web fonts so Pixi text renders with the right face.
  await Promise.race([document.fonts?.ready, new Promise((r) => setTimeout(r, 1500))]);
  const scene = new GameScene(game);
  await scene.init($('.canvas-host'));
  game.connect();
  renderUser();
  frame();
})();
