// Nova Rush admin console - vanilla JS, talks to /api/admin/*.
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const money = (c) => (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const signed = (c) => `<span class="${c >= 0 ? 'pos' : 'neg'}">${c >= 0 ? '+' : ''}${money(c)}</span>`;
  const time = (ts) => (ts ? new Date(ts).toLocaleString() : '–');
  const pct = (x) => (x == null ? '–' : `${(x * 100).toFixed(2)}%`);

  let token = null;
  try { token = sessionStorage.getItem('nova.admin'); } catch { /* storage unavailable */ }

  async function api(path, opts = {}) {
    const res = await fetch(`/api/admin${path}`, {
      ...opts,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(opts.headers || {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { showLogin(); throw new Error('Session expired'); }
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  let toastTimer;
  function toast(msg, kind = '') {
    const t = $('#toast');
    t.textContent = msg;
    t.className = `toast ${kind}`;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
  }

  function dialog(title, html, onReady) {
    $('#dlg-title').textContent = title;
    $('#dlg-body').innerHTML = html;
    $('#dlg').showModal();
    onReady?.($('#dlg-body'));
  }

  // ---------------- auth ----------------
  function showLogin() {
    token = null;
    try { sessionStorage.removeItem('nova.admin'); } catch { /* ignore */ }
    $('#shell').hidden = true;
    $('#login').hidden = false;
    $('#login input').focus();
  }

  $('#login form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = new FormData(e.target).get('password');
    const res = await fetch('/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
    const data = await res.json();
    if (!res.ok) { $('#login .err').textContent = data.error || 'Login failed'; return; }
    token = data.token;
    try { sessionStorage.setItem('nova.admin', token); } catch { /* ignore */ }
    e.target.reset();
    $('#login .err').textContent = '';
    boot();
  });
  $('#logout').addEventListener('click', showLogin);

  // ---------------- routing ----------------
  const loaders = { dashboard: loadDashboard, users: loadUsers, rounds: loadRounds, settings: loadSettings, fairness: loadChain, audit: loadAudit };
  let current = 'dashboard';
  let pollTimer;

  function route() {
    current = (location.hash.slice(1) || 'dashboard');
    if (!loaders[current]) current = 'dashboard';
    $$('.view').forEach((v) => { v.hidden = v.dataset.view !== current; });
    $$('.nav a[data-view]').forEach((a) => a.classList.toggle('active', a.dataset.view === current));
    clearInterval(pollTimer);
    loaders[current]().catch((e) => toast(e.message, 'error'));
    if (current === 'dashboard') pollTimer = setInterval(() => loadDashboard().catch(() => {}), 1000);
  }
  window.addEventListener('hashchange', route);

  function boot() {
    $('#login').hidden = true;
    $('#shell').hidden = false;
    route();
  }

  // ---------------- dashboard ----------------
  let paused = false;
  let lastSeriesKey = '';

  async function loadDashboard() {
    const s = await api('/stats');
    const live = s.live;
    paused = s.paused;
    $('#pause-btn').textContent = paused ? 'Resume game' : 'Pause game';
    $('#pause-btn').className = `btn ${paused ? 'warn' : ''}`;

    $('#live-phase').textContent = live.phase;
    $('#live-phase').className = `phase-${live.phase}`;
    $('#live-round').textContent = live.roundId ? `#${live.roundId}` : '–';
    $('#live-mult').textContent = live.phase === 'running' ? `${live.multiplier.toFixed(2)}x` : live.phase === 'crashed' ? `${live.crashPoint.toFixed(2)}x` : '–';
    $('#live-crash').textContent = live.crashPoint ? `${live.crashPoint.toFixed(2)}x` : '–';
    $('#live-bets').textContent = `${live.realBets ?? 0} (+${live.botBets ?? 0} bots)`;
    $('#live-money').textContent = `${money(live.wagered || 0)} / ${money(live.paidOut || 0)}`;

    const t = s.totals;
    const kpis = [
      ['Players online', s.online, `${s.users.total} registered · ${s.users.banned || 0} banned`],
      ['Rounds played', t.rounds.toLocaleString(), `${s.last24h.rounds} in last 24h`],
      ['Total wagered', money(t.wagered), `${t.bets.toLocaleString()} bets`],
      ['Total paid out', money(t.paid), ''],
      ['House profit', signed(t.profit), `24h: ${money(s.last24h.profit)}`],
      ['Actual RTP', pct(t.rtp), `Target ${pct(s.theoreticalRtp)}`],
      ['Player balances', money(s.users.balances), 'Outstanding liability'],
      ['24h wagered', money(s.last24h.wagered), `Paid ${money(s.last24h.paid)}`],
    ];
    $('#kpis').innerHTML = kpis.map(([l, v, h]) => `<div class="kpi"><div class="lbl">${l}</div><div class="val">${v}</div><div class="hint">${h}</div></div>`).join('');

    const key = s.series.length ? `${s.series[s.series.length - 1].id}` : '';
    if (key !== lastSeriesKey) {
      lastSeriesKey = key;
      drawProfit(s.series);
      drawCrash(s.series);
    }
  }

  function drawProfit(series) {
    const svg = $('#chart-profit');
    const W = 600, H = 200;
    if (!series.length) { svg.innerHTML = `<text x="300" y="100" fill="#8a93c7" text-anchor="middle">No rounds yet</text>`; return; }
    const vals = series.map((r) => r.wagered - r.paid);
    const max = Math.max(1, ...vals.map(Math.abs));
    const bw = W / series.length;
    const mid = H / 2;
    let cum = 0;
    const cumPts = [];
    const cumVals = vals.map((v) => (cum += v));
    const cmax = Math.max(1, ...cumVals.map(Math.abs));
    const bars = vals.map((v, i) => {
      const h = (Math.abs(v) / max) * (H / 2 - 6);
      cumPts.push(`${(i + 0.5) * bw},${mid - (cumVals[i] / cmax) * (H / 2 - 6)}`);
      return `<rect x="${i * bw + 0.5}" y="${v >= 0 ? mid - h : mid}" width="${Math.max(1, bw - 1)}" height="${Math.max(0.5, h)}" fill="${v >= 0 ? '#3df5d0' : '#ff4d6d'}" opacity="0.75"><title>#${series[i].id}: ${money(v)}</title></rect>`;
    }).join('');
    svg.innerHTML = `<line x1="0" x2="${W}" y1="${mid}" y2="${mid}" stroke="#262b5a" />${bars}
      <polyline points="${cumPts.join(' ')}" fill="none" stroke="#ffc857" stroke-width="2" vector-effect="non-scaling-stroke"><title>Cumulative profit</title></polyline>`;
  }

  function drawCrash(series) {
    const svg = $('#chart-crash');
    const W = 600, H = 200;
    if (!series.length) { svg.innerHTML = ''; return; }
    const maxLog = Math.max(Math.log10(10), ...series.map((r) => Math.log10(r.crashPoint)));
    const y = (m) => H - 6 - (Math.log10(m) / maxLog) * (H - 12);
    const bw = W / series.length;
    const guides = [2, 10, 100].filter((m) => Math.log10(m) <= maxLog)
      .map((m) => `<line x1="0" x2="${W}" y1="${y(m)}" y2="${y(m)}" stroke="#262b5a" stroke-dasharray="4 4" /><text x="4" y="${y(m) - 3}" fill="#8a93c7" font-size="10">${m}x</text>`).join('');
    const bars = series.map((r, i) => {
      const c = r.crashPoint >= 10 ? '#ff8ad8' : r.crashPoint >= 2 ? '#3df5d0' : '#7b5cff';
      return `<rect x="${i * bw + 0.5}" y="${y(r.crashPoint)}" width="${Math.max(1, bw - 1)}" height="${H - 6 - y(r.crashPoint) + 1}" fill="${c}" opacity="0.8"><title>#${r.id}: ${r.crashPoint.toFixed(2)}x</title></rect>`;
    }).join('');
    svg.innerHTML = guides + bars;
  }

  $('#pause-btn').addEventListener('click', async () => {
    try {
      await api('/settings', { method: 'PUT', body: { paused: !paused } });
      toast(paused ? 'Game will resume' : 'Game will pause after this round');
      loadDashboard();
    } catch (e) { toast(e.message, 'error'); }
  });

  // ---------------- users ----------------
  let userQ = '';
  let qTimer;
  $('#user-q').addEventListener('input', (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { userQ = e.target.value; loadUsers(); }, 250);
  });

  async function loadUsers() {
    const { users } = await api(`/users?q=${encodeURIComponent(userQ)}`);
    $('#users-body').innerHTML = users.map((u) => `
      <tr data-id="${u.id}">
        <td>${u.id}</td>
        <td><span class="dot ${u.online ? 'on' : ''}"></span>${esc(u.username)}</td>
        <td class="r">${money(u.balance)}</td>
        <td class="r">${u.bets}</td>
        <td class="r">${money(u.wagered)}</td>
        <td class="r">${signed(u.paid - u.wagered)}</td>
        <td>${u.banned ? '<span class="tag banned">banned</span>' : '<span class="tag">active</span>'}</td>
        <td class="r">
          <button class="btn sm" data-act="balance">Balance</button>
          <button class="btn sm" data-act="bets">Bets</button>
          <button class="btn sm ${u.banned ? '' : 'danger'}" data-act="ban" data-banned="${u.banned ? 1 : 0}">${u.banned ? 'Unban' : 'Ban'}</button>
        </td>
      </tr>`).join('') || '<tr><td colspan="8" class="muted">No users yet. Players appear here after their first login.</td></tr>';
  }

  $('#users-body').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const row = btn.closest('tr');
    const id = row.dataset.id;
    const name = row.children[1].textContent;
    if (btn.dataset.act === 'ban') {
      const ban = btn.dataset.banned !== '1';
      if (ban && !confirm(`Ban ${name}? They will be disconnected immediately.`)) return;
      try { await api(`/users/${id}/ban`, { method: 'POST', body: { banned: ban } }); toast(`${name} ${ban ? 'banned' : 'unbanned'}`); loadUsers(); }
      catch (err) { toast(err.message, 'error'); }
    }
    if (btn.dataset.act === 'balance') {
      dialog(`Adjust balance · ${name}`, `
        <div class="form">
          <label>Amount (credits, negative to deduct)<br><input name="delta" type="number" step="0.01" required style="width:100%" /></label>
          <label>Reason<br><input name="reason" placeholder="e.g. promo bonus" style="width:100%" /></label>
          <div><button type="button" class="btn primary" id="do-adjust">Apply</button></div>
        </div>`, (body) => {
        $('#do-adjust', body).addEventListener('click', async () => {
          const delta = Number($('[name=delta]', body).value);
          try {
            const r = await api(`/users/${id}/balance`, { method: 'POST', body: { delta, reason: $('[name=reason]', body).value } });
            $('#dlg').close();
            toast(`New balance: ${money(r.balance)}`);
            loadUsers();
          } catch (err) { toast(err.message, 'error'); }
        });
      });
    }
    if (btn.dataset.act === 'bets') {
      const { bets } = await api(`/users/${id}/bets`);
      dialog(`Bets · ${name}`, betTable(bets, true));
    }
  });

  function betTable(bets, withRound) {
    if (!bets.length) return '<p class="muted">No bets.</p>';
    return `<div class="table-wrap"><table><thead><tr>${withRound ? '<th>Round</th>' : '<th>User</th>'}<th>Slot</th><th class="r">Amount</th><th>Auto</th><th>Cashed</th>${withRound ? '<th>Crash</th>' : ''}<th class="r">Payout</th><th>Status</th></tr></thead><tbody>
      ${bets.map((b) => `<tr>
        <td>${withRound ? `#${b.roundId}` : esc(b.username)}</td><td>${b.slot + 1}</td><td class="r">${money(b.amount)}</td>
        <td>${b.autoCashout ? b.autoCashout.toFixed(2) + 'x' : '–'}</td><td>${b.cashoutAt ? b.cashoutAt.toFixed(2) + 'x' : '–'}</td>
        ${withRound ? `<td>${b.crashPoint.toFixed(2)}x</td>` : ''}
        <td class="r">${money(b.payout)}</td><td><span class="tag ${b.status}">${b.status}</span></td></tr>`).join('')}
    </tbody></table></div>`;
  }

  // ---------------- rounds ----------------
  let roundsPage = 0;
  $$('[data-page]').forEach((b) => b.addEventListener('click', () => {
    roundsPage = Math.max(0, roundsPage + Number(b.dataset.page));
    loadRounds();
  }));

  async function loadRounds() {
    const { rounds } = await api(`/rounds?page=${roundsPage}`);
    $('#rounds-page').textContent = `Page ${roundsPage + 1}`;
    $('#rounds-body').innerHTML = rounds.map((r) => `
      <tr class="click" data-id="${r.id}">
        <td>${r.id}</td><td><b>${r.crashPoint.toFixed(2)}x</b></td><td>${(r.houseEdge * 100).toFixed(1)}%</td>
        <td class="r">${r.bets}</td><td class="r">${money(r.wagered)}</td><td class="r">${money(r.paid)}</td>
        <td class="r">${signed(r.wagered - r.paid)}</td><td>${time(r.endedAt)}</td><td class="mono">${r.hash.slice(0, 18)}…</td>
      </tr>`).join('') || '<tr><td colspan="9" class="muted">No rounds on this page.</td></tr>';
  }

  $('#rounds-body').addEventListener('click', async (e) => {
    const row = e.target.closest('tr[data-id]');
    if (!row) return;
    const { round, bets } = await api(`/rounds/${row.dataset.id}`);
    dialog(`Round #${round.id}`, `
      <dl class="kv">
        <dt>Crash point</dt><dd><b>${round.crash_point.toFixed(2)}x</b></dd>
        <dt>House edge</dt><dd>${(round.house_edge * 100).toFixed(2)}%</dd>
        <dt>Game hash</dt><dd class="mono">${esc(round.hash)}</dd>
        <dt>Chain / index</dt><dd>#${round.chain_id} / ${round.chain_index}</dd>
        <dt>Started → ended</dt><dd>${time(round.started_at)} → ${time(round.ended_at)}</dd>
        <dt>Wagered / paid</dt><dd>${money(round.total_bet)} / ${money(round.total_payout)} (${signed(round.total_bet - round.total_payout)})</dd>
      </dl>${betTable(bets, false)}`);
  });

  // ---------------- settings ----------------
  // Display units differ from storage units (cents, ms, fraction).
  const FIELD = {
    houseEdge: [(v) => +(v * 100).toFixed(3), (v) => v / 100],
    minBet: [(v) => v / 100, (v) => Math.round(v * 100)],
    maxBet: [(v) => v / 100, (v) => Math.round(v * 100)],
    startBalance: [(v) => v / 100, (v) => Math.round(v * 100)],
    bettingMs: [(v) => v / 1000, (v) => Math.round(v * 1000)],
    crashedMs: [(v) => v / 1000, (v) => Math.round(v * 1000)],
    maxAutoCashout: [(v) => v, (v) => v],
    bots: [(v) => v, (v) => v],
  };

  async function loadSettings() {
    const { settings } = await api('/settings');
    const f = $('#settings-form');
    for (const [k, [toView]] of Object.entries(FIELD)) f.elements[k].value = toView(settings[k]);
    f.elements.paused.checked = settings.paused;
  }

  $('#settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = { paused: f.elements.paused.checked };
    for (const [k, [, toStore]] of Object.entries(FIELD)) body[k] = toStore(Number(f.elements[k].value));
    try { await api('/settings', { method: 'PUT', body }); toast('Settings saved'); loadSettings(); }
    catch (err) { toast(err.message, 'error'); }
  });

  // ---------------- chain ----------------
  async function loadChain() {
    const { chain } = await api('/chain');
    $('#chain-info').innerHTML = `
      <dt>Chain ID</dt><dd>#${chain.chainId}</dd>
      <dt>Terminal hash</dt><dd class="mono">${esc(chain.terminalHash)}</dd>
      <dt>Salt</dt><dd class="mono">${esc(chain.salt)}</dd>
      <dt>Usage</dt><dd>${chain.used.toLocaleString()} / ${chain.length.toLocaleString()} games (${((chain.used / chain.length) * 100).toFixed(2)}%)</dd>
      <dt>Created</dt><dd>${time(chain.createdAt)}</dd>`;
  }

  $('#rotate-btn').addEventListener('click', async () => {
    if (!confirm('Rotate to a new seed chain? The new terminal hash is published immediately.')) return;
    try { await api('/chain/rotate', { method: 'POST' }); toast('New chain active from the next round'); loadChain(); }
    catch (e) { toast(e.message, 'error'); }
  });

  // ---------------- audit ----------------
  async function loadAudit() {
    const { log } = await api('/audit');
    $('#audit-body').innerHTML = log.map((l) => `
      <tr><td>${time(l.ts)}</td><td>${esc(l.actor)}</td><td><span class="tag">${esc(l.action)}</span></td>
      <td class="mono">${esc(l.detail ? JSON.stringify(l.detail) : '')}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Nothing logged yet.</td></tr>';
  }

  // ---------------- start ----------------
  if (token) api('/stats').then(boot).catch(() => {}); else showLogin();
})();
