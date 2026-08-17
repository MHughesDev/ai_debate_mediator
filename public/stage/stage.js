// Stage mode (SPEC §3.7): scoreboard rail, argument map (the visual
// signature), fact-check feed, bottom ticker. Claims layout: one column per
// speaker, rows by time; edges show rebuts/supports colored by relation.
import { connectSession, sessionIdFromUrl } from '../shared/ws-client.js';

const $ = (id) => document.getElementById(id);
const sessionId = sessionIdFromUrl();

const claims = new Map(); // id -> claim
let clockState = null;

function verdictColor(claim) {
  if (claim.type !== 'factual') return 'var(--accent)';
  switch (claim.verdict) {
    case 'TRUE': return 'var(--true)';
    case 'FALSE': return 'var(--false)';
    case 'MISLEADING': return 'var(--misleading)';
    default: return 'var(--unverified)';
  }
}

function renderMap() {
  const svg = $('map');
  const list = [...claims.values()].sort((a, b) => a.createdAt - b.createdAt);
  const speakers = [...new Set(list.map((c) => c.speaker))];
  if (speakers.length === 0) return;

  const W = 900;
  const colW = W / speakers.length;
  const rowH = 64;
  const H = Math.max(420, list.length * rowH * 0.55 + 80);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = '';

  // column headers
  speakers.forEach((s, i) => {
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    t.setAttribute('x', colW * i + colW / 2);
    t.setAttribute('y', 20);
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('class', 'node-speaker');
    t.setAttribute('font-size', '13');
    t.textContent = s;
    svg.appendChild(t);
  });

  // node positions
  const pos = new Map();
  const perCol = {};
  for (const c of list) {
    const col = speakers.indexOf(c.speaker);
    perCol[col] = (perCol[col] || 0) + 1;
    const x = colW * col + 20;
    const y = 40 + (perCol[col] - 1) * rowH;
    pos.set(c.id, { x, y, w: colW - 40, h: 46 });
  }

  // edges first (under nodes)
  for (const c of list) {
    for (const link of c.links || []) {
      const from = pos.get(c.id);
      const to = pos.get(link.targetClaimId);
      if (!from || !to) continue;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const x1 = from.x + from.w / 2;
      const y1 = from.y + 4;
      const x2 = to.x + to.w / 2;
      const y2 = to.y + to.h - 4;
      const mx = (x1 + x2) / 2;
      path.setAttribute('d', `M ${x1} ${y1} C ${mx} ${y1 - 30}, ${mx} ${y2 + 30}, ${x2} ${y2}`);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', link.relation === 'rebuts' ? 'var(--false)' : 'var(--true)');
      path.setAttribute('stroke-width', '1.6');
      path.setAttribute('stroke-dasharray', link.relation === 'rebuts' ? '' : '4 3');
      path.setAttribute('opacity', '0.7');
      svg.appendChild(path);
    }
  }

  // nodes
  for (const c of list) {
    const p = pos.get(c.id);
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', p.x);
    rect.setAttribute('y', p.y);
    rect.setAttribute('width', p.w);
    rect.setAttribute('height', p.h);
    rect.setAttribute('rx', 8);
    rect.setAttribute('fill', 'var(--panel)');
    rect.setAttribute('stroke', verdictColor(c));
    rect.setAttribute('class', 'node');
    g.appendChild(rect);

    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', p.x + 8);
    label.setAttribute('y', p.y + 18);
    label.setAttribute('class', 'node-label');
    const maxChars = Math.floor(p.w / 6);
    label.textContent = c.text.length > maxChars ? c.text.slice(0, maxChars - 1) + '…' : c.text;
    g.appendChild(label);

    const meta = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    meta.setAttribute('x', p.x + 8);
    meta.setAttribute('y', p.y + 36);
    meta.setAttribute('class', 'node-speaker');
    meta.textContent = c.type === 'factual' ? (c.verdict || 'UNVERIFIED') : c.type;
    g.appendChild(meta);

    svg.appendChild(g);
  }
}

function renderScores(e) {
  $('scores').innerHTML = '';
  for (const s of e.scores || []) {
    const div = document.createElement('div');
    div.className = 'sb-card';
    div.innerHTML = `
      <span class="total"></span>
      <div class="name"></div>
      <div class="team"></div>
      <div class="sb-sub">
        <span>Accuracy</span><b class="a"></b>
        <span>Evidence</span><b class="e"></b>
        <span>Logic</span><b class="l"></b>
        <span>Responsiveness</span><b class="r"></b>
      </div>`;
    div.querySelector('.total').textContent = Math.round(s.total);
    div.querySelector('.name').textContent = s.speaker;
    div.querySelector('.team').textContent = s.team || '';
    div.querySelector('.a').textContent = Math.round(s.subs.accuracy);
    div.querySelector('.e').textContent = Math.round(s.subs.evidence);
    div.querySelector('.l').textContent = Math.round(s.subs.logic);
    div.querySelector('.r').textContent = Math.round(s.subs.responsiveness);
    $('scores').appendChild(div);
  }
}

function addFeed(e) {
  const div = document.createElement('div');
  div.className = 'fc';
  const src = e.sources && e.sources[0];
  div.innerHTML = `<span class="v"></span><div class="claim"></div><div class="ev"></div>`;
  div.querySelector('.v').textContent = e.verdict === 'UNVERIFIED' ? '⏳ UNVERIFIED' : e.verdict;
  div.querySelector('.v').classList.add(e.verdict);
  div.querySelector('.claim').textContent = `“${e.claim}” — ${e.speaker || ''}`;
  div.querySelector('.ev').textContent = e.evidence || '';
  if (src) {
    const a = document.createElement('a');
    a.href = src.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = src.name;
    div.appendChild(a);
  }
  $('feed').prepend(div);
  while ($('feed').children.length > 30) $('feed').removeChild($('feed').lastChild);
}

let clockTimer = null;
function onTurnclock(e) {
  clockState = { ...e, receivedAt: Date.now() };
  clearInterval(clockTimer);
  clockTimer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - clockState.receivedAt) / 1000);
    const remaining = clockState.paused ? clockState.remaining_s : clockState.remaining_s - elapsed;
    const m = Math.floor(Math.abs(remaining) / 60);
    const s = String(Math.abs(remaining) % 60).padStart(2, '0');
    $('t-clock').textContent = `${clockState.label} · ${remaining < 0 ? '-' : ''}${m}:${s}`;
  }, 1000);
}

const handlers = {
  claim: (e) => {
    claims.set(e.claim.id, e.claim);
    renderMap();
  },
  factcheck: (e) => {
    const claim = claims.get(e.claimId);
    if (claim) {
      claim.verdict = e.verdict;
      renderMap();
    }
    addFeed(e);
  },
  scoreboard: renderScores,
  turnclock: onTurnclock,
  transcript: (e) => {
    $('t-speaker').textContent = `${e.speaker}${e.team ? ` (${e.team})` : ''}`;
  },
  'verification.pending': (e) => {
    $('t-pending').textContent = e.count > 0 ? `🔍 checking ${e.count} claim${e.count > 1 ? 's' : ''}` : '';
  },
  receipts: (e) => {
    $('t-speaker').textContent = e.headline || 'Debate complete';
  },
  snapshot: (snap) => {
    $('motion').textContent = snap.session.motion ? `“${snap.session.motion}”` : '';
    if (snap.state?.scoreboard && snap.state.scoreboard.visibility === 'live') renderScores(snap.state.scoreboard);
    if (snap.state?.turnclock) onTurnclock(snap.state.turnclock);
    if (snap.state?.pending) handlers['verification.pending'](snap.state.pending);
    fetch(`/api/sessions/${sessionId}/claims`)
      .then((r) => r.json())
      .then(({ claims: list }) => {
        for (const c of list) claims.set(c.id, c);
        renderMap();
      })
      .catch(() => {});
  },
};

if (!sessionId) {
  $('t-speaker').textContent = 'No session — open /stage/?session=<id>';
} else {
  connectSession({
    sessionId,
    role: 'stage',
    onEvent(event) {
      const h = handlers[event.type];
      if (h) h(event);
    },
    onStatus(s) {
      $('t-conn').textContent = s === 'connected' ? '' : s;
    },
  });
}
