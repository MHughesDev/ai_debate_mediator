// Load test (SPEC Phase 5): N concurrent mock-debate sessions against a
// running server, each with WS display+dashboard clients. Asserts every
// session completes with receipts and reports event latency percentiles.
//
//   node scripts/loadtest.js [baseUrl] [sessions]
import WebSocket from 'ws';

const base = process.argv[2] || 'http://localhost:8080';
const wsBase = base.replace(/^http/, 'ws');
const N = parseInt(process.argv[3] || '3', 10);

async function runSession(i) {
  const createRes = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      meetingUrl: `https://zoom.us/j/load-${i}`,
      config: { preset: 'oxford' },
      speakers: [
        { name: 'Alex Rivera', team: 'Proposition' },
        { name: 'Jordan Blake', team: 'Opposition' },
      ],
    }),
  });
  const session = await createRes.json();

  const latencies = [];
  const events = [];
  const clients = ['display', 'dashboard'].map((role) => {
    const ws = new WebSocket(`${wsBase}/ws?session=${session.id}&role=${role}`);
    ws.on('message', (d) => {
      const e = JSON.parse(d.toString());
      if (e.ts) latencies.push(Date.now() - e.ts);
      if (role === 'display') events.push(e);
    });
    return ws;
  });
  await Promise.all(
    clients.map((ws) => new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); })),
  );

  await fetch(`${base}/api/sessions/${session.id}/start`, { method: 'POST' });

  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    if (events.some((e) => e.type === 'receipts')) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  for (const ws of clients) ws.close();

  const done = events.some((e) => e.type === 'receipts');
  return {
    id: session.id,
    done,
    events: events.length,
    factchecks: events.filter((e) => e.type === 'factcheck').length,
    latencies,
  };
}

function pct(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

async function main() {
  const health = await fetch(`${base}/healthz`).catch(() => null);
  if (!health?.ok) {
    console.error(`server not reachable at ${base}`);
    process.exit(1);
  }
  console.log(`load test: ${N} concurrent mock debates against ${base}`);
  const started = Date.now();
  const results = await Promise.all(Array.from({ length: N }, (_, i) => runSession(i)));
  const wallMs = Date.now() - started;

  const allLatencies = results.flatMap((r) => r.latencies).sort((a, b) => a - b);
  let failed = 0;
  for (const r of results) {
    console.log(
      `  session ${r.id}: ${r.done ? '✔ completed' : '✖ INCOMPLETE'} — ${r.events} events, ${r.factchecks} fact-checks`,
    );
    if (!r.done) failed += 1;
  }
  console.log(
    `event delivery latency: p50=${pct(allLatencies, 50)}ms p95=${pct(allLatencies, 95)}ms p99=${pct(allLatencies, 99)}ms (n=${allLatencies.length})`,
  );
  console.log(`wall time: ${Math.round(wallMs / 1000)}s`);
  if (failed > 0) {
    console.error(`✖ ${failed}/${N} sessions failed to complete`);
    process.exit(1);
  }
  const p95 = pct(allLatencies, 95);
  if (p95 > 500) {
    console.error(`✖ p95 event latency ${p95}ms exceeds the 500ms display budget`);
    process.exit(1);
  }
  console.log(`✅ ${N}/${N} sessions completed within latency budget`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
