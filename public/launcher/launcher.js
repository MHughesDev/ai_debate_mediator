// Launcher: config -> wake backend -> create session -> send bot.
// Works served by the backend (same-origin) OR as a static deploy: set
// window.API_BASE before this script to point at the backend.
const API = (window.API_BASE || '').replace(/\/$/, '');
const $ = (id) => document.getElementById(id);

let presets = [];

function speakerRow(name = '', team = '') {
  const row = document.createElement('div');
  row.className = 'speaker-row';
  row.innerHTML = `
    <input class="sp-name" placeholder="Display name" />
    <input class="sp-team" placeholder="Team (optional)" />
    <button type="button" title="Remove">✕</button>`;
  row.querySelector('.sp-name').value = name;
  row.querySelector('.sp-team').value = team;
  row.querySelector('button').onclick = () => row.remove();
  return row;
}

async function init() {
  $('speakers').appendChild(speakerRow('', 'Proposition'));
  $('speakers').appendChild(speakerRow('', 'Opposition'));
  $('add-speaker').onclick = () => $('speakers').appendChild(speakerRow());

  try {
    // This fetch doubles as the cold-start wake ping (SPEC §6.2).
    const res = await fetch(`${API}/api/presets`);
    presets = (await res.json()).presets;
  } catch {
    $('status').textContent = 'Waking backend…';
    presets = [];
  }
  const select = $('preset');
  for (const p of presets) {
    const opt = document.createElement('option');
    opt.value = p.format_id;
    opt.textContent = p.label;
    select.appendChild(opt);
  }
  if (presets.length === 0) {
    const opt = document.createElement('option');
    opt.value = 'oxford';
    opt.textContent = 'Oxford';
    select.appendChild(opt);
  }
  select.value = presets.some((p) => p.format_id === 'oxford') ? 'oxford' : select.options[0]?.value;
  const updateDesc = () => {
    const p = presets.find((x) => x.format_id === select.value);
    $('preset-desc').textContent = p ? p.description : '';
  };
  select.onchange = updateDesc;
  updateDesc();
}

function collectOverrides() {
  const overrides = {};
  const vis = $('dial-visibility').value;
  if (vis) overrides.scoring_visibility = vis;
  const fc = $('dial-factcheck').value;
  const bar = $('dial-falsebar').value;
  if (fc || bar) overrides.factcheck = {};
  if (fc) overrides.factcheck.mode = fc;
  if (bar) overrides.factcheck.false_verdict_min_confidence = parseFloat(bar);
  const fallacy = $('dial-fallacy').value;
  const dodge = $('dial-dodge').value;
  if (fallacy || dodge) overrides.mediator = {};
  if (fallacy) overrides.mediator.fallacy_flags = fallacy === 'true';
  if (dodge) overrides.mediator.dodge_detection = dodge === 'true';
  return overrides;
}

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('send');
  const status = $('status');
  btn.disabled = true;
  status.className = 'status';
  try {
    status.textContent = 'Waking backend…';
    await fetch(`${API}/healthz`); // cold-start wake BEFORE send (SPEC §6.2)

    status.textContent = 'Creating session…';
    const speakers = [...document.querySelectorAll('.speaker-row')]
      .map((row) => ({
        name: row.querySelector('.sp-name').value.trim(),
        team: row.querySelector('.sp-team').value.trim() || null,
      }))
      .filter((s) => s.name);

    const createRes = await fetch(`${API}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        meetingUrl: $('meetingUrl').value.trim(),
        config: { preset: $('preset').value, overrides: collectOverrides() },
        speakers,
        motion: $('motion').value.trim(),
      }),
    });
    if (!createRes.ok) throw new Error((await createRes.json()).error || `HTTP ${createRes.status}`);
    const session = await createRes.json();

    status.textContent = 'Sending bot…';
    const startRes = await fetch(`${API}/api/sessions/${session.id}/start`, { method: 'POST' });
    if (!startRes.ok) throw new Error((await startRes.json()).error || `HTTP ${startRes.status}`);

    status.textContent = `Bot dispatched to the call (session ${session.id})`;
    status.className = 'status ok';
    const base = API || '';
    $('link-dashboard').href = `${base}/dashboard/?session=${session.id}`;
    $('link-display').href = `${base}/display/?session=${session.id}`;
    $('link-stage').href = `${base}/stage/?session=${session.id}`;
    $('result').classList.remove('hidden');
  } catch (err) {
    status.textContent = `Failed: ${err.message}`;
    status.className = 'status error';
  } finally {
    btn.disabled = false;
  }
});

init();
