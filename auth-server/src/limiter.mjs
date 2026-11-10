// Failed password attempts per client address: after MAX_FAILURES within
// WINDOW_MS that address gets 429 until the window has passed. A success
// clears its count.

export const MAX_FAILURES = 10;
export const WINDOW_MS = 15 * 60 * 1000;

export class Limiter {
  constructor(max = MAX_FAILURES, windowMs = WINDOW_MS) {
    this.max = max;
    this.windowMs = windowMs;
    this.failures = new Map(); // address -> { count, since }
  }

  entry(address, now) {
    const e = this.failures.get(address);
    if (e && now - e.since >= this.windowMs) {
      this.failures.delete(address);
      return null;
    }
    return e ?? null;
  }

  // Seconds until the address may try again, 0 = now.
  blockedFor(address, now = Date.now()) {
    const e = this.entry(address, now);
    return e && e.count >= this.max ? Math.ceil((e.since + this.windowMs - now) / 1000) : 0;
  }

  fail(address, now = Date.now()) {
    const e = this.entry(address, now);
    if (e) e.count += 1;
    else this.failures.set(address, { count: 1, since: now });
    if (this.failures.size > 10_000) this.failures.delete(this.failures.keys().next().value);
  }

  succeed(address) {
    this.failures.delete(address);
  }
}
