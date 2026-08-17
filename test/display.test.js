// Tests for the bot tile's single-focus scheduler. This logic previously lived
// inline in display.js where nothing could reach it — and a same-priority
// preemption bug let fact-check cards cut each other off after ~2s instead of
// holding ~15s (SPEC §3.7). These lock the behavior down.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewQueue } from '../public/shared/viewQueue.js';

// Deterministic fake clock so holds are exact, not wall-clock flaky.
function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    setTimer(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    advance(ms) {
      const target = now + ms;
      let guard = 0;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due || ++guard > 1000) break;
        const [id, timer] = due;
        timers.delete(id);
        now = timer.at;
        timer.fn();
      }
      now = target;
    },
  };
}

function setup() {
  const clock = fakeClock();
  const shown = [];
  const rendered = [];
  const q = createViewQueue({
    onShow: (v) => shown.push(v),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { clock, shown, rendered, q };
}

test('a fact-check card keeps its full hold; the next one waits its turn', () => {
  const { clock, shown, rendered, q } = setup();

  q.request('factcheck', 15000, () => rendered.push('card-A'));
  assert.deepEqual(shown, ['factcheck']);
  assert.deepEqual(rendered, ['card-A']);

  // A second fact-check arrives 2s in — it must NOT replace the visible card.
  clock.advance(2000);
  q.request('factcheck', 15000, () => rendered.push('card-B'));
  assert.deepEqual(rendered, ['card-A'], 'card B has not painted yet');
  assert.deepEqual(q.queued(), ['factcheck']);

  // ...and it takes over only when A's 15s hold expires.
  clock.advance(12999);
  assert.deepEqual(rendered, ['card-A']);
  clock.advance(1);
  assert.deepEqual(rendered, ['card-A', 'card-B'], 'card B paints its own content');
  assert.equal(q.current(), 'factcheck');
});

test('queued cards paint their own content, not the newest event', () => {
  const { clock, rendered, q } = setup();
  q.request('factcheck', 10000, () => rendered.push('A'));
  q.request('factcheck', 10000, () => rendered.push('B'));
  q.request('factcheck', 10000, () => rendered.push('C'));
  clock.advance(10000);
  assert.deepEqual(rendered, ['A', 'B']);
  clock.advance(10000);
  assert.deepEqual(rendered, ['A', 'B', 'C']);
});

test('queue limit drops the stalest of a view, keeping the tile current', () => {
  const { clock, rendered, q } = setup();
  q.request('factcheck', 10000, () => rendered.push('A')); // on screen
  q.request('factcheck', 10000, () => rendered.push('B')); // queued
  q.request('factcheck', 10000, () => rendered.push('C')); // queued (limit 2)
  q.request('factcheck', 10000, () => rendered.push('D')); // evicts B, the stalest
  assert.equal(q.queued().length, 2);
  clock.advance(10000);
  clock.advance(10000);
  assert.deepEqual(rendered, ['A', 'C', 'D'], 'B was dropped, freshest kept');
});

test('higher priority interrupts; lower priority waits', () => {
  const { clock, shown, q } = setup();
  q.request('scoreboard', 6000, () => {});
  assert.equal(q.current(), 'scoreboard');

  // fact-check outranks scoreboard -> interrupts immediately
  q.request('factcheck', 15000, () => {});
  assert.equal(q.current(), 'factcheck');

  // scoreboard now waits behind it
  q.request('scoreboard', 6000, () => {});
  assert.deepEqual(q.queued(), ['scoreboard']);
  clock.advance(15000);
  assert.equal(q.current(), 'scoreboard');

  // and with nothing pending we fall back to idle
  clock.advance(6000);
  assert.equal(q.current(), 'idle');
  assert.equal(shown.at(-1), 'idle');
});

test('receipts take over immediately and are terminal', () => {
  const { clock, rendered, q } = setup();
  q.request('factcheck', 15000, () => rendered.push('card'));
  q.request('factcheck', 15000, () => rendered.push('queued-card'));

  q.takeover('receipts', () => rendered.push('receipts'));
  assert.equal(q.current(), 'receipts');
  assert.deepEqual(q.queued(), [], 'pending cards discarded');

  // No fallback to idle, ever.
  clock.advance(120000);
  assert.equal(q.current(), 'receipts');
  assert.deepEqual(rendered, ['card', 'receipts']);
});

test('an idle tile shows the next event immediately', () => {
  const { clock, q } = setup();
  q.request('flag', 7000, () => {});
  assert.equal(q.current(), 'flag');
  clock.advance(7000);
  assert.equal(q.current(), 'idle');
  q.request('scoreboard', 6000, () => {});
  assert.equal(q.current(), 'scoreboard', 'no waiting when nothing is on screen');
});
