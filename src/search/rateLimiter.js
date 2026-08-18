// Deadline-aware rate limiter for quota-capped backends.
//
// Paced so a burst of concurrent claims cannot spike a vendor's rate ceiling,
// and so a metered backend spends its allowance deliberately rather than as
// fast as claims arrive. Two properties matter:
//
//   1. Slots are reserved SYNCHRONOUSLY, so concurrent callers can never claim
//      the same instant — the reservation happens before any await.
//   2. Waiting is deadline-aware: if a caller's slot would land after its
//      verdict deadline, it is told to skip immediately rather than blocking
//      and then timing out. Losing one backend on one claim is fine; delaying
//      a verdict is not.
export function createRateLimiter({ minIntervalMs = 1000 } = {}) {
  let nextAvailableAt = 0;

  return {
    /**
     * Reserve the next slot. Returns the ms to wait, or null when the slot
     * would fall past the deadline (caller should skip this backend).
     */
    reserve({ deadlineAt = Infinity } = {}) {
      const now = Date.now();
      const slotAt = Math.max(now, nextAvailableAt);
      if (slotAt > deadlineAt) return null;
      nextAvailableAt = slotAt + minIntervalMs;
      return slotAt - now;
    },

    async acquire({ deadlineAt = Infinity, signal } = {}) {
      const wait = this.reserve({ deadlineAt });
      if (wait === null) return false;
      if (wait > 0) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, wait);
          signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('aborted while waiting for rate limit slot'));
          }, { once: true });
        });
      }
      return true;
    },

    // Back off after a 429: push every future slot out by the vendor's hint.
    penalize(ms) {
      nextAvailableAt = Math.max(nextAvailableAt, Date.now() + ms);
    },

    state: () => ({ nextAvailableAt, minIntervalMs }),
  };
}

// Thrown when a backend is skipped for quota reasons. Distinct from a failure:
// the backend is healthy, we simply had no budget for it on this claim, so it
// must not count toward the circuit breaker.
export class QuotaSkip extends Error {
  constructor(message) {
    super(message);
    this.name = 'QuotaSkip';
    this.skip = true;
  }
}
