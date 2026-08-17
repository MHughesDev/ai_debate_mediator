// Single-focus view scheduler for the bot tile (SPEC §3.7: "one thing at a
// time", fact-check card holds ~15s). Pure logic, no DOM — so it is unit
// testable in node and shared by any surface that rotates hero states.
//
// Rules:
//   - A card on screen keeps its full hold; only a STRICTLY higher-priority
//     state interrupts it (same-priority events would otherwise cut each other
//     short during a burst of fact-checks and be unreadable).
//   - Same/lower priority events queue, each carrying its own render fn so a
//     queued card paints its own content rather than the newest event's.
//   - Per-view queue limits keep the tile current: when the limit is hit the
//     stalest entry of that view is dropped, not the freshest.
export const DEFAULT_PRIORITY = { receipts: 4, factcheck: 3, flag: 2, scoreboard: 1 };
export const DEFAULT_QUEUE_LIMIT = { factcheck: 2, flag: 1, scoreboard: 1, receipts: 1 };

export function createViewQueue({
  onShow,
  idleView = 'idle',
  priority = DEFAULT_PRIORITY,
  queueLimit = DEFAULT_QUEUE_LIMIT,
  defaultHoldMs = 8000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const state = { current: idleView, queue: [], holdTimer: null };

  function show(view) {
    state.current = view;
    onShow(view);
  }

  function hold(view, holdMs) {
    clearTimer(state.holdTimer);
    show(view);
    state.holdTimer = setTimer(() => {
      const next = state.queue.shift();
      if (next) {
        next.render();
        hold(next.view, next.holdMs);
      } else {
        show(idleView);
      }
    }, holdMs || defaultHoldMs);
  }

  return {
    request(view, holdMs, render = () => {}) {
      if (state.current === idleView || priority[view] > (priority[state.current] ?? 0)) {
        render();
        hold(view, holdMs);
        return;
      }
      const limit = queueLimit[view] ?? 1;
      while (state.queue.filter((q) => q.view === view).length >= limit) {
        state.queue.splice(state.queue.findIndex((q) => q.view === view), 1);
      }
      state.queue.push({ view, holdMs, render });
    },
    // Terminal states (receipts) take over and cancel anything pending.
    takeover(view, render = () => {}) {
      clearTimer(state.holdTimer);
      state.queue.length = 0;
      render();
      show(view);
    },
    current: () => state.current,
    queued: () => state.queue.map((q) => q.view),
  };
}
