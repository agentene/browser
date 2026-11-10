// auth-server/ui.js — the login and CDP API key controls of the CDP console
// (cdp-gateway/dashboard.html), its sidebar on the Selkies page
// (cdp-gateway/panel.js) and the account page (page.html).
//
// Served by the auth service next to its API (…/__auth/ui.js), so it only
// loads where the built-in login is on (ENABLE_AUTH=true). A page loads it
// and calls
//   AgenteneAuth.mount({ menu, root, onError })
// menu    the element its rows go into (the console's settings menu): the
//         login (Change…), the CDP API key (Change…), Log out
// root    where its dialogs go: document.body, or the panel's shadow root
// onError shows an error (null clears it)
// and AgenteneAuth.setLang('en' | 'zh') whenever the page's language changes.
// The rows use the page's .setting / .setting-hint / button styles; the
// dialogs bring their own, on the page's color variables.
(() => {
  'use strict';
  if (window.AgenteneAuth) return;

  const BASE = new URL('./', document.currentScript.src).href;

  const STRINGS = {
    en: {
      access: 'Access',
      login: 'Login',
      loginOn: (user) => `Signed in as ${user}`,
      loginOff: 'Off: anyone who can reach this page can use it',
      apiKey: 'CDP API key',
      apiKeyOn: 'Set: CDP clients must send it',
      apiKeyOff: 'Not set: CDP clients connect without one',
      change: 'Change…',
      logout: 'Log out',
      logoutHint: 'End this browser\'s session',
      loginTitle: 'Change login',
      loginLead: 'The administrator login of the remote desktop and the CDP console. Saving signs every other session out.',
      loginLeadOff: 'The web UI has no login. Set one up to protect the remote desktop and the CDP console.',
      currentPassword: 'Current password',
      username: 'User name',
      newPassword: 'New password',
      confirm: 'Repeat the new password',
      loginEmptyHint: 'Leave the user name and both password fields empty to turn the login off.',
      mismatch: 'The two passwords do not match.',
      turnOffConfirm: 'Turn the login off? Anyone who can reach the web UI or the console can then use them.',
      apiKeyTitle: 'CDP API key',
      apiKeyLeadOn: 'An API key is set. It is stored hashed and cannot be shown again; saving replaces it.',
      apiKeyLeadOff: 'No API key is set: CDP clients connect without one.',
      apiKeyPlaceholder: 'empty = no API key',
      generate: 'Generate',
      copy: 'Copy',
      copied: 'Copied',
      apiKeyUsage: 'CDP clients send it as a header, either Authorization: Bearer <key> or X-API-Key: <key>. Playwright: chromium.connectOverCDP(url, { headers: { Authorization: \'Bearer <key>\' } }).',
      apiKeyEmptyHint: 'Leave it empty to let CDP clients connect without a key.',
      removeConfirm: 'Remove the API key? CDP clients can then connect without one.',
      cancel: 'Cancel',
      save: 'Save',
      saved: 'Saved',
    },
    zh: {
      access: '访问控制',
      login: '登录',
      loginOn: (user) => `已登录：${user}`,
      loginOff: '未启用：任何能访问此页面的人都可以使用',
      apiKey: 'CDP API Key',
      apiKeyOn: '已设置：CDP 客户端必须携带',
      apiKeyOff: '未设置：CDP 客户端无需携带即可连接',
      change: '修改…',
      logout: '退出登录',
      logoutHint: '结束此浏览器的登录会话',
      loginTitle: '修改登录账号',
      loginLead: '远程桌面和 CDP 控制台的管理员账号。保存后，其他所有会话都需要重新登录。',
      loginLeadOff: 'Web 界面当前未启用登录。设置账号以保护远程桌面和 CDP 控制台。',
      currentPassword: '当前密码',
      username: '用户名',
      newPassword: '新密码',
      confirm: '再次输入新密码',
      loginEmptyHint: '用户名和两个密码框都留空即关闭登录。',
      mismatch: '两次输入的密码不一致。',
      turnOffConfirm: '关闭登录？之后任何能访问 Web 界面或控制台的人都可以使用它们。',
      apiKeyTitle: 'CDP API Key',
      apiKeyLeadOn: '已设置 API Key。它以哈希形式保存，无法再次查看；保存会替换它。',
      apiKeyLeadOff: '未设置 API Key：CDP 客户端无需携带即可连接。',
      apiKeyPlaceholder: '留空 = 不需要 API Key',
      generate: '随机生成',
      copy: '复制',
      copied: '已复制',
      apiKeyUsage: 'CDP 客户端通过请求头携带：Authorization: Bearer <key> 或 X-API-Key: <key>。Playwright 示例：chromium.connectOverCDP(url, { headers: { Authorization: \'Bearer <key>\' } })。',
      apiKeyEmptyHint: '留空则 CDP 客户端无需 API Key 即可连接。',
      removeConfirm: '移除 API Key？之后 CDP 客户端无需携带即可连接。',
      cancel: '取消',
      save: '保存',
      saved: '已保存',
    },
  };
  const LANG_KEY = 'cdp-console-lang';
  let lang = '';
  try { lang = localStorage.getItem(LANG_KEY) || ''; } catch { /* storage blocked */ }
  if (!STRINGS[lang]) lang = navigator.languages?.find((l) => /^(zh|en)\b/i.test(l))?.slice(0, 2).toLowerCase() || 'en';
  function t(key, ...args) {
    const s = STRINGS[lang][key];
    return typeof s === 'function' ? s(...args) : s;
  }

  // the auth service's error messages, in Chinese (prefix match)
  const ZH_ERRORS = [
    ['wrong user name or password', '用户名或密码错误'],
    ['the current password is wrong', '当前密码错误'],
    ['too many failed attempts', '失败次数过多，请稍后再试'],
    ['the password needs at least 8 characters', '密码至少需要 8 个字符'],
    ['the user name is empty', '用户名不能为空'],
    ['the user name may not contain', '用户名不能包含空格、冒号或控制字符'],
    ['the API key needs at least 8 characters', 'API Key 至少需要 8 个字符'],
    ['the API key may only contain', 'API Key 只能包含可见 ASCII 字符（不含空格）'],
    ['already set up', '已经设置过了，请刷新页面'],
    ['sign in first', '请先登录'],
  ];
  const localize = (msg) => (lang === 'zh' ? ZH_ERRORS.find(([en]) => String(msg).startsWith(en))?.[1] : null) || msg;

  async function call(method, name, body) {
    const res = await fetch(`${BASE}api/${name}`, {
      method,
      cache: 'no-store',
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(localize(data.error || `HTTP ${res.status}`));
    return data;
  }

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (v !== false && v !== undefined) node.setAttribute(k, v === true ? '' : v);
    }
    node.append(...children);
    return node;
  }

  const CSS = `
    .aa-dialog {
      width:min(420px, calc(100vw - 32px)); max-height:calc(100vh - 32px); padding:0; overflow:auto;
      border:1px solid var(--line, #e3e6eb); border-radius:12px; background:var(--card, #fff); color:var(--text, #1d2330);
      box-shadow:0 16px 48px rgba(0,0,0,.35); font:14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    .aa-dialog::backdrop { background:rgba(10,12,16,.55); }
    .aa-dialog form { display:grid; gap:12px; padding:20px 20px 16px; margin:0; }
    .aa-dialog h3 { margin:0; font-size:16px; }
    .aa-dialog p { margin:0; color:var(--muted, #667085); font-size:12px; }
    .aa-dialog label { display:grid; gap:4px; font-size:13px; font-weight:500; }
    .aa-dialog input {
      font:inherit; font-weight:400; padding:7px 9px; border-radius:7px; border:1px solid var(--line, #e3e6eb);
      background:var(--bg, #fff); color:var(--text, #1d2330); width:100%; box-sizing:border-box; min-width:0;
    }
    .aa-dialog input:focus { outline:2px solid color-mix(in srgb, var(--accent, #2f6fde) 50%, transparent); border-color:var(--accent, #2f6fde); }
    .aa-dialog input.aa-key { font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:12px; }
    .aa-dialog .aa-keyrow { display:flex; gap:6px; }
    .aa-dialog .aa-error { color:var(--danger, #c43d3d); font-size:13px; }
    .aa-dialog .aa-error:empty { display:none; }
    .aa-dialog code { font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:11px; }
    .aa-dialog .aa-buttons { display:flex; justify-content:flex-end; gap:8px; margin-top:4px; }
    .aa-dialog button {
      font:inherit; font-size:13px; border-radius:6px; padding:5px 12px; cursor:pointer; white-space:nowrap;
      border:1px solid var(--line, #e3e6eb); background:transparent; color:var(--text, #1d2330);
    }
    .aa-dialog button:hover { border-color:var(--accent, #2f6fde); color:var(--accent, #2f6fde); }
    .aa-dialog button.aa-primary { background:var(--accent, #2f6fde); border-color:var(--accent, #2f6fde); color:#fff; }
    .aa-dialog button.aa-primary:hover { color:#fff; filter:brightness(1.1); }
    .aa-dialog button:disabled { opacity:.6; cursor:default; }
    .aa-title { margin:0; font-weight:600; font-size:12px; color:var(--muted, #667085); text-transform:uppercase; letter-spacing:.04em; }
    .aa-setting button { flex:none; }
  `;

  let mounted = null; // { rows..., root, onError }
  let state = null;

  function render() {
    if (!mounted || !state) return;
    const m = mounted;
    const on = !!(state.authorized && state.setUp);
    for (const row of [m.title, m.loginRow, m.keyRow, m.logoutRow]) row.hidden = !on;
    if (!on) return;
    m.title.textContent = t('access');
    m.loginLabel.textContent = t('login');
    m.loginHint.textContent = state.login ? t('loginOn', state.username) : t('loginOff');
    m.keyRow.hidden = !state.cdp;
    m.keyLabel.textContent = t('apiKey');
    m.keyHint.textContent = state.apiKey ? t('apiKeyOn') : t('apiKeyOff');
    m.logoutRow.hidden = !state.login;
    m.logoutLabel.textContent = t('logout');
    m.logoutHint.textContent = t('logoutHint');
    for (const b of [m.loginBtn, m.keyBtn]) b.textContent = t('change');
    m.logoutBtn.textContent = t('logout');
  }

  async function refresh() {
    try {
      state = await call('GET', 'state');
    } catch {
      state = null;
    }
    render();
    return state;
  }

  // A modal dialog with a form; submit(form, error) resolves true to close it.
  function openDialog(build, submit) {
    const error = el('div', { class: 'aa-error' });
    const form = el('form', { method: 'dialog' }, ...build(), error);
    const dialog = el('dialog', { class: 'aa-dialog' }, form);
    const close = () => {
      dialog.close();
      dialog.remove();
    };
    form.append(el('div', { class: 'aa-buttons' },
      el('button', { type: 'button', onclick: close }, t('cancel')),
      el('button', { type: 'submit', class: 'aa-primary' }, t('save'))));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.textContent = '';
      const buttons = form.querySelectorAll('button');
      buttons.forEach((b) => { b.disabled = true; });
      try {
        if (await submit(form, error)) {
          close();
          mounted.onError?.(null);
          await refresh();
        }
      } catch (err) {
        error.textContent = err.message;
      } finally {
        buttons.forEach((b) => { b.disabled = false; });
      }
    });
    // Escape cancels the dialog only, not what the page binds it to (the
    // panel closes itself on Escape)
    dialog.addEventListener('keydown', (e) => { if (e.key === 'Escape') e.stopPropagation(); });
    dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
    mounted.root.append(dialog);
    dialog.showModal();
    dialog.querySelector('input')?.focus();
  }

  function field(label, attrs) {
    return el('label', {}, el('span', {}, label), el('input', attrs));
  }

  function openLogin() {
    const loginOn = !!state?.login;
    openDialog(() => [
      el('h3', {}, t('loginTitle')),
      el('p', {}, loginOn ? t('loginLead') : t('loginLeadOff')),
      loginOn ? field(t('currentPassword'), { name: 'current', type: 'password', autocomplete: 'current-password', required: true }) : '',
      field(t('username'), { name: 'username', autocomplete: 'username', maxlength: '64', value: state?.username || '' }),
      field(t('newPassword'), { name: 'password', type: 'password', autocomplete: 'new-password' }),
      field(t('confirm'), { name: 'confirm', type: 'password', autocomplete: 'new-password' }),
      loginOn ? el('p', {}, t('loginEmptyHint')) : '',
    ], async (form) => {
      const f = new FormData(form);
      const username = String(f.get('username') || '').trim();
      const password = String(f.get('password') || '');
      if (password !== String(f.get('confirm') || '')) throw new Error(t('mismatch'));
      const off = !username && !password;
      if (off && !loginOn) return true; // nothing to turn off
      if (off && !confirm(t('turnOffConfirm'))) return false;
      await call('PUT', 'credentials', { currentPassword: String(f.get('current') || ''), username, password });
      return true;
    });
  }

  function randomKey() {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false; // not a secure context: the key stays selected for Ctrl+C
    }
  }

  function openApiKey() {
    const isSet = !!state?.apiKey;
    let input;
    openDialog(() => {
      input = el('input', { name: 'apiKey', class: 'aa-key', autocomplete: 'off', spellcheck: 'false', placeholder: t('apiKeyPlaceholder') });
      const copy = el('button', { type: 'button', onclick: async () => {
        input.select();
        if (input.value && await copyText(input.value)) {
          copy.textContent = t('copied');
          setTimeout(() => { copy.textContent = t('copy'); }, 1500);
        }
      } }, t('copy'));
      return [
        el('h3', {}, t('apiKeyTitle')),
        el('p', {}, isSet ? t('apiKeyLeadOn') : t('apiKeyLeadOff')),
        el('div', { class: 'aa-keyrow' }, input,
          el('button', { type: 'button', onclick: () => { input.value = randomKey(); input.select(); } }, t('generate')),
          copy),
        el('p', {}, t('apiKeyUsage')),
        el('p', {}, t('apiKeyEmptyHint')),
      ];
    }, async () => {
      const apiKey = input.value.trim();
      if (!apiKey && !isSet) return true;
      if (!apiKey && !confirm(t('removeConfirm'))) return false;
      await call('PUT', 'apikey', { apiKey });
      return true;
    });
  }

  async function logout() {
    try {
      await call('POST', 'logout', {});
    } finally {
      location.reload(); // the login form shows in place
    }
  }

  function mount({ menu, root, onError }) {
    if (mounted) return;
    const row = (label, hint, button) => el('div', { class: 'setting aa-setting', hidden: true },
      el('span', {}, label, hint), button);
    const m = {
      root, onError,
      title: el('p', { class: 'aa-title', hidden: true }),
      loginLabel: el('span'), loginHint: el('span', { class: 'setting-hint' }),
      keyLabel: el('span'), keyHint: el('span', { class: 'setting-hint' }),
      logoutLabel: el('span'), logoutHint: el('span', { class: 'setting-hint' }),
      loginBtn: el('button', { type: 'button', onclick: openLogin }),
      keyBtn: el('button', { type: 'button', onclick: openApiKey }),
      logoutBtn: el('button', { type: 'button', onclick: logout }),
    };
    m.loginRow = row(m.loginLabel, m.loginHint, m.loginBtn);
    m.keyRow = row(m.keyLabel, m.keyHint, m.keyBtn);
    m.logoutRow = row(m.logoutLabel, m.logoutHint, m.logoutBtn);
    root.append(el('style', {}, CSS));
    menu.append(m.title, m.loginRow, m.keyRow, m.logoutRow);
    mounted = m;
    refresh();
  }

  function setLang(next) {
    if (!STRINGS[next]) return;
    lang = next;
    render();
  }

  window.AgenteneAuth = { mount, setLang, refresh };
})();
