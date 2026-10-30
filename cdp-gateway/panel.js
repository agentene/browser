// cdp-gateway/panel.js — right-hand sidebar on the Selkies page: the CDP
// console (main browser + isolated contexts, their tabs, "Show on desktop",
// delete; start/stop of an on-demand main browser) next to the live desktop.
//
// nginx injects it into the Selkies entry page (sub_filter before </head>,
// entrypoint/lib/nginx.sh) and proxies cdp-console/ — relative to the page,
// so SELKIES_SUBFOLDER works — to /console/ on the gateway. Same origin as
// Selkies on purpose: the browser resends the page's Basic Auth, which the
// gateway checks against Selkies' master password (view-only users get 401
// and never see the handle).
//
// Keyboard: the Selkies core grabs keys in the window capture phase and only
// leaves those whose target sits under an `allow-native-input` element;
// events from inside the shadow root are retargeted to the host, so the
// class on the host covers the whole panel. Ctrl+Shift+M/F/X/G are Selkies
// hotkeys handled before that check — do not bind them here.
(() => {
  'use strict';
  if (window.__cdpConsolePanel) return;
  window.__cdpConsolePanel = true;

  const API = new URL('cdp-console/api', document.baseURI).href;
  const PANEL_WIDTH = 380;
  const EDGE_PX = 48; // how close to the right edge the pointer brings up the handle
  const REFRESH_MS = 2000;
  const THUMB_REFRESH_MS = 4000;

  async function call(method, path = '') {
    const res = await fetch(API + path, {
      method,
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { 'X-CDP-Console': '1' },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
    return data;
  }

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'onclick') node.onclick = v;
      else node.setAttribute(k, v);
    }
    node.append(...children);
    return node;
  }

  const host = el('div', { id: 'cdp-console-panel', class: 'allow-native-input' });
  host.style.cssText = 'position:fixed;top:0;right:0;width:0;height:100%;z-index:10000;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host {
        --bg:#1b2029; --card:#232a35; --text:#e6e9ef; --muted:#98a2b3; --line:#2f3744;
        --accent:#6b9cf5; --danger:#f07171; --chip:#2c3442; --thumb:#2f3744; --handle:#2f6fde;
      }
      :host([data-theme="light"]) {
        --bg:#f6f7f9; --card:#ffffff; --text:#1d2330; --muted:#667085; --line:#e3e6eb;
        --accent:#2f6fde; --danger:#c43d3d; --chip:#eef2f8; --thumb:#dde2ea;
      }
      * { box-sizing:border-box; }
      .handle {
        position:absolute; top:50%; right:0; width:15px; height:60px; transform:translateY(-50%);
        background:var(--handle); border-radius:6px 0 0 6px; cursor:pointer; opacity:0;
        transition:opacity .2s, right .2s;
      }
      .handle.near, .handle:hover, :host(.open) .handle { opacity:1; }
      @media (hover: none) { .handle { opacity:.6; width:24px; } }
      :host(.open) .handle { right:min(${PANEL_WIDTH}px, 100vw); }
      .panel {
        position:absolute; top:0; right:0; width:min(${PANEL_WIDTH}px, 100vw); height:100%;
        display:flex; flex-direction:column; background:var(--bg); color:var(--text);
        font:14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
        box-shadow:-4px 0 16px rgba(0,0,0,.35); transform:translateX(100%); transition:transform .2s;
      }
      :host(.open) .panel { transform:none; }
      header {
        display:flex; align-items:center; gap:8px; padding:12px 14px;
        border-bottom:1px solid var(--line);
      }
      h2 { font-size:15px; margin:0; }
      .summary { color:var(--muted); font-size:12px; }
      .spacer { flex:1; }
      .error { color:var(--danger); font-size:12px; padding:6px 14px 0; }
      .error:empty { display:none; }
      .body { flex:1; overflow:auto; padding:12px 14px 24px; display:grid; gap:12px; align-content:start; }
      .card {
        background:var(--card); border:1px solid var(--line); border-radius:10px;
        display:flex; flex-direction:column; min-width:0;
      }
      .card-head {
        display:flex; align-items:center; gap:6px; padding:10px 12px;
        border-bottom:1px solid var(--line);
      }
      .name { font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .chip {
        background:var(--chip); color:var(--muted); border-radius:999px;
        padding:1px 8px; font-size:12px; white-space:nowrap;
      }
      .meta { color:var(--muted); font-size:12px; padding:8px 12px 0; }
      button {
        font:inherit; font-size:12px; border-radius:6px; padding:3px 8px; cursor:pointer;
        border:1px solid var(--line); background:transparent; color:var(--text); white-space:nowrap;
      }
      button:hover { border-color:var(--accent); color:var(--accent); }
      button.danger:hover { border-color:var(--danger); color:var(--danger); }
      button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
      button.primary:hover { color:#fff; filter:brightness(1.1); }
      button:disabled { opacity:.6; cursor:default; }
      button.close { border:none; font-size:18px; line-height:1; padding:0 4px; }
      ul { list-style:none; margin:0; padding:10px 12px 12px; display:grid; gap:10px; }
      li { display:grid; grid-template-columns:96px 1fr; gap:10px; align-items:start; min-width:0; }
      .thumb {
        width:96px; aspect-ratio:16 / 10; object-fit:cover; object-position:top;
        background:var(--thumb); border-radius:6px; border:1px solid var(--line); cursor:pointer;
      }
      .tab-title { font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .tab-url { color:var(--muted); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .empty { color:var(--muted); padding:12px; }
    </style>
    <div class="handle" title="CDP console"></div>
    <aside class="panel" role="dialog" aria-label="CDP console" inert>
      <header>
        <h2>CDP Console</h2><span class="summary"></span>
        <span class="spacer"></span>
        <button class="close" aria-label="Close">×</button>
      </header>
      <div class="error"></div>
      <div class="body"></div>
    </aside>`;
  const $ = (sel) => root.querySelector(sel);
  const handle = $('.handle'), panel = $('.panel'), body = $('.body');

  // --- open / close ----------------------------------------------------------
  let timer = 0;
  function setOpen(open) {
    host.classList.toggle('open', open);
    panel.inert = !open;
    clearInterval(timer);
    if (open) {
      lastRender = '';
      refresh();
      timer = setInterval(refresh, REFRESH_MS);
    } else if (root.activeElement) {
      root.activeElement.blur(); // hand the keyboard back to the remote desktop
    }
  }
  handle.addEventListener('click', () => setOpen(!host.classList.contains('open')));
  $('.close').addEventListener('click', () => setOpen(false));
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
  window.addEventListener('mousemove', (e) => {
    handle.classList.toggle('near', window.innerWidth - e.clientX < EDGE_PX);
  }, { passive: true });

  // follow the classic Selkies dashboard's theme (localStorage 'theme')
  function syncTheme() {
    let theme = 'dark';
    try { theme = localStorage.getItem('theme') || 'dark'; } catch { /* storage blocked */ }
    host.dataset.theme = theme;
  }
  syncTheme();
  window.addEventListener('storage', syncTheme);

  // --- rendering (mirrors dashboard.html) ------------------------------------
  let thumbStamp = Date.now();
  let lastRender = '';

  function showError(err) {
    $('.error').textContent = err ? String(err.message || err) : '';
  }

  // An on-demand main browser (CHROMIUM_AUTOSTART=false) that is not running:
  // a Start button instead of the tab list.
  function stoppedMainCard(context) {
    const starting = context.state === 'starting';
    const start = el('button', { class: 'primary', title: 'Start the main browser on the desktop',
      onclick: () => {
        start.disabled = true;
        start.textContent = 'Starting…';
        call('POST', '/main/start').then(refresh, (err) => { showError(err); refresh(); });
      } }, starting ? 'Starting…' : 'Start browser');
    start.disabled = starting;
    return el('section', { class: 'card', style: 'border-top: 4px solid var(--line)' },
      el('div', { class: 'card-head' },
        el('span', { class: 'name' }, 'Main browser'),
        el('span', { class: 'chip' }, starting ? 'starting' : 'stopped'),
        el('span', { class: 'spacer' }), start),
      el('div', { class: 'empty' }, 'Not running. It starts on demand: with this button, or by itself when a CDP client connects.'));
  }

  function card(context, isMain) {
    if (isMain && context.state && context.state !== 'running') return stoppedMainCard(context);
    const base = `/${encodeURIComponent(context.name)}`;
    const head = el('div', { class: 'card-head' },
      el('span', { class: 'name', title: isMain ? 'Main browser' : context.name }, isMain ? 'Main browser' : context.name),
      el('span', { class: 'chip' }, `${context.tabs.length} tab${context.tabs.length === 1 ? '' : 's'}`),
      el('span', { class: 'spacer' }),
      el('button', { title: 'Bring this browser window to the front of the desktop',
        onclick: () => call('POST', `${base}/focus`).catch(showError) }, 'Show on desktop'));
    if (isMain && context.onDemand) {
      head.append(el('button', { class: 'danger', title: 'Close the main browser; the container keeps running',
        onclick: () => confirm('Stop the main browser? Its CDP clients get disconnected.')
          && call('POST', `${base}/stop`).then(refresh, showError) }, 'Stop'));
    }
    if (!isMain) {
      head.append(el('button', { class: 'danger', title: 'Close the context and disconnect its client',
        onclick: () => confirm(`Delete ${context.name}? Its client gets disconnected.`)
          && call('DELETE', base).then(refresh, showError) }, 'Delete'));
    }
    // a context's color is also its browser frame color on the desktop
    const node = el('section', { class: 'card', style: `border-top: 4px solid ${context.color || 'var(--line)'}` }, head);
    node.append(el('div', { class: 'meta' }, isMain
      ? 'The persistent profile every isolated context is cloned from.'
      : `client ${context.client} · since ${new Date(context.createdAt).toLocaleTimeString()} · pid ${context.pid ?? '—'}`));
    if (!context.tabs.length) {
      node.append(el('div', { class: 'empty' }, 'No open tabs.'));
      return node;
    }
    const list = el('ul');
    for (const tab of context.tabs) {
      const img = el('img', { class: 'thumb', alt: '', loading: 'lazy',
        'data-src': `${API}${base}/thumb/${encodeURIComponent(tab.id)}`,
        title: 'Show this tab on the desktop' });
      img.src = `${img.dataset.src}?t=${thumbStamp}`;
      img.onerror = () => img.removeAttribute('src');
      img.onclick = () => call('POST', `${base}/focus/${encodeURIComponent(tab.id)}`).catch(showError);
      list.append(el('li', {}, img, el('div', { style: 'min-width:0' },
        el('div', { class: 'tab-title', title: tab.title }, tab.title || '(untitled)'),
        el('div', { class: 'tab-url', title: tab.url }, tab.url))));
    }
    node.append(list);
    return node;
  }

  function render(state) {
    $('.summary').textContent = `${state.contexts.length} of ${state.max} contexts`;
    const stale = Date.now() - thumbStamp > THUMB_REFRESH_MS;
    if (stale) thumbStamp = Date.now();
    // Rebuild only when the contexts or tabs changed: a rebuild drops the
    // focus from the panel's buttons, and the keyboard with it. Otherwise
    // just reload the thumbnails in place.
    const key = JSON.stringify(state);
    if (key !== lastRender) {
      lastRender = key;
      body.replaceChildren(card(state.main, true), ...state.contexts.map((s) => card(s, false)));
    } else if (stale) {
      for (const img of body.querySelectorAll('img.thumb')) img.src = `${img.dataset.src}?t=${thumbStamp}`;
    }
  }

  async function refresh() {
    try {
      render(await call('GET'));
      showError(null);
    } catch (err) {
      showError(err);
    }
  }

  // Mount only for users the gateway lets in: a view-only login (401) or a
  // missing gateway (404/502) leaves the Selkies page untouched.
  call('GET').then(() => document.body.appendChild(host), () => {});
})();
