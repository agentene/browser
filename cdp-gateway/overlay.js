// cdp-gateway/overlay.js — the CDP clients' input drawn over the Selkies
// stream: where an AI agent's pointer is, its clicks, wheel, the keys it
// presses and the text it types. CDP input goes straight into the pages and
// never moves the desktop's pointer, so the stream alone shows pages react
// with nothing that pointed or typed.
//
// nginx injects it into the Selkies entry page next to panel.js
// (CDP_INPUT_OVERLAY, entrypoint/lib/nginx.sh); same origin and auth as the
// sidebar: nginx checks the built-in login before serving this script.
// The gateway streams the input over cdp-console/overlay
// (cdp-gateway/src/input-overlay.mjs — the op format is documented there)
// while this page is visible and the viewer has the overlay on (the
// sidebar's settings, remembered per browser; window.AgenteneInputOverlay).
// Nothing here takes input: the layer is pointer-events:none, under the
// sidebar.
(() => {
  'use strict';
  if (window.AgenteneInputOverlay) return;

  const WS = new URL('cdp-console/overlay', document.baseURI);
  WS.protocol = WS.protocol === 'https:' ? 'wss:' : 'ws:';
  const ON_KEY = 'cdp-input-overlay'; // '0' = the viewer turned it off
  const LANG_KEY = 'cdp-console-lang'; // the sidebar's language
  // The input arrives before the frames that show its effect: hold each op
  // back about the stream's latency so pointer and picture move together.
  const DELAY_MS = 120;
  const IDLE_MS = 2000; // a pointer this long without input fades
  const LINE_MS = 4000; // how long a line of keys / text stays
  const JOIN_MS = 1500; // text this soon after a client's last text joins its line
  const MAX_LINES = 4;
  const COLORS = ['#7c5cff', '#0ea5e9', '#f43f7a', '#10b981', '#f59e0b', '#ef5a3c'];
  const VIDEO_IDS = ['videoStream', 'videoCanvas', 'stream', 'videoWorkerCanvas'];
  const MAX_SEGMENTS = 14; // key caps / text runs one line keeps
  const MAX_TEXT = 120; // characters one text run shows (its newest)

  const STRINGS = {
    en: {
      right: 'Right click',
      middle: 'Middle click',
      double: 'Double click',
      typed: (n) => `typed ${n} character${n === 1 ? '' : 's'}`,
      // where input goes that the stream does not show: ctx is the browser
      // ('' when its window is the one shown), tab the tab's title, quoted (quote)
      browser: (b) => b,
      quote: (tab, host) => `“${tab}”${host ? ` (${host})` : ''}`,
      off: {
        background: (c, { ctx, tab }) => `AI #${c} is working in a background tab${ctx ? ` of ${ctx === 'main' ? 'the main browser' : ctx}` : ''}${tab ? `, ${tab}` : ''}`,
        headless: (c, { ctx, tab }) => `AI #${c} is working in a headless tab of ${ctx}${tab ? `, ${tab}` : ''}`,
      },
      // a key card's label when there is no tab title to show
      where: { background: 'background tab', headless: 'headless' },
    },
    zh: {
      right: '右键',
      middle: '中键',
      double: '双击',
      typed: (n) => `输入了 ${n} 个字符`,
      browser: (b) => (b === 'main' ? '主浏览器' : b),
      quote: (tab, host) => `「${tab}」${host ? `(${host})` : ''}`,
      off: {
        background: (c, { ctx, tab }) => `AI #${c} 正在后台的 ${ctx ? `${ctx} ` : ''}标签页${tab} 中操作`,
        headless: (c, { ctx, tab }) => `AI #${c} 正在无界面的 ${ctx} 标签页${tab} 中操作`,
      },
      where: { background: '后台标签页', headless: '无界面' },
    },
  };
  const read = (key) => {
    try { return localStorage.getItem(key); } catch { return null; } // storage blocked
  };
  let lang = read(LANG_KEY) || '';
  if (!STRINGS[lang]) lang = navigator.languages?.find((l) => /^(zh|en)\b/i.test(l))?.slice(0, 2).toLowerCase() || 'en';
  let enabled = read(ON_KEY) !== '0';

  // --- the layer ------------------------------------------------------------
  const host = document.createElement('div');
  host.id = 'cdp-input-overlay';
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9999;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .stage { position:absolute; overflow:hidden; color:#fff;
               font:500 13px/1.4 Inter, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Noto Sans CJK SC", sans-serif;
               -webkit-font-smoothing:antialiased; }
      .glass { background:rgba(18,19,24,.74); backdrop-filter:blur(14px) saturate(160%);
               -webkit-backdrop-filter:blur(14px) saturate(160%);
               border:1px solid rgba(255,255,255,.10);
               box-shadow:0 10px 30px rgba(0,0,0,.35), 0 1px 0 rgba(255,255,255,.06) inset; }

      /* the pointer: a rounded arrow, its tip at the element's origin */
      .ptr { position:absolute; left:0; top:0; width:0; height:0; will-change:transform;
             transition:transform 90ms linear, opacity .5s; }
      .ptr .halo { position:absolute; left:-22px; top:-22px; width:44px; height:44px; border-radius:50%;
                   background:radial-gradient(circle, color-mix(in srgb, var(--c) 45%, transparent) 0%, transparent 70%);
                   transition:opacity .4s, transform .15s; }
      .ptr svg { position:absolute; left:-4.2px; top:-4.2px; overflow:visible; transform-origin:4.2px 4.2px;
                 filter:drop-shadow(0 2px 3px rgba(0,0,0,.35)) drop-shadow(0 0 1px rgba(0,0,0,.4));
                 transition:transform .12s cubic-bezier(.3,.7,.4,1.4); }
      .ptr.down svg { transform:scale(.84); }
      .ptr.down .halo { transform:scale(1.35); }
      .ptr .name { position:absolute; left:22px; top:26px; display:flex; align-items:center; gap:4px;
                   padding:2px 8px 2px 6px; border-radius:999px; white-space:nowrap;
                   font-size:11.5px; font-weight:650; letter-spacing:.01em;
                   background:linear-gradient(135deg, color-mix(in srgb, var(--c) 82%, #fff), var(--c));
                   box-shadow:0 2px 8px color-mix(in srgb, var(--c) 45%, transparent), 0 0 0 1.5px rgba(255,255,255,.9);
                   transition:opacity .4s, transform .4s; transform-origin:0 0; }
      .ptr .name svg { position:static; filter:none; transform:none; width:10px; height:10px; }
      .ptr.idle { opacity:.5; }
      .ptr.idle .halo { opacity:0; }
      .ptr.idle .name { opacity:0; transform:scale(.8); }
      .ptr.approx .body { stroke-dasharray:3 2.2; }

      /* clicks: a soft fill and a ring spreading from the point */
      .click { position:absolute; width:0; height:0; }
      .click i { position:absolute; left:-24px; top:-24px; width:48px; height:48px; border-radius:50%; }
      .click .fill { background:radial-gradient(circle, color-mix(in srgb, var(--c) 55%, transparent) 0%, transparent 70%);
                     animation:fill .55s ease-out forwards; }
      .click .ring { border:2.5px solid var(--c); box-shadow:0 0 12px color-mix(in srgb, var(--c) 60%, transparent);
                     animation:ring .6s cubic-bezier(.2,.6,.3,1) forwards; }
      .click .ring.late { animation-delay:.14s; opacity:0; }
      .click.right .ring { border-style:dashed; }
      @keyframes fill { from { transform:scale(.2); opacity:1; } to { transform:scale(1); opacity:0; } }
      @keyframes ring { from { transform:scale(.25); opacity:1; } to { transform:scale(1.15); opacity:0; } }
      .click .label { position:absolute; left:22px; top:-34px; padding:3px 9px; border-radius:999px; white-space:nowrap;
                      font-size:11.5px; font-weight:650; color:#fff; background:var(--c);
                      box-shadow:0 4px 12px rgba(0,0,0,.3); animation:pop 1.1s ease-out forwards; }
      @keyframes pop { 0% { transform:translateY(4px) scale(.9); opacity:0; } 15%, 70% { transform:none; opacity:1; } to { opacity:0; } }

      /* the wheel: a chip with the direction it scrolls */
      .wheel { position:absolute; width:0; height:0; animation:pop .9s ease-out forwards; }
      .wheel .chip { position:absolute; left:-44px; top:-6px; display:flex; align-items:center; justify-content:center;
                     width:28px; height:28px; border-radius:50%; }
      .wheel svg { width:16px; height:16px; color:var(--c); animation:nudge .45s ease-in-out 2; }
      @keyframes nudge { 50% { transform:translateY(3px); } }

      /* keys and text: one card per burst, bottom left */
      .lines { position:absolute; left:18px; bottom:18px; display:flex; flex-direction:column; gap:8px;
               align-items:flex-start; max-width:min(72%, 760px); }
      .line { display:flex; gap:10px; align-items:center; padding:8px 12px 8px 8px; border-radius:14px;
              animation:enter .22s cubic-bezier(.2,.8,.3,1.15); transition:opacity .45s, transform .45s; }
      .line.gone { opacity:0; transform:translateY(6px) scale(.98); }
      @keyframes enter { from { opacity:0; transform:translateY(10px) scale(.96); } }
      .who { flex:none; display:flex; align-items:center; gap:5px; align-self:flex-start; padding:3px 8px 3px 5px;
             border-radius:999px; font-size:11px; font-weight:700; letter-spacing:.02em;
             color:color-mix(in srgb, var(--c) 30%, #fff); background:color-mix(in srgb, var(--c) 26%, transparent);
             box-shadow:inset 0 0 0 1px color-mix(in srgb, var(--c) 55%, transparent); margin-top:1px; }
      .who svg { width:11px; height:11px; color:var(--c); }
      .segs { display:flex; flex-wrap:wrap; align-items:center; gap:6px 12px; min-width:0; }
      .combo { display:inline-flex; align-items:center; gap:3px; animation:cap .18s cubic-bezier(.3,.7,.4,1.5); }
      .combo .plus { color:rgba(255,255,255,.4); font-size:10px; font-weight:700; margin:0 1px; }
      kbd { display:inline-flex; align-items:center; justify-content:center; gap:3px; min-width:26px; height:26px;
            box-sizing:border-box; padding:0 8px; border-radius:7px;
            font:650 12.5px/1 Inter, system-ui, -apple-system, "Segoe UI", sans-serif; color:#1c1d22;
            background:linear-gradient(#ffffff, #e7e8ec); border:1px solid #c7cad2;
            box-shadow:0 2px 0 #a9adb8, 0 3px 6px rgba(0,0,0,.28); }
      kbd .g { font-size:13px; color:#55575f; }
      .times { margin-left:4px; font-size:12px; font-weight:700; color:color-mix(in srgb, var(--c) 35%, #fff);
               font-variant-numeric:tabular-nums; animation:cap .18s cubic-bezier(.3,.7,.4,1.5); }
      @keyframes cap { from { transform:scale(.7); opacity:0; } }
      .text { font-size:14.5px; font-weight:500; color:#f4f4f6; white-space:pre-wrap; word-break:break-word; }
      .text.text-last::after { content:''; display:inline-block; width:2px; height:1.05em; margin-left:2px;
                               vertical-align:-.15em; border-radius:1px; background:var(--c); animation:blink 1s steps(1) infinite; }
      @keyframes blink { 50% { opacity:0; } }
      .secret { display:inline-flex; align-items:center; gap:6px; font-size:13px; color:rgba(255,255,255,.75); }
      .secret .dots { letter-spacing:2px; color:#fff; }
      .secret svg { width:13px; height:13px; color:var(--c); }
      .muted { font-size:13px; color:rgba(255,255,255,.75); }

      /* top center: the window's own buttons sit in the corners */
      .badges { position:absolute; left:50%; top:14px; transform:translateX(-50%); display:flex; flex-direction:column;
                gap:6px; align-items:center; }
      .badge { display:flex; align-items:center; gap:8px; padding:6px 14px 6px 10px; border-radius:999px; font-size:12.5px;
               white-space:nowrap; animation:enter .22s ease-out; }
      .badge .dot { width:8px; height:8px; border-radius:50%; background:var(--c);
                    box-shadow:0 0 0 0 color-mix(in srgb, var(--c) 60%, transparent); animation:pulse 1.6s ease-out infinite; }
      @keyframes pulse { to { box-shadow:0 0 0 8px transparent; } }

      @media (prefers-reduced-motion: reduce) {
        .ptr { transition:opacity .5s; }
        .line, .combo, .times, .badge, .badge .dot, .wheel svg, .text.text-last::after { animation:none; }
      }
    </style>
    <div class="stage"><div class="badges"></div><div class="lines"></div></div>`;
  const stage = root.querySelector('.stage');
  const lines = root.querySelector('.lines');
  const badges = root.querySelector('.badges');
  const t = () => STRINGS[lang];
  const color = (c) => COLORS[(c - 1) % COLORS.length];
  const SPARK = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 0c.5 3.9 2.6 6.9 8 8-5.4 1.1-7.5 4.1-8 8-.5-3.9-2.6-6.9-8-8 5.4-1.1 7.5-4.1 8-8z"/></svg>';
  const LOCK = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M4.5 7V5a3.5 3.5 0 0 1 7 0v2h.5A1.5 1.5 0 0 1 13.5 8.5v5A1.5 1.5 0 0 1 12 15H4a1.5 1.5 0 0 1-1.5-1.5v-5A1.5 1.5 0 0 1 4 7h.5zm1.5 0h4V5a2 2 0 0 0-4 0v2z"/></svg>';
  const el = (tag, cls, html) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (html !== undefined) node.innerHTML = html;
    return node;
  };

  // --- where the stream is drawn --------------------------------------------
  // The Selkies element showing the desktop and the box its picture fills
  // in it (object-fit: contain letterboxes it).
  function streamBox() {
    let best = null;
    for (const id of VIDEO_IDS) {
      const node = document.getElementById(id);
      if (!node) continue;
      const r = node.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const cs = getComputedStyle(node);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
      if (!best || r.width * r.height > best.r.width * best.r.height) best = { node, r, fit: cs.objectFit };
    }
    if (!best) return null;
    const { node, r, fit } = best;
    const iw = node.videoWidth || node.width || 0;
    const ih = node.videoHeight || node.height || 0;
    if (fit === 'fill' || !iw || !ih) return { x: r.left, y: r.top, w: r.width, h: r.height, iw: iw || r.width, ih: ih || r.height };
    const s = Math.min(r.width / iw, r.height / ih);
    const w = iw * s;
    const h = ih * s;
    return { x: r.left + (r.width - w) / 2, y: r.top + (r.height - h) / 2, w, h, iw, ih };
  }

  let screen = null; // the desktop's size (DIP), from the gateway
  let box = null;
  function layout() {
    box = streamBox();
    if (!box) {
      stage.style.display = 'none';
      return;
    }
    Object.assign(stage.style, { display: '', left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` });
    for (const p of pointers.values()) place(p);
  }
  // desktop DIP -> stage pixels
  function toStage(x, y) {
    const w = screen?.w || box.iw;
    const h = screen?.h || box.ih;
    return { x: (x / w) * box.w, y: (y / h) * box.h };
  }

  // --- pointers -------------------------------------------------------------
  const pointers = new Map(); // c -> { el, x, y, idle }
  // a rounded arrow, tip at (3.6, 3.6) of its 26-unit box, drawn 30 px
  const ARROW = (c) => `<svg width="30" height="30" viewBox="0 0 26 26">
    <defs><linearGradient id="g${c}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" style="stop-color:color-mix(in srgb, ${color(c)} 70%, #fff)"/>
      <stop offset="1" stop-color="${color(c)}"/></linearGradient></defs>
    <path class="body" d="M5.1 3.2 L21 11.2 C22 11.7 21.9 13.1 20.8 13.4 L14.2 15.4 C13.8 15.5 13.5 15.8 13.4 16.2 L11.2 22.7 C10.9 23.8 9.4 23.8 9.1 22.8 L3.6 4.8 C3.3 3.7 4.2 2.8 5.1 3.2 Z"
      fill="url(#g${c})" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/></svg>`;

  function pointer(c) {
    let p = pointers.get(c);
    if (p) return p;
    const node = el('div', 'ptr', `<div class="halo"></div>${ARROW(c)}<span class="name">${SPARK}AI #${c}</span>`);
    node.style.setProperty('--c', color(c));
    stage.append(node);
    p = { el: node, x: 0, y: 0, idle: 0, placed: false };
    pointers.set(c, p);
    return p;
  }

  function place(p) {
    if (!box) return;
    const at = toStage(p.x, p.y);
    // the first placement jumps; later ones glide between the batched moves
    if (!p.placed) p.el.style.transition = 'opacity .5s';
    p.el.style.transform = `translate(${at.x}px, ${at.y}px)`;
    if (!p.placed) {
      p.placed = true;
      void p.el.offsetWidth;
      p.el.style.transition = '';
    }
  }

  function moveTo(op) {
    const p = pointer(op.c);
    p.x = op.x;
    p.y = op.y;
    p.el.classList.toggle('approx', !!op.approx);
    p.el.classList.remove('idle');
    clearTimeout(p.idle);
    p.idle = setTimeout(() => p.el.classList.add('idle'), IDLE_MS);
    place(p);
    badge(op.c, null);
    return p;
  }

  function mark(op, cls, html) {
    if (!box) return;
    const at = toStage(op.x, op.y);
    const node = el('div', cls, html);
    node.style.cssText = `left:${at.x}px;top:${at.y}px;--c:${color(op.c)}`;
    stage.append(node);
    setTimeout(() => node.remove(), 1400); // the longest of its animations
  }

  const CHEVRON = {
    down: 'M4 6l4 4 4-4', up: 'M4 10l4-4 4 4', right: 'M6 4l4 4-4 4', left: 'M10 4l-4 4 4 4',
  };
  function wheel(op) {
    const dir = Math.abs(op.dy) >= Math.abs(op.dx) ? (op.dy > 0 ? 'down' : 'up') : (op.dx > 0 ? 'right' : 'left');
    const svg = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"${dir === 'up' || dir === 'down' ? '' : ' style="animation-name:none"'}><path d="${CHEVRON[dir]}"/></svg>`;
    mark(op, 'wheel', `<div class="chip glass">${svg}</div>`);
  }

  // --- key / text lines -----------------------------------------------------
  // One card per burst of one client: key caps and typed text in the order
  // they came; a card fades LINE_MS after its last addition. Keys going to
  // a page the stream does not show name its tab: 'AI #2 (context-1 › Inbox)'.
  const GLYPHS = {
    Enter: '↵', Backspace: '⌫', Tab: '⇥', Delete: '⌦', Shift: '⇧', Esc: '⎋', Space: '␣',
    Home: '⇱', End: '⇲', PageUp: '⇞', PageDown: '⇟',
  };
  const ARROWS = new Set(['←', '→', '↑', '↓']);
  // 'Ctrl+Shift+T' -> ['Ctrl', 'Shift', 'T']; the key itself may be '+'
  function comboParts(combo) {
    const m = /^((?:(?:Ctrl|Alt|Shift|Meta)\+)*)(.+)$/.exec(combo);
    return m ? [...m[1].split('+').filter(Boolean), m[2]] : [combo];
  }
  function cap(name) {
    const k = el('kbd');
    const g = GLYPHS[name];
    if (ARROWS.has(name)) k.textContent = name;
    else if (g) {
      k.append(el('span', 'g'), document.createTextNode(name));
      k.firstChild.textContent = g;
    } else k.textContent = name;
    return k;
  }

  // 'context-1 › Pull requests', 'Inbox — mail.example' (two tabs of that
  // title); titles carry '·' and '|' themselves
  function cardWhere(op, why) {
    const ctx = browserShown(op, why) && t().browser(op.b);
    const tab = op.tab ? `${op.tab}${op.host ? ` — ${op.host}` : ''}` : '';
    return [ctx, tab].filter(Boolean).join(' › ') || t().where[why] || t().where.background;
  }

  // The browser's name ('main', 'context-1') when its window is not the one
  // shown; a background tab of the window shown needs none
  function browserShown(op, why) {
    return why === 'background' ? '' : op.b || '';
  }

  let lastLine = null; // { c, where, el, segs, at, timer, last }
  function line(op) {
    const { c } = op;
    const now = Date.now();
    const where = op.away ? cardWhere(op, op.away) : '';
    if (lastLine && lastLine.c === c && lastLine.where === where && now - lastLine.at < JOIN_MS && lastLine.el.isConnected) {
      lastLine.at = now;
      return lastLine;
    }
    const node = el('div', 'line glass', `<span class="who">${SPARK}<span class="who-name"></span></span><span class="segs"></span>`);
    node.querySelector('.who-name').textContent = where ? `AI #${c} (${where})` : `AI #${c}`;
    node.style.setProperty('--c', color(c));
    lines.append(node);
    while (lines.children.length > MAX_LINES) lines.firstElementChild.remove();
    lastLine = { c, where, el: node, segs: node.querySelector('.segs'), at: now, timer: 0, last: null };
    return lastLine;
  }
  function keepLine(l) {
    clearTimeout(l.timer);
    l.el.classList.remove('gone');
    l.timer = setTimeout(() => {
      l.el.classList.add('gone');
      setTimeout(() => l.el.remove(), 600);
    }, LINE_MS);
  }
  function addSeg(l, node, last) {
    l.segs.querySelector('.text-last')?.classList.remove('text-last');
    l.segs.append(node);
    while (l.segs.children.length > MAX_SEGMENTS) l.segs.firstElementChild.remove();
    l.last = last;
  }

  function key(op) {
    const l = line(op);
    // the same press again: count it instead of another cap
    if (l.last?.kind === 'key' && l.last.combo === op.combo && l.last.node.isConnected) {
      l.last.n++;
      let times = l.last.node.querySelector('.times');
      if (!times) l.last.node.append(times = el('span', 'times'));
      times.textContent = `×${l.last.n}`;
      times.style.animation = 'none';
      void times.offsetWidth;
      times.style.animation = '';
      keepLine(l);
      return;
    }
    const node = el('span', 'combo');
    comboParts(op.combo).forEach((part, i) => {
      if (i) node.append(el('span', 'plus', '+'));
      node.append(cap(part));
    });
    addSeg(l, node, { kind: 'key', combo: op.combo, n: 1, node });
    keepLine(l);
  }

  function text(op) {
    const kind = typeof op.s === 'string' ? 'text' : op.masked ? 'masked' : 'count';
    const l = line(op);
    let seg = l.last?.kind === kind && l.last.node.isConnected ? l.last : null;
    if (!seg) {
      const node = kind === 'text' ? el('span', 'text') : kind === 'masked'
        ? el('span', 'secret', `${LOCK}<span class="dots"></span><span class="n"></span>`)
        : el('span', 'muted');
      seg = { kind, node, s: '', n: 0 };
      addSeg(l, node, seg);
    }
    if (kind === 'text') {
      seg.s = (seg.s + op.s).slice(-MAX_TEXT);
      seg.node.textContent = seg.s;
      seg.node.classList.add('text-last');
    } else {
      seg.n += op.n || 0;
      if (kind === 'masked') {
        seg.node.querySelector('.dots').textContent = '•'.repeat(Math.min(seg.n, 12));
        seg.node.querySelector('.n').textContent = `(${seg.n})`;
      } else seg.node.textContent = t().typed(seg.n);
    }
    keepLine(l);
  }

  // --- "working where you cannot see it" badges -----------------------------
  const shownBadges = new Map(); // c -> element
  function badge(c, op) {
    const el = shownBadges.get(c);
    if (!op) {
      if (el) {
        el.remove();
        shownBadges.delete(c);
      }
      return;
    }
    const say = t().off[op.why] || t().off.background;
    const ctx = browserShown(op, op.why) && t().browser(op.b);
    const tab = op.tab ? t().quote(op.tab, op.host) : '';
    const node = el || document.createElement('div');
    node.className = 'badge glass';
    node.style.setProperty('--c', color(c));
    node.replaceChildren(document.createElement('span'), say(c, { ctx, tab }));
    node.firstChild.className = 'dot';
    if (!el) {
      badges.append(node);
      shownBadges.set(c, node);
    }
  }

  function forget(c) {
    const p = pointers.get(c);
    if (p) {
      clearTimeout(p.idle);
      p.el.remove();
      pointers.delete(c);
    }
    badge(c, null);
  }

  // --- ops ------------------------------------------------------------------
  function apply(op) {
    if (op.t === 'screen') {
      screen = { w: op.w, h: op.h };
      layout();
      return;
    }
    if (!box) layout();
    switch (op.t) {
      case 'move':
        moveTo(op);
        break;
      case 'down': {
        moveTo(op).el.classList.add('down');
        const right = op.button === 'right';
        const label = right ? t().right : op.button === 'middle' ? t().middle : op.n === 2 ? t().double : op.n > 2 ? `×${op.n}` : '';
        mark(op, `click${right ? ' right' : ''}`, `<i class="fill"></i><i class="ring"></i>${op.n > 1 ? '<i class="ring late"></i>' : ''}${label ? `<span class="label">${label}</span>` : ''}`);
        break;
      }
      case 'up':
        moveTo(op).el.classList.remove('down');
        break;
      case 'wheel':
        moveTo(op);
        wheel(op);
        break;
      case 'key':
        key(op);
        break;
      case 'text':
        text(op);
        break;
      case 'off': {
        const p = pointers.get(op.c);
        if (p) p.el.classList.add('idle');
        badge(op.c, op);
        break;
      }
      case 'bye':
        forget(op.c);
        break;
      default:
        break;
    }
  }

  // --- the connection -------------------------------------------------------
  let ws = null;
  let retry = 0;
  let retryTimer = 0;
  function connect() {
    if (ws || !enabled || document.hidden) return;
    clearTimeout(retryTimer);
    const sock = new WebSocket(WS);
    ws = sock;
    sock.onopen = () => { retry = 0; };
    sock.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (!Array.isArray(msg.ops)) return;
      setTimeout(() => {
        if (ws === sock) for (const op of msg.ops) apply(op);
      }, DELAY_MS);
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      // a gateway restarting, a lost link: back off up to 30 s
      retryTimer = setTimeout(connect, Math.min(30000, 1000 * 2 ** retry++));
    };
  }
  function disconnect() {
    clearTimeout(retryTimer);
    const sock = ws;
    ws = null;
    sock?.close();
    for (const c of [...pointers.keys(), ...shownBadges.keys()]) forget(c);
    lines.replaceChildren();
    lastLine = null;
  }

  function setEnabled(on) {
    enabled = !!on;
    try { localStorage.setItem(ON_KEY, enabled ? '1' : '0'); } catch { /* storage blocked */ }
    host.style.display = enabled ? '' : 'none';
    if (enabled) connect();
    else disconnect();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) disconnect();
    else connect();
  });
  window.addEventListener('resize', layout);
  // Selkies swaps and resizes its video elements as streams start and the
  // window changes: follow them cheaply
  setInterval(() => { if (ws) layout(); }, 1000);

  // for the sidebar's settings (panel.js)
  window.AgenteneInputOverlay = {
    enabled: () => enabled,
    setEnabled,
    setLang(next) {
      if (STRINGS[next]) lang = next;
    },
  };
  window.dispatchEvent(new Event('agentene-input-overlay'));

  function start() {
    document.body.append(host);
    host.style.display = enabled ? '' : 'none';
    connect();
  }
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
