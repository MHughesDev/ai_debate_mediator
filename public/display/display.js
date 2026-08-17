// Display state machine: single-focus rotating states driven by WS events.
// Scheduling rules (priority, holds, queueing) live in shared/viewQueue.js.
import { connectSession, sessionIdFromUrl } from '../shared/ws-client.js';
import { createViewQueue } from '../shared/viewQueue.js';

const $ = (id) => document.getElementById(id);
const views = ['idle', 'factcheck', 'scoreboard', 'flag', 'receipts'];

const state = {
  clockTimer: null,
  clock: null, // {label, remaining_s, total_s, overtime, receivedAt}
};

function show(view) {
  for (const v of views) $(`view-${v}`).classList.toggle('active', v === view);
}

const viewQueue = createViewQueue({ onShow: show });
const requestView = (view, holdMs, render) => viewQueue.request(view, holdMs, render);

function fmtClock(s) {
  const m = Math.floor(Math.abs(s) / 60);
  const sec = Math.abs(s) % 60;
  return `${s < 0 ? '-' : ''}${m}:${String(sec).padStart(2, '0')}`;
}

function renderClock() {
  if (!state.clock) return;
  const elapsed = Math.floor((Date.now() - state.clock.receivedAt) / 1000);
  const remaining = state.clock.remaining_s - elapsed;
  const el = $('idle-clock');
  el.textContent = `${state.clock.label} · ${fmtClock(remaining)}`;
  el.classList.toggle('overtime', remaining < 0 || state.clock.overtime);
}

function onSpeaker(e) {
  $('idle-speaker').textContent = e.name || 'Listening…';
  $('idle-team').textContent = e.team || '';
}

function onTurnclock(e) {
  state.clock = { ...e, receivedAt: Date.now() };
  clearInterval(state.clockTimer);
  state.clockTimer = setInterval(renderClock, 1000);
  renderClock();
}

function onFactcheck(e) {
  requestView('factcheck', e.hold_ms || 15000, () => {
    $('fc-claim').textContent = e.claim;
    $('fc-speaker').textContent = e.speaker ? `— ${e.speaker}` : '';
    const v = $('fc-verdict');
    v.textContent = e.verdict === 'UNVERIFIED' ? '⏳ UNVERIFIED' : e.verdict;
    v.className = `fc-verdict ${e.verdict}`;
    $('fc-evidence').textContent = e.evidence || '';
    const src = e.sources && e.sources[0];
    $('fc-source').textContent = src ? `Source: ${src.name}` : '';
  });
}

function onScoreboard(e) {
  if (e.visibility === 'off' || e.visibility === 'end') return; // never show live when hidden
  requestView('scoreboard', e.hold_ms || 6000, () => {
    const rows = $('sb-rows');
    rows.innerHTML = '';
    for (const s of e.scores || []) {
      const row = document.createElement('div');
      row.className = 'sb-row';
      row.innerHTML = `
        <div><div class="sb-name"></div><div class="sb-team"></div></div>
        <div class="sb-total"></div>
        <div class="sb-bar"><div></div></div>`;
      row.querySelector('.sb-name').textContent = s.speaker;
      row.querySelector('.sb-team').textContent = s.team || '';
      row.querySelector('.sb-total').textContent = Math.round(s.total);
      row.querySelector('.sb-bar > div').style.width = `${Math.max(2, Math.min(100, s.total))}%`;
      rows.appendChild(row);
    }
  });
}

function onFlag(e) {
  requestView('flag', e.hold_ms || 7000, () => {
    $('flag-kind').textContent = e.kind === 'dodge' ? '⚑ UNANSWERED QUESTION' : '⚑ FALLACY FLAG';
    $('flag-label').textContent = e.label || '';
    $('flag-speaker').textContent = e.speaker ? `— ${e.speaker}` : '';
    $('flag-detail').textContent = e.detail || '';
  });
}

function onReceipts(e) {
  viewQueue.takeover('receipts', () => renderReceipts(e)); // terminal state
}

function renderReceipts(e) {
  const body = $('receipts-body');
  body.innerHTML = '';
  const lines = [];
  const winner = e.winner ? `🏆 <strong>${e.winner}</strong> takes the debate` : null;
  if (winner) lines.push(winner);
  if (e.most_accurate) lines.push(`🎯 Most accurate: <strong>${e.most_accurate}</strong>`);
  if (e.least_accurate) lines.push(`⚠️ Least accurate: <strong>${e.least_accurate}</strong>`);
  if (e.biggest_unsupported_claim) lines.push(`❓ Biggest unsupported claim: “${e.biggest_unsupported_claim}”`);
  if (typeof e.unanswered_questions === 'number') lines.push(`🙊 Unanswered questions: ${e.unanswered_questions}`);
  for (const html of lines) {
    const div = document.createElement('div');
    div.className = 'line';
    div.innerHTML = html;
    body.appendChild(div);
  }
}

function onPending(e) {
  const el = $('pending');
  if (e.count > 0) {
    $('pending-count').textContent = e.count;
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

function onThought(e) {
  // "AI thoughts visible" transparency line (SPEC §3.7 tone decision)
  const el = $('thoughts');
  el.textContent = e.text || '';
  el.classList.toggle('hidden', !e.text);
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 6000);
}

function onAlert(e) {
  const el = $('alert');
  el.textContent = e.text || '';
  el.classList.toggle('hidden', !e.text);
  clearTimeout(el._t);
  if (e.text) el._t = setTimeout(() => el.classList.add('hidden'), (e.hold_ms || 8000));
}

function applySnapshot(snap) {
  const s = snap.state || {};
  if (s.speaker) onSpeaker(s.speaker);
  if (s.turnclock) onTurnclock(s.turnclock);
  if (s.pending) onPending(s.pending);
  if (s.scoreboard && s.scoreboard.visibility === 'live') onScoreboard({ ...s.scoreboard, hold_ms: 4000 });
  if (s.receipts) onReceipts(s.receipts);
}

const handlers = {
  speaker: onSpeaker,
  turnclock: onTurnclock,
  factcheck: onFactcheck,
  scoreboard: onScoreboard,
  flag: onFlag,
  receipts: onReceipts,
  'verification.pending': onPending,
  thought: onThought,
  alert: onAlert,
  snapshot: applySnapshot,
};

const sessionId = sessionIdFromUrl();
if (!sessionId) {
  $('idle-speaker').textContent = 'No session — open /display/?session=<id>';
} else {
  connectSession({
    sessionId,
    role: 'display',
    onEvent(event) {
      const handler = handlers[event.type];
      if (handler) handler(event);
    },
    onStatus(s) {
      $('conn').classList.toggle('hidden', s === 'connected');
    },
  });
}
