// cdp-gateway/panel.js — right-hand sidebar on the Selkies page: the CDP
// console (main browser + isolated contexts, their tabs, "Show",
// delete; start/stop of an on-demand main browser) next to the live desktop.
//
// nginx injects it into the Selkies entry page (sub_filter before </head>,
// entrypoint/lib/nginx.sh) and proxies cdp-console/ — relative to the page,
// so SELKIES_SUBFOLDER works — to /console/ on the gateway. Same origin as
// Selkies on purpose: the browser resends the page's Basic Auth, which the
// gateway checks against Selkies' master password (view-only users get 401
// and never see the handle), and the built-in login's session cookie, which
// nginx checks (ENABLE_AUTH). Its settings menu also carries the built-in
// login's controls (login, CDP API key, log out): __auth/ui.js, served by
// the auth service next to the page.
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

  async function call(method, path, body) {
    const res = await fetch(API + path, {
      method,
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { 'X-CDP-Console': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
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
      /* settings: the header's gear and its menu */
      .settings { position:relative; }
      .settings-btn {
        display:inline-flex; align-items:center; justify-content:center; width:30px; height:28px; padding:0;
        border:1px solid var(--line); border-radius:6px; background:transparent; color:var(--muted); cursor:pointer;
      }
      .settings-btn:hover, .settings-btn[aria-expanded="true"] { border-color:var(--accent); color:var(--accent); }
      .settings-menu {
        position:absolute; right:0; top:calc(100% + 6px); z-index:20; width:min(300px, calc(100vw - 32px));
        display:grid; gap:12px; padding:12px 14px; background:var(--card); color:var(--text);
        border:1px solid var(--line); border-radius:10px; box-shadow:0 8px 24px rgba(0,0,0,.2);
        font-size:13px; line-height:1.45; text-align:left;
      }
      .settings-menu[hidden], .setting[hidden] { display:none; }
      .settings-title { margin:0; font-weight:600; }
      .setting { display:flex; align-items:center; justify-content:space-between; gap:12px; cursor:default; }
      label.setting { cursor:pointer; }
      .setting-hint { display:block; margin-top:2px; color:var(--muted); font-size:12px; }
      .seg { display:inline-flex; flex:none; border:1px solid var(--line); border-radius:6px; overflow:hidden; }
      .seg button {
        border:none; border-radius:0; padding:3px 10px; background:transparent; color:var(--muted);
        font:inherit; font-size:12px; cursor:pointer;
      }
      .seg button + button { border-left:1px solid var(--line); }
      .seg button[aria-pressed="true"], .seg button[aria-pressed="true"]:hover { background:var(--accent); color:#fff; }
      .switch {
        appearance:none; -webkit-appearance:none; flex:none; position:relative; width:36px; height:20px; margin:0;
        border-radius:999px; background:color-mix(in srgb, var(--muted) 45%, transparent); cursor:pointer; transition:background .15s;
      }
      .switch::before {
        content:""; position:absolute; top:2px; left:2px; width:16px; height:16px; border-radius:50%;
        background:#fff; box-shadow:0 1px 2px rgba(0,0,0,.3); transition:transform .15s;
      }
      .switch:checked { background:var(--accent); }
      .switch:checked::before { transform:translateX(16px); }
      .settings-btn:focus-visible, .seg button:focus-visible, .switch:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
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
    <div class="handle"></div>
    <aside class="panel" role="dialog" inert>
      <div class="resizer"></div>
      <header>
        <h2></h2><span class="summary"></span>
        <span class="spacer"></span>
        <div class="settings">
          <button class="settings-btn" type="button" aria-haspopup="dialog" aria-expanded="false"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
          <div class="settings-menu" role="dialog" hidden>
            <p class="settings-title"></p>
            <div class="setting">
              <span class="lang-label"></span>
              <span class="seg" role="group"><button type="button" data-lang="en" lang="en">English</button><button type="button" data-lang="zh" lang="zh-CN">中文</button></span>
            </div>
            <label class="setting raise-row" hidden>
              <span><span class="raise-label"></span><span class="setting-hint raise-hint"></span></span>
              <input class="switch" type="checkbox" role="switch">
            </label>
          </div>
        </div>
        <button class="close">×</button>
      </header>
      <div class="error"></div>
      <div class="body"></div>
    </aside>`;
  const $ = (sel) => root.querySelector(sel);
  const handle = $('.handle'), panel = $('.panel'), body = $('.body');

  // --- language ---------------------------------------------------------------
  // English and Simplified Chinese: the viewer's choice (the settings menu,
  // remembered per browser), else the browser's languages.
  const STRINGS = {
    en: {
      title: 'CDP Console',
      loading: 'loading…',
      mainBrowser: 'Main browser',
      startTitle: 'Start the main browser on the desktop',
      starting: 'Starting…',
      startBrowser: 'Start browser',
      stateStarting: 'starting',
      stateStopped: 'stopped',
      notRunning: 'Not running. It starts on demand: with this button, or by itself when a CDP client connects.',
      frontTitle: 'This browser window is in front on the desktop',
      showing: 'Showing',
      showTitle: 'Bring this browser window to the front of the desktop',
      show: 'Show',
      stopTitle: 'Close the main browser; the container keeps running',
      stopConfirm: 'Stop the main browser? Its CDP clients get disconnected.',
      stop: 'Stop',
      deleteTitle: 'Close the context and disconnect its client',
      deleteConfirm: (name) => `Delete ${name}? Its client gets disconnected.`,
      delete: 'Delete',
      shotTitle: 'Show this tab on the desktop',
      noTabs: 'No open tabs.',
      untitled: '(untitled)',
      tabs: (n) => `${n} tab${n === 1 ? '' : 's'}`,
      mainMeta: 'The persistent profile every isolated context is cloned from.',
      contextMeta: (client, since, pid) => `client ${client} · since ${since} · pid ${pid}`,
      summary: (n, max) => `${n} of ${max} contexts`,
      reconnecting: (s) => `Lost the connection to the CDP gateway, reconnecting in ${s}s…`,
      resizeTitle: 'Drag to resize',
      close: 'Close',
      settings: 'Settings',
      language: 'Language',
      raiseNew: 'New windows to the front',
      raiseNewHint: 'Off: windows that open later (e.g. a new isolated context) stay behind the one in front; Show brings one forward.',
    },
    zh: {
      title: 'CDP 控制台',
      loading: '加载中…',
      mainBrowser: '主浏览器',
      startTitle: '在桌面上启动主浏览器',
      starting: '启动中…',
      startBrowser: '启动浏览器',
      stateStarting: '启动中',
      stateStopped: '已停止',
      notRunning: '未运行。按需启动：点击此按钮，或在有 CDP 客户端连接时自动启动。',
      frontTitle: '此浏览器窗口位于桌面最前',
      showing: '显示中',
      showTitle: '将此浏览器窗口切到桌面最前',
      show: '显示',
      stopTitle: '关闭主浏览器，容器继续运行',
      stopConfirm: '停止主浏览器？它的 CDP 客户端将断开连接。',
      stop: '停止',
      deleteTitle: '关闭此上下文并断开其客户端',
      deleteConfirm: (name) => `删除 ${name}？它的客户端将断开连接。`,
      delete: '删除',
      shotTitle: '在桌面上显示此标签页',
      noTabs: '没有打开的标签页。',
      untitled: '（无标题）',
      tabs: (n) => `${n} 个标签页`,
      mainMeta: '持久化的浏览器配置，每个隔离上下文都从它克隆。',
      contextMeta: (client, since, pid) => `客户端 ${client} · 创建于 ${since} · pid ${pid}`,
      summary: (n, max) => `${n} / ${max} 个上下文`,
      reconnecting: (s) => `与 CDP 网关的连接已断开，${s} 秒后重连…`,
      resizeTitle: '拖动调整宽度',
      close: '关闭',
      settings: '设置',
      language: '语言',
      raiseNew: '新窗口切到最前',
      raiseNewHint: '关闭后，之后新打开的窗口（如新的隔离上下文）留在当前窗口之后，可用“显示”切过去。',
    },
  };
  const LANG_KEY = 'cdp-console-lang';
  let lang = '';
  try { lang = localStorage.getItem(LANG_KEY) || ''; } catch { /* storage blocked */ }
  if (!STRINGS[lang]) lang = navigator.languages?.find((l) => /^(zh|en)\b/i.test(l))?.slice(0, 2).toLowerCase() || 'en';
  const locale = () => (lang === 'zh' ? 'zh-CN' : 'en');

  function t(key, ...args) {
    const s = STRINGS[lang][key];
    return typeof s === 'function' ? s(...args) : s;
  }

  // Static texts here; the cards are rebuilt in the new language.
  function setLang(next, save) {
    lang = next;
    if (save) {
      try { localStorage.setItem(LANG_KEY, lang); } catch { /* storage blocked */ }
    }
    $('.handle').title = t('title');
    panel.setAttribute('aria-label', t('title'));
    $('.resizer').title = t('resizeTitle');
    $('h2').textContent = t('title');
    $('.close').setAttribute('aria-label', t('close'));
    settingsBtn.title = t('settings');
    settingsBtn.setAttribute('aria-label', t('settings'));
    settingsMenu.setAttribute('aria-label', t('settings'));
    $('.settings-title').textContent = t('settings');
    $('.lang-label').textContent = t('language');
    for (const b of settings.querySelectorAll('[data-lang]')) b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
    $('.raise-label').textContent = t('raiseNew');
    $('.raise-hint').textContent = t('raiseNewHint');
    window.AgenteneAuth?.setLang(lang);
    for (const v of views.values()) v.card.remove();
    views.clear();
    browsers.forEach((b, name) => update(name));
    renderSummary();
  }

  // Settings: the header's gear opens a menu with the console's language and
  // the desktop's "new windows to the front" switch (only with a desktop).
  const settings = $('.settings');
  const settingsBtn = $('.settings-btn');
  const settingsMenu = $('.settings-menu');
  function setMenu(open) {
    settingsMenu.hidden = !open;
    settingsBtn.setAttribute('aria-expanded', String(open));
  }
  settingsBtn.addEventListener('click', () => setMenu(settingsMenu.hidden));
  document.addEventListener('pointerdown', (e) => {
    if (!settingsMenu.hidden && !e.composedPath().includes(settings)) setMenu(false);
  });
  settings.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || settingsMenu.hidden) return;
    e.stopPropagation(); // the menu closes first, not what it sits in
    setMenu(false);
    settingsBtn.focus();
  });
  for (const b of settings.querySelectorAll('[data-lang]')) b.addEventListener('click', () => setLang(b.dataset.lang, true));

  // The built-in login's rows in the menu and their dialogs (in the shadow
  // root, so the panel's keyboard rules cover them); absent without
  // ENABLE_AUTH.
  const authUi = document.createElement('script');
  authUi.src = new URL('__auth/ui.js', document.baseURI).href;
  authUi.onload = () => {
    window.AgenteneAuth?.setLang(lang);
    window.AgenteneAuth?.mount({ menu: settingsMenu, root, onError: showError });
  };
  document.head.append(authUi);

  // --- open / close ----------------------------------------------------------
  // The live state streams in only while the panel is open.
  function setOpen(open) {
    host.classList.toggle('open', open);
    panel.inert = !open;
    if (open) {
      connect();
    } else {
      disconnect();
      setMenu(false);
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
  let serverSettings = {}; // the server-side settings on offer (settings.mjs): {section: {key: value}}

  function renderSummary() {
    const n = [...browsers.values()].filter((b) => !b.main).length;
    $('.summary').textContent = views.size ? t('summary', n, max) : '';
  }

  function showError(err) {
    $('.error').textContent = err ? String(err.message || err) : '';
  }

  // The desktop's "new windows to the front" switch; the gateway's 'settings'
  // op confirms a flip, a failed one flips back.
  const raiseRow = $('.raise-row');
  const raiseBox = $('.switch');
  function renderRaiseNew() {
    const on = serverSettings.desktop?.raiseNewWindows;
    raiseRow.hidden = on === undefined; // no desktop
    raiseBox.checked = !!on;
  }
  raiseBox.addEventListener('change', () => {
    call('PATCH', '/settings', { desktop: { raiseNewWindows: raiseBox.checked } }).catch((err) => {
      showError(err);
      renderRaiseNew();
    });
  });

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
    const start = el('button', { class: 'primary', title: t('startTitle'),
      onclick: () => {
        start.disabled = true;
        start.textContent = t('starting');
        call('POST', '/main/start').catch(showError);
      } }, starting ? t('starting') : t('startBrowser'));
    start.disabled = starting;
    return { card: el('section', { class: 'card', style: 'border-top: 4px solid var(--line)' },
      el('div', { class: 'card-head' },
        el('span', { class: 'name' }, t('mainBrowser')),
        el('span', { class: 'chip' }, starting ? t('stateStarting') : t('stateStopped')),
        el('span', { class: 'spacer' }), start),
      el('div', { class: 'empty' }, t('notRunning'))) };
  }

  // The card's fixed parts; fillCard() keeps the changing ones up to date.
  function liveCard(context) {
    const isMain = !!context.main;
    const name = context.name;
    const base = `/${encodeURIComponent(name)}`;
    const v = { items: new Map(), src: '', shownCurrent: null };
    v.chip = el('span', { class: 'chip' });
    // the browser in front on the desktop shows "Showing" where its Show button was
    v.frontChip = el('span', { class: 'chip front', title: t('frontTitle') }, t('showing'));
    v.show = el('button', { title: t('showTitle'),
      onclick: () => call('POST', `${base}/focus`).catch(showError) }, t('show'));
    // the buttons wrap as one group, right-aligned, when the card gets narrow
    const actions = el('span', { class: 'actions' }, v.frontChip, v.show);
    const head = el('div', { class: 'card-head' },
      el('span', { class: 'name', title: isMain ? t('mainBrowser') : name }, isMain ? t('mainBrowser') : name), v.chip,
      actions);
    if (isMain && context.onDemand) {
      actions.append(el('button', { class: 'danger', title: t('stopTitle'),
        onclick: () => confirm(t('stopConfirm'))
          && call('POST', `${base}/stop`).catch(showError) }, t('stop')));
    }
    if (!isMain) {
      actions.append(el('button', { class: 'danger', title: t('deleteTitle'),
        onclick: () => confirm(t('deleteConfirm', name))
          && call('DELETE', base).catch(showError) }, t('delete')));
    }
    v.meta = el('div', { class: 'meta' });
    v.img = el('img', { class: 'thumb', alt: '' });
    v.title = el('div', { class: 'cur-title' });
    const shot = el('div', { class: 'shot', title: t('shotTitle') }, v.img, v.title);
    shot.onclick = () => {
      const current = browsers.get(name)?.current;
      if (current) focusTab(name, current);
    };
    v.list = el('ul', { class: 'tabs' });
    v.tabview = el('div', { class: 'tabview' }, shot, el('div', { class: 'tabs-box' }, v.list));
    v.empty = el('div', { class: 'empty' }, t('noTabs'));
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
    v.chip.textContent = t('tabs', n);
    // the browser the desktop (and the Selkies stream) shows in front
    v.card.classList.toggle('front', !!context.front);
    v.frontChip.hidden = !context.front;
    v.show.hidden = !!context.front;
    v.meta.textContent = context.main
      ? t('mainMeta')
      : t('contextMeta', context.client, new Date(context.createdAt).toLocaleTimeString(locale()), context.pid ?? '—');
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
      const title = tab.title || t('untitled');
      if (button.textContent !== title) button.textContent = title;
      button.title = tab.url;
      button.classList.toggle('current', tab.id === context.current);
    }
    const current = context.tabs.get(context.current);
    v.title.textContent = current ? current.title || t('untitled') : '';
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
      serverSettings = op.settings ?? {};
      browsers.clear();
      views.clear();
      body.replaceChildren();
      for (const b of op.browsers) browsers.set(b.name, { ...b, tabs: new Map(b.tabs.map((t) => [t.id, t])) });
      return [...browsers.keys()];
    }
    if (op.t === 'settings') {
      serverSettings = op.settings;
      return [];
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
      renderSummary();
      renderRaiseNew();
    };
    ws.onclose = () => {
      ws = null;
      showError(t('reconnecting', retry / 1000));
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

  setLang(lang, false);

  // Running at all means the gateway let this user in: it serves this script
  // uncached, behind the same master password as the console (a view-only
  // login gets 401 and the Selkies page stays untouched).
  document.body.appendChild(host);
})();
