// Provably-fair modal. Verification runs entirely in the browser with Web Crypto,
// so players don't have to trust the server's own /verify endpoint.

const enc = new TextEncoder();
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(s: string) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

export async function crashPoint(hash: string, salt: string, houseEdge: number) {
  const key = await crypto.subtle.importKey('raw', enc.encode(hash), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const h = hex(await crypto.subtle.sign('HMAC', key, enc.encode(salt)));
  const x = parseInt(h.slice(0, 13), 16) / 2 ** 52;
  return Math.min(10000, Math.max(1, Math.floor(((1 - houseEdge) / (1 - x)) * 100) / 100));
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export async function openFairness(modal: (title: string, body: HTMLElement) => void) {
  const body = document.createElement('div');
  body.className = 'fair';
  body.innerHTML = '<p class="muted">Loading…</p>';
  modal('Provably fair', body);

  const [fair, recent] = await Promise.all([
    fetch('/api/fair').then((r) => r.json()),
    fetch('/api/rounds/recent').then((r) => r.json()),
  ]);
  const rounds: any[] = recent.rounds;

  body.innerHTML = `
    <p>Every crash point comes from a SHA-256 hash chain that was <b>committed before the first round</b>.
       Each revealed game hash must hash into the previous game's hash, so results can't be changed afterwards.</p>
    <dl>
      <dt>Terminal hash (commitment)</dt><dd class="mono">${esc(fair.terminalHash)}</dd>
      <dt>Salt</dt><dd class="mono">${esc(fair.salt)}</dd>
      <dt>Chain progress</dt><dd>${fair.used} / ${fair.length} games</dd>
      <dt>Formula</dt><dd class="mono small">${esc(fair.formula)}</dd>
    </dl>
    <h4>Verify a round</h4>
    <form class="verify">
      <input name="hash" placeholder="Game hash (64 hex chars)" class="mono" required pattern="[0-9a-f]{64}" />
      <div class="row">
        <input name="salt" placeholder="Salt" class="mono" value="${esc(fair.salt)}" />
        <input name="edge" type="number" step="0.001" min="0" max="0.5" value="${fair.houseEdge ?? 0.03}" title="House edge used by that round" />
        <button>Verify</button>
      </div>
      <output class="mono"></output>
    </form>
    <h4>Recent rounds</h4>
    <div class="table-wrap"><table>
      <thead><tr><th>#</th><th>Crash</th><th>Hash</th><th>Chain link</th><th></th></tr></thead>
      <tbody>${rounds.map((r) => `
        <tr data-id="${r.id}"><td>${r.id}</td><td class="cp">${r.crashPoint.toFixed(2)}x</td>
        <td class="mono small">${r.hash.slice(0, 16)}…</td><td class="link small muted">–</td>
        <td><button class="mini" data-hash="${r.hash}" data-salt="${r.salt}" data-edge="${r.houseEdge}">Use</button></td></tr>`).join('')}
      </tbody></table></div>`;

  const form = body.querySelector<HTMLFormElement>('form.verify')!;
  const out = form.querySelector('output')!;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const hash = String(fd.get('hash')).trim();
    const cp = await crashPoint(hash, String(fd.get('salt')), Number(fd.get('edge')));
    out.textContent = `crash point = ${cp.toFixed(2)}x · sha256(hash) = ${(await sha256Hex(hash)).slice(0, 24)}…`;
  });
  body.querySelectorAll<HTMLButtonElement>('button.mini').forEach((b) => b.addEventListener('click', () => {
    (form.elements.namedItem('hash') as HTMLInputElement).value = b.dataset.hash!;
    (form.elements.namedItem('salt') as HTMLInputElement).value = b.dataset.salt!;
    (form.elements.namedItem('edge') as HTMLInputElement).value = b.dataset.edge!;
    form.requestSubmit();
  }));

  // Check every consecutive pair in the list links correctly and recompute each crash point locally.
  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];
    const row = body.querySelector<HTMLElement>(`tr[data-id="${r.id}"]`)!;
    const cell = row.querySelector('.link')!;
    const cpOk = (await crashPoint(r.hash, r.salt, r.houseEdge)) === r.crashPoint;
    const older = rounds[i + 1];
    let linkOk: boolean | null = null;
    if (older && older.id === r.id - 1 && older.salt === r.salt) linkOk = (await sha256Hex(r.hash)) === older.hash;
    cell.textContent = `${cpOk ? '✓ result' : '✗ result'}${linkOk == null ? '' : linkOk ? ' · ✓ chain' : ' · ✗ chain'}`;
    cell.classList.toggle('ok', cpOk && linkOk !== false);
    cell.classList.toggle('bad', !cpOk || linkOk === false);
  }
}
