// cdp-gateway/panel.js — right-hand sidebar on the Selkies page: the CDP
// console (main browser + isolated contexts, their tabs, "Show",
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
  const WS = new URL('cdp-console/ws', document.baseURI);
  WS.protocol = WS.protocol === 'https:' ? 'wss:' : 'ws:';
  const PANEL_WIDTH = 380; // until the viewer drags the panel's left edge
  const MIN_WIDTH = 300;
  const MAX_WIDTH = 1000; // and never more than half the page
  const WIDTH_KEY = 'cdp-console-panel-width';
  const EDGE_PX = 48; // how close to the right edge the pointer brings up the handle

  async function call(method, path) {
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
        color-scheme:dark;
      }
      :host([data-theme="light"]) {
        --bg:#f6f7f9; --card:#ffffff; --text:#1d2330; --muted:#667085; --line:#e3e6eb;
        --accent:#2f6fde; --danger:#c43d3d; --chip:#eef2f8; --thumb:#dde2ea;
        color-scheme:light;
      }
      * { box-sizing:border-box; }
      .handle {
        position:absolute; top:50%; right:0; width:15px; height:60px; transform:translateY(-50%);
        background:var(--handle); border-radius:6px 0 0 6px; cursor:pointer; opacity:0;
        transition:opacity .2s, right .2s;
      }
      .handle.near, .handle:hover, :host(.open) .handle { opacity:1; }
      @media (hover: none) { .handle { opacity:.6; width:24px; } }
      :host(.open) .handle { right:min(var(--panel-width), 100vw); }
      .panel {
        position:absolute; top:0; right:0; width:min(var(--panel-width), 100vw); height:100%;
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
      .actions { margin-left:auto; display:flex; align-items:center; gap:6px; }
      .actions [hidden] { display:none; }
      .error { color:var(--danger); font-size:12px; padding:6px 14px 0; }
      .error:empty { display:none; }
      /* cards side by side once the panel is wide enough for two */
      .body {
        flex:1; overflow:auto; padding:12px 14px 24px; display:grid; gap:12px; align-content:start;
        grid-template-columns:repeat(auto-fill, minmax(min(100%, 340px), 1fr));
      }
      .resizer {
        position:absolute; top:0; bottom:0; left:-3px; width:7px; z-index:1; cursor:ew-resize;
        touch-action:none;
      }
      .resizer:hover, :host(.resizing) .resizer { background:var(--accent); opacity:.6; }
      :host(.resizing) .handle, :host(.resizing) .panel { transition:none; user-select:none; }
      .card {
        background:var(--card); border:1px solid var(--line); border-radius:10px;
        display:flex; flex-direction:column; min-width:0;
      }
      .card-head {
        display:flex; flex-wrap:wrap; align-items:center; gap:6px; padding:10px 12px;
        border-bottom:1px solid var(--line);
      }
      /* a narrow card wraps its buttons rather than squeezing the name */
      .name { font-weight:600; min-width:0; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
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
      /* current tab (thumbnail, title below) | all tabs, as tall as the thumbnail */
      .tabview {
        display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr);
        gap:10px; padding:10px 12px 12px;
      }
      .tabview[hidden], .empty[hidden], .chip[hidden] { display:none; }
      .shot {
        position:relative; overflow:hidden; cursor:pointer;
        background:var(--thumb); border-radius:6px; border:1px solid var(--line);
      }
      .thumb { display:block; width:100%; aspect-ratio:16 / 10; object-fit:cover; object-position:top; }
      /* the current tab's title, on a 70% gray banner across the thumbnail's bottom */
      .cur-title {
        position:absolute; left:0; right:0; bottom:0; padding:2px 6px;
        background:rgb(72 76 84 / 70%); color:#fff; font-size:12px; font-weight:500;
        overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
      }
      .cur-title:empty { display:none; }
      /* the browser in front on the desktop: a slow, soft glow */
      .card.front {
        border-color:var(--accent);
        animation:glow 2.4s ease-in-out infinite alternate;
      }
      @keyframes glow {
        from { box-shadow:0 0 4px 0 color-mix(in srgb, var(--accent) 35%, transparent); }
        to { box-shadow:0 0 14px 3px color-mix(in srgb, var(--accent) 65%, transparent); }
      }
      @media (prefers-reduced-motion: reduce) {
        .card.front { animation:none; box-shadow:0 0 10px 2px color-mix(in srgb, var(--accent) 55%, transparent); }
      }
      .chip.front { background:var(--accent); color:#fff; }
      .tabs-box { position:relative; }
      .tabs {
        position:absolute; inset:0; overflow:auto; list-style:none; margin:0; padding:3px;
        display:flex; flex-direction:column; gap:2px; border:1px solid var(--line); border-radius:6px;
      }
      .tabs li { min-width:0; flex:none; }
      .tabs button {
        display:block; width:100%; text-align:left; padding:2px 5px;
        border:none; border-left:3px solid transparent; border-radius:4px;
        overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
      }
      .tabs button:hover { background:var(--chip); color:var(--text); }
      .tabs button.current {
        background:color-mix(in srgb, var(--accent) 22%, transparent);
        border-left-color:var(--accent); font-weight:600;
      }
      .empty { color:var(--muted); padding:12px; }
    </style>
    <div class="handle" title="CDP console"></div>
    <aside class="panel" role="dialog" aria-label="CDP console" inert>
      <div class="resizer" title="Drag to resize"></div>
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
  // The live state streams in only while the panel is open.
  function setOpen(open) {
    host.classList.toggle('open', open);
    panel.inert = !open;
    if (open) {
      connect();
    } else {
      disconnect();
      if (root.activeElement) root.activeElement.blur(); // hand the keyboard back to the remote desktop
    }
  }
  handle.addEventListener('click', () => setOpen(!host.classList.contains('open')));
  $('.close').addEventListener('click', () => setOpen(false));
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });

  // Width: drag the panel's left edge; remembered per viewer. The cards and
  // their thumbnails follow (fractional grid columns).
  let width = 0;
  function setWidth(px, save) {
    width = Math.round(Math.max(MIN_WIDTH, Math.min(px, window.innerWidth / 2, MAX_WIDTH)));
    host.style.setProperty('--panel-width', `${width}px`);
    if (save) {
      try { localStorage.setItem(WIDTH_KEY, String(width)); } catch { /* storage blocked */ }
    }
  }
  let savedWidth = 0;
  try { savedWidth = Number(localStorage.getItem(WIDTH_KEY)) || 0; } catch { /* storage blocked */ }
  let wanted = savedWidth || PANEL_WIDTH; // the dragged width, kept while the page is too narrow for it
  setWidth(wanted, false);
  window.addEventListener('resize', () => setWidth(wanted, false), { passive: true });
  const resizer = $('.resizer');
  resizer.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation(); // not a click for the remote desktop
    resizer.setPointerCapture(e.pointerId);
    host.classList.add('resizing');
  });
  resizer.addEventListener('pointermove', (e) => {
    if (!host.classList.contains('resizing')) return;
    e.stopPropagation();
    setWidth(window.innerWidth - e.clientX, false);
  });
  resizer.addEventListener('lostpointercapture', () => {
    host.classList.remove('resizing');
    setWidth(wanted = width, true);
  });
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
  // what the gateway pushed over the WebSocket: name -> { ...fields, tabs: Map, current, thumb }
  const browsers = new Map();
  const views = new Map(); // name -> the card's DOM parts, see liveCard()
  let max = 0;

  function showError(err) {
    $('.error').textContent = err ? String(err.message || err) : '';
  }

  // Switch the browser to a tab and raise its window; highlighted right
  // away, the gateway's next 'current' confirms it.
  function focusTab(name, id) {
    const b = browsers.get(name);
    const before = b?.current;
    if (b?.tabs.has(id)) {
      b.current = id;
      update(name);
    }
    call('POST', `/${encodeURIComponent(name)}/focus/${encodeURIComponent(id)}`).catch((err) => {
      showError(err);
      if (b && b.current === id) {
        b.current = before;
        update(name);
      }
    });
  }

  // An on-demand main browser (CHROMIUM_AUTOSTART=false) that is not running:
  // a Start button instead of the tabs.
  function stoppedMainCard(context) {
    const starting = context.state === 'starting';
    const start = el('button', { class: 'primary', title: 'Start the main browser on the desktop',
      onclick: () => {
        start.disabled = true;
        start.textContent = 'Starting…';
        call('POST', '/main/start').catch(showError);
      } }, starting ? 'Starting…' : 'Start browser');
    start.disabled = starting;
    return { card: el('section', { class: 'card', style: 'border-top: 4px solid var(--line)' },
      el('div', { class: 'card-head' },
        el('span', { class: 'name' }, 'Main browser'),
        el('span', { class: 'chip' }, starting ? 'starting' : 'stopped'),
        el('span', { class: 'spacer' }), start),
      el('div', { class: 'empty' }, 'Not running. It starts on demand: with this button, or by itself when a CDP client connects.')) };
  }

  // The card's fixed parts; fillCard() keeps the changing ones up to date.
  function liveCard(context) {
    const isMain = !!context.main;
    const name = context.name;
    const base = `/${encodeURIComponent(name)}`;
    const v = { items: new Map(), src: '', shownCurrent: null };
    v.chip = el('span', { class: 'chip' });
    // the browser in front on the desktop shows "Showing" where its Show button was
    v.frontChip = el('span', { class: 'chip front', title: 'This browser window is in front on the desktop' }, 'Showing');
    v.show = el('button', { title: 'Bring this browser window to the front of the desktop',
      onclick: () => call('POST', `${base}/focus`).catch(showError) }, 'Show');
    // the buttons wrap as one group, right-aligned, when the card gets narrow
    const actions = el('span', { class: 'actions' }, v.frontChip, v.show);
    const head = el('div', { class: 'card-head' },
      el('span', { class: 'name', title: isMain ? 'Main browser' : name }, isMain ? 'Main browser' : name), v.chip,
      actions);
    if (isMain && context.onDemand) {
      actions.append(el('button', { class: 'danger', title: 'Close the main browser; the container keeps running',
        onclick: () => confirm('Stop the main browser? Its CDP clients get disconnected.')
          && call('POST', `${base}/stop`).catch(showError) }, 'Stop'));
    }
    if (!isMain) {
      actions.append(el('button', { class: 'danger', title: 'Close the context and disconnect its client',
        onclick: () => confirm(`Delete ${name}? Its client gets disconnected.`)
          && call('DELETE', base).catch(showError) }, 'Delete'));
    }
    v.meta = el('div', { class: 'meta' });
    v.img = el('img', { class: 'thumb', alt: '' });
    v.title = el('div', { class: 'cur-title' });
    const shot = el('div', { class: 'shot', title: 'Show this tab on the desktop' }, v.img, v.title);
    shot.onclick = () => {
      const current = browsers.get(name)?.current;
      if (current) focusTab(name, current);
    };
    v.list = el('ul', { class: 'tabs' });
    v.tabview = el('div', { class: 'tabview' }, shot, el('div', { class: 'tabs-box' }, v.list));
    v.empty = el('div', { class: 'empty' }, 'No open tabs.');
    // a context's color is also its browser frame color on the desktop
    v.card = el('section', { class: 'card', style: `border-top: 4px solid ${context.color || 'var(--line)'}` },
      head, v.meta, v.tabview, v.empty);
    return v;
  }

  // Bring a card in line with its state, touching only what changed: a
  // rebuild would drop the focus from the panel's buttons, and the keyboard
  // with it.
  function fillCard(context, v) {
    const n = context.tabs.size;
    v.chip.textContent = `${n} tab${n === 1 ? '' : 's'}`;
    // the browser the desktop (and the Selkies stream) shows in front
    v.card.classList.toggle('front', !!context.front);
    v.frontChip.hidden = !context.front;
    v.show.hidden = !!context.front;
    v.meta.textContent = context.main
      ? 'The persistent profile every isolated context is cloned from.'
      : `client ${context.client} · since ${new Date(context.createdAt).toLocaleTimeString()} · pid ${context.pid ?? '—'}`;
    v.tabview.hidden = !n;
    v.empty.hidden = !!n;
    for (const [id, li] of v.items) {
      if (context.tabs.has(id)) continue;
      li.remove();
      v.items.delete(id);
    }
    for (const tab of context.tabs.values()) {
      let li = v.items.get(tab.id);
      if (!li) {
        li = el('li', {}, el('button', { type: 'button', onclick: () => focusTab(context.name, tab.id) }));
        v.items.set(tab.id, li);
        v.list.append(li);
      }
      const button = li.firstChild;
      const title = tab.title || '(untitled)';
      if (button.textContent !== title) button.textContent = title;
      button.title = tab.url;
      button.classList.toggle('current', tab.id === context.current);
    }
    const current = context.tabs.get(context.current);
    v.title.textContent = current ? current.title || '(untitled)' : '';
    v.title.title = current?.url ?? '';
    // the thumbnail of the tab before stays out until the new one's arrives
    const thumb = context.thumb?.id === context.current ? `data:image/jpeg;base64,${context.thumb.jpeg}` : '';
    if (thumb !== v.src) {
      v.src = thumb;
      if (thumb) v.img.src = thumb;
      else v.img.removeAttribute('src');
    }
    if (context.current !== v.shownCurrent) {
      v.shownCurrent = context.current;
      const li = v.items.get(context.current);
      const top = v.list.scrollTop;
      if (li && (li.offsetTop < top || li.offsetTop + li.offsetHeight > top + v.list.clientHeight)) {
        v.list.scrollTop = li.offsetTop - 3;
      }
    }
  }

  function update(name) {
    const context = browsers.get(name);
    let v = views.get(name);
    if (!context) {
      v?.card.remove();
      views.delete(name);
      return;
    }
    const kind = context.main && context.state !== 'running' ? `main-${context.state}` : 'live';
    if (v?.kind !== kind) {
      const fresh = kind === 'live' ? liveCard(context) : stoppedMainCard(context);
      fresh.kind = kind;
      if (v) v.card.replaceWith(fresh.card);
      else if (context.main) body.prepend(fresh.card);
      else body.append(fresh.card);
      views.set(name, v = fresh);
    }
    if (kind === 'live') fillCard(context, v);
  }

  // Apply one op of the gateway's protocol (gateway.mjs, "console live
  // state"); returns the names of the browsers it touched.
  function apply(op) {
    if (op.t === 'snapshot') {
      max = op.max;
      browsers.clear();
      views.clear();
      body.replaceChildren();
      for (const b of op.browsers) browsers.set(b.name, { ...b, tabs: new Map(b.tabs.map((t) => [t.id, t])) });
      return [...browsers.keys()];
    }
    if (op.t === 'gone') {
      browsers.delete(op.name);
      return [op.name];
    }
    let b = browsers.get(op.name);
    if (!b) browsers.set(op.name, b = { name: op.name, tabs: new Map(), current: null, thumb: null });
    if (op.t === 'browser') {
      const { t, ...fields } = op;
      Object.assign(b, fields);
    } else if (op.t === 'tabs') {
      for (const tab of op.set) b.tabs.set(tab.id, tab);
      for (const id of op.del) b.tabs.delete(id);
    } else if (op.t === 'current') {
      b.current = op.id;
    } else if (op.t === 'thumb') {
      b.thumb = { id: op.id, jpeg: op.jpeg };
    }
    return [op.name];
  }

  // --- live state: WebSocket to the gateway (cdp-console/ws) -----------------
  // A snapshot, then only changes. Reconnects with backoff while open.
  let ws = null;
  let retry = 1000;
  let retryTimer = 0;

  function connect() {
    if (ws) return;
    ws = new WebSocket(WS);
    ws.onopen = () => {
      retry = 1000;
      showError(null);
    };
    ws.onmessage = (e) => {
      const touched = new Set();
      for (const op of JSON.parse(e.data).ops) {
        for (const name of apply(op)) touched.add(name);
      }
      touched.forEach(update);
      const n = [...browsers.values()].filter((b) => !b.main).length;
      $('.summary').textContent = `${n} of ${max} contexts`;
    };
    ws.onclose = () => {
      ws = null;
      showError(`Lost the connection to the CDP gateway, reconnecting in ${retry / 1000}s…`);
      retryTimer = setTimeout(connect, retry);
      retry = Math.min(retry * 2, 10000);
    };
  }

  function disconnect() {
    clearTimeout(retryTimer);
    if (!ws) return;
    ws.onclose = null;
    ws.close();
    ws = null;
  }

  // Running at all means the gateway let this user in: it serves this script
  // uncached, behind the same master password as the console (a view-only
  // login gets 401 and the Selkies page stays untouched).
  document.body.appendChild(host);
})();
