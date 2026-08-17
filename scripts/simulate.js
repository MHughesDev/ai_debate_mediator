// Full E2E simulation against a RUNNING server (default http://localhost:8080).
// Creates an Oxford session, runs the scripted debate through the real
// pipeline, and asserts every stage: transcript -> claims -> verdicts ->
// scores -> receipts. Exit code 0 = the whole system works.
//
//   node scripts/simulate.js [baseUrl]
//   MOCK_SPEED_FACTOR=10 npm start   (in another terminal, for a faster run)
import WebSocket from 'ws';

const base = process.argv[2] || 'http://localhost:8080';
const wsBase = base.replace(/^http/, 'ws');

function fail(msg) {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

function ok(msg) {
  console.log(`✔ ${msg}`);
}

async function main() {
  const health = await fetch(`${base}/healthz`).catch(() => null);
  if (!health?.ok) fail(`server not reachable at ${base} — start it with: npm start`);
  ok('server reachable');

  const createRes = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      meetingUrl: 'https://zoom.us/j/simulation',
      config: { preset: 'oxford' },
      motion: 'This house believes governments should ban new gasoline car sales by 2035',
      speakers: [
        { name: 'Alex Rivera', team: 'Proposition' },
        { name: 'Jordan Blake', team: 'Opposition' },
      ],
    }),
  });
  if (!createRes.ok) fail(`create session: HTTP ${createRes.status}`);
  const session = await createRes.json();
  ok(`session created: ${session.id} (preset ${session.config.preset})`);

  const events = [];
  const ws = new WebSocket(`${wsBase}/ws?session=${session.id}&role=simulator`);
  ws.on('message', (d) => events.push(JSON.parse(d.toString())));
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  const startRes = await fetch(`${base}/api/sessions/${session.id}/start`, { method: 'POST' });
  if (!startRes.ok) fail(`start pipeline: HTTP ${startRes.status}`);
  ok('bot dispatched (mock meeting provider)');

  const count = (type, pred = () => true) => events.filter((e) => e.type === type && pred(e)).length;
  const deadline = Date.now() + 180000;
  process.stdout.write('  running debate');
  while (Date.now() < deadline) {
    if (count('receipts') > 0) break;
    await new Promise((r) => setTimeout(r, 1000));
    process.stdout.write('.');
  }
  console.log('');
  if (count('receipts') === 0) fail('debate did not produce receipts within 3 minutes');

  // Assertions over the event stream
  if (count('transcript') < 16) fail(`expected >=16 transcript finals, got ${count('transcript')}`);
  ok(`transcript: ${count('transcript')} labeled utterances`);

  if (count('claim') < 5) fail(`expected >=5 claims, got ${count('claim')}`);
  ok(`claims extracted: ${count('claim')}`);

  const falseCards = events.filter((e) => e.type === 'factcheck' && e.verdict === 'FALSE');
  if (falseCards.length === 0) fail('no FALSE verdict for the scripted false claims');
  if (falseCards.some((c) => !c.sources?.length)) fail('a FALSE card was shown without sources');
  ok(`fact-checks: ${count('factcheck')} cards (${falseCards.length} FALSE, all sourced)`);

  if (count('scoreboard') === 0) fail('no live scoreboard events');
  ok(`scoreboards published: ${count('scoreboard')}`);

  if (count('turnclock') === 0) fail('no turn clock events');
  ok('turn clock ran');

  if (count('flag', (e) => e.kind === 'fallacy') === 0) fail('scripted ad hominem was not flagged');
  ok('fallacy flagged');

  const receipts = events.find((e) => e.type === 'receipts');
  if (!receipts.final_scores?.length) fail('receipts missing final scores');
  ok(`receipts: "${receipts.headline}"`);

  const costs = await (await fetch(`${base}/api/sessions/${session.id}/costs`)).json();
  ok(`cost estimate: $${costs.estimate_usd} (${JSON.stringify(costs.counters)})`);

  ws.close();
  console.log('\n✅ full pipeline simulation passed');
  process.exit(0);
}

main().catch((err) => fail(err.message));
