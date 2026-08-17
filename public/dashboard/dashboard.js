import { connectSession, sessionIdFromUrl } from '../shared/ws-client.js';

const $ = (id) => document.getElementById(id);
const sessionId = sessionIdFromUrl();

function addTranscript({ speaker, team, text }) {
  const div = document.createElement('div');
  div.className = 'utt';
  div.innerHTML = `<div class="who"></div><div class="text"></div>`;
  div.querySelector('.who').textContent = speaker + (team ? ' ' : '');
  if (team) {
    const t = document.createElement('span');
    t.className = 'team';
    t.textContent = `(${team})`;
    div.querySelector('.who').appendChild(t);
  }
  div.querySelector('.text').textContent = text;
  const wrap = $('transcript');
  wrap.appendChild(div);
  while (wrap.children.length > 200) wrap.removeChild(wrap.firstChild);
  wrap.parentElement.scrollTop = wrap.parentElement.scrollHeight;
}

function addFactcheck(e) {
  const div = document.createElement('div');
  div.className = 'card';
  const src = e.sources && e.sources[0];
  div.innerHTML = `<div class="v"></div><div class="claim"></div><div class="ev muted"></div><div class="src"></div>`;
  div.querySelector('.v').textContent = e.verdict === 'UNVERIFIED' ? '⏳ UNVERIFIED' : e.verdict;
  div.querySelector('.v').classList.add(e.verdict);
  div.querySelector('.claim').textContent = `“${e.claim}” — ${e.speaker || ''}`;
  div.querySelector('.ev').textContent = e.evidence || '';
  if (src) div.querySelector('.src').innerHTML = `<a href="${src.url}" target="_blank" rel="noopener"></a>`;
  if (src) div.querySelector('a').textContent = src.name;
  $('factchecks').prepend(div);
  while ($('factchecks').children.length > 20) $('factchecks').removeChild($('factchecks').lastChild);
}

function renderSpeakers(list) {
  $('speakers').innerHTML = '';
  for (const s of list) {
    const div = document.createElement('div');
    div.className = 'card';
    div.textContent = `${s.name}${s.team ? ` — ${s.team}` : ''}${s.isHost ? ' (host)' : ''}`;
    $('speakers').appendChild(div);
  }
}

const speakers = new Map();

function renderScores(e) {
  $('scores').innerHTML = '';
  for (const s of e.scores || []) {
    const div = document.createElement('div');
    div.className = 'card';
    const subs = s.subs
      ? ` · A${Math.round(s.subs.accuracy)} E${Math.round(s.subs.evidence)} L${Math.round(s.subs.logic)} R${Math.round(s.subs.responsiveness)}`
      : '';
    div.innerHTML = `<div class="score-row"><span></span><strong></strong></div><div class="muted"></div>`;
    div.querySelector('span').textContent = s.speaker;
    div.querySelector('strong').textContent = Math.round(s.total);
    div.querySelector('.muted').textContent = subs;
    $('scores').appendChild(div);
  }
}

function addFlag(e) {
  const div = document.createElement('div');
  div.className = 'card';
  div.innerHTML = `<div class="v MISLEADING"></div><div class="muted"></div>`;
  div.querySelector('.v').textContent = `⚑ ${e.label || e.kind}`;
  div.querySelector('.muted').textContent = `${e.speaker || ''} — ${e.detail || ''}`;
  $('flags').prepend(div);
}

const handlers = {
  transcript: addTranscript,
  'transcript.interim': (e) => {
    $('interim').textContent = e.text ? `${e.speaker}: ${e.text}` : '';
  },
  factcheck: addFactcheck,
  scoreboard: renderScores,
  flag: addFlag,
  'speaker.joined': (e) => {
    speakers.set(e.speaker.participantId, e.speaker);
    renderSpeakers([...speakers.values()]);
  },
  'session.status': (e) => {
    $('status').textContent = e.status;
    $('status').className = `pill ${e.status === 'live' ? 'ok' : ''}`;
  },
  'meeting.status': (e) => {
    $('status').textContent = e.status;
  },
  snapshot: (snap) => {
    $('session-line').textContent = `session ${snap.session.id} · ${snap.session.meetingUrl}`;
    $('status').textContent = snap.session.status;
    if (snap.state?.scoreboard) renderScores(snap.state.scoreboard);
    // hydrate transcript tail + speakers over REST (bulk data isn't in events)
    fetch(`/api/sessions/${sessionId}/transcript?count=100`)
      .then((r) => r.json())
      .then(({ entries }) => {
        $('transcript').innerHTML = '';
        for (const u of entries) addTranscript({ speaker: u.speakerName, team: u.team, text: u.text });
      });
    fetch(`/api/sessions/${sessionId}/speakers`)
      .then((r) => r.json())
      .then(({ speakers: list }) => {
        for (const s of list) speakers.set(s.participantId, s);
        renderSpeakers([...speakers.values()]);
      });
  },
};

if (!sessionId) {
  $('session-line').textContent = 'No session — open /dashboard/?session=<id>';
} else {
  connectSession({
    sessionId,
    role: 'dashboard',
    onEvent(event) {
      const h = handlers[event.type];
      if (h) h(event);
    },
    onStatus(s) {
      $('conn').textContent = s;
      $('conn').className = `pill ${s === 'connected' ? 'ok' : 'warn'}`;
    },
  });

  const post = (path, body) =>
    fetch(`/api/sessions/${sessionId}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  $('btn-start').onclick = () => post('/start');
  $('btn-end').onclick = () => confirm('End this session?') && post('/end');
  $('btn-pause').onclick = () => post('/command', { name: 'pause', args: ['scoring'] });
  $('btn-resume').onclick = () => post('/command', { name: 'resume', args: [] });
}
