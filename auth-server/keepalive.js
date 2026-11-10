// auth-server/keepalive.js — keeps this browser's login session alive while a
// page of the web UI (the Selkies page: nginx injects this script) or the CDP
// console (cdp-gateway/dashboard.html loads it) is open, idle background tab
// included.
//
// Served by the auth service next to its API (…/__auth/keepalive.js), so it
// only loads where the built-in login is on (ENABLE_AUTH=true). The session
// cookie is HttpOnly, so the server decides: POST api/renew hands out a fresh
// cookie once the current one is due (store.mjs: SESSION_RENEW_AFTER_MS) and
// says how long until the next one is — about one request per page load and
// per day. In between the page holds a single timer, nothing else:
//   * it sleeps at most an hour at a time and then compares the wall clock,
//     because timers stall while the machine sleeps or the tab is frozen;
//   * waking up (tab shown again, unfrozen, back online, restored from the
//     back/forward cache) re-checks at once, still without a request until
//     one is due;
//   * several tabs need no coordination: whichever asks first renews the
//     shared cookie, the others then hear "not due yet" and go back to sleep;
//   * signed out (401) or no login at all (renewIn null) = it stops.
(() => {
  'use strict';
  if (window.AgenteneKeepalive) return;
  window.AgenteneKeepalive = true;

  const RENEW = new URL('api/renew', document.currentScript.src).href;
  const MAX_SLEEP_MS = 3600 * 1000;
  const RETRY_MS = 5 * 60 * 1000; // network or server trouble

  let due = 0; // wall-clock time of the next renewal; Infinity = stopped
  let timer = 0;
  let busy = false;

  function arm() {
    clearTimeout(timer);
    if (due !== Infinity) timer = setTimeout(check, Math.min(Math.max(due - Date.now(), 0), MAX_SLEEP_MS));
  }

  function after(ms) {
    due = typeof ms === 'number' ? Date.now() + ms : Infinity;
    arm();
  }

  async function check() {
    if (busy) return;
    if (Date.now() < due) return arm();
    busy = true;
    try {
      const res = await fetch(RENEW, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (res.status === 401) after(null);
      else after(res.ok ? (await res.json()).renewIn : RETRY_MS);
    } catch {
      after(RETRY_MS);
    } finally {
      busy = false;
    }
  }

  document.addEventListener('visibilitychange', () => document.hidden || check());
  document.addEventListener('resume', check);
  window.addEventListener('online', check);
  window.addEventListener('pageshow', (e) => e.persisted && check());
  check();
})();
