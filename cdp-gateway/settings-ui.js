// Shared configuration form for the standalone console and the shadow-root panel.
(() => {
  'use strict';
  const LABELS = {
    browser: ['Browser', '浏览器'], contexts: ['Browser capacity', '实例容量'], desktop: ['Desktop', '桌面'], overlay: ['AI input', 'AI 操作展示'], media: ['Audio', '音频'],
    'browser.autostart': ['Start the main browser with the container', '随容器启动主浏览器'],
    'browser.idleTimeout': ['Close after idle minutes (0 = never)', '空闲关闭时间（分钟，0 表示不关闭）'],
    'browser.startUrl': ['Main browser startup page', '主浏览器启动页'],
    'browser.language': ['Browser language', '浏览器语言'],
    'browser.headless': ['Headless browser', '无头浏览器'],
    'browser.gpu': ['Rendering policy', '渲染策略'],
    'contexts.maxRunning': ['Maximum running isolated browsers', '隔离浏览器运行上限'],
    'contexts.overflow': ['When running capacity is full', '运行容量满时'],
    'contexts.maxHibernated': ['Maximum retained hibernated browsers', '休眠浏览器保留上限'],
    'desktop.raiseNewWindows': ['New windows to the front', '新窗口切到最前'],
    'desktop.width': ['Default width (pixels)', '默认宽度（像素）'],
    'desktop.height': ['Default height (pixels)', '默认高度（像素）'],
    'desktop.resize': ['Resize to match the viewer window', '跟随观看窗口调整分辨率'],
    'desktop.resizeLocked': ['Lock the resize preference for viewers', '锁定观看端的分辨率调整偏好'],
    'overlay.mode': ['Input detail shared with viewers', '向观看端展示的操作内容'],
    'media.audioOnStart': ['Start each viewing session with audio', '观看会话开始时开启音频'],
    'media.audioLocked': ['Lock the audio preference for viewers', '锁定观看端的音频偏好'],
    auto: ['Automatic', '自动'], off: ['Off', '关闭'], strict: ['Hardware only', '仅硬件渲染'],
    hibernate: ['Hibernate eligible browsers', '休眠可休眠的浏览器'], reject: ['Reject new browsers', '拒绝新建浏览器'],
    keys: ['Keys and text length', '按键与文本长度'], text: ['Keys and typed text', '按键与输入文本'],
  };
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  window.AgenteneSettings = { mount({ container, getLang, onDirty = () => {} }) {
    let state = null, draft = null, baseRevision = null;
    const dirty = new Set(), rows = new Map(), headings = new Map();
    const root = el('div', 'config-form');
    const result = el('p', 'config-result');
    result.setAttribute('role', 'status');
    const style = el('style');
    style.textContent = `
      .config-form { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr)); gap:24px; min-width:0; }
      .config-section { display:grid; align-content:start; gap:14px; min-width:0; }
      .config-section[hidden] { display:none; }
      .config-section h4 { margin:0; font-size:14px; }
      .config-row { display:grid; gap:5px; min-width:0; font-size:13px; }
      .config-row input:not([type=checkbox]), .config-row select, .config-presets { box-sizing:border-box; width:100%; max-width:360px; min-width:0; padding:7px 9px; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--text); font:inherit; }
      .config-row input[type=checkbox] { justify-self:start; accent-color:var(--accent); }
      .config-row small, .config-result, .config-capability { color:var(--muted); font-size:12px; overflow-wrap:anywhere; }
      .config-row :disabled { opacity:.5; }
      .config-result { grid-column:1 / -1; margin:0; white-space:pre-line; }
      .config-result:empty { display:none; }
      .config-capability { margin:0; }
    `;
    root.append(style, result);
    container.append(root);
    const zh = () => getLang() === 'zh';
    const label = (key) => LABELS[key]?.[zh() ? 1 : 0] || key;
    function optionLabel(field, value, name) {
      const translated = field.optionLabels?.[value]?.[zh() ? 1 : 0];
      if (translated) return translated;
      if (name === 'browser.language') {
        // An older settings file may contain a valid locale outside the common
        // choices. Keep it selected and show its name instead of resetting it.
        try {
          const translatedName = new Intl.DisplayNames([zh() ? 'zh-CN' : 'en'], { type: 'language', fallback: 'none' }).of(value);
          if (translatedName) return translatedName;
        } catch { /* unknown locale */ }
        return zh() ? '已保存的语言' : 'Saved language';
      }
      return label(value);
    }
    const textValue = (v, field, name) => typeof v === 'boolean' ? (v ? (zh() ? '开启' : 'On') : (zh() ? '关闭' : 'Off'))
      : field.type === 'select' ? optionLabel(field, String(v), name) : label(String(v));
    function build() {
      if (!state?.fields || rows.size) return;
      for (const [section, fields] of Object.entries(state.fields)) {
        const group = el('section', 'config-section');
        group.hidden = !state.capabilities.browser && ['browser', 'contexts', 'overlay'].includes(section);
        const heading = el('h4');
        headings.set(section, heading);
        group.append(heading);
        if (section === 'desktop') {
          const presets = el('select', 'config-presets');
          presets.setAttribute('aria-label', zh() ? '分辨率预设' : 'Resolution preset');
          for (const size of ['', '1280x720', '1920x1080', '2560x1440', '3840x2160']) {
            const option = el('option', '', size || (zh() ? '选择分辨率预设…' : 'Choose a resolution…'));
            option.value = size; presets.append(option);
          }
          presets.disabled = !state.capabilities.desktop;
          presets.onchange = () => {
            if (!draft || !presets.value) return;
            const [width, height] = presets.value.split('x').map(Number);
            draft.desktop.width = width; draft.desktop.height = height;
            dirty.add('desktop.width'); dirty.add('desktop.height');
            presets.value = ''; render(); onDirty();
          };
          group.append(presets);
        }
        for (const [key, field] of Object.entries(fields)) {
          const name = `${section}.${key}`;
          const row = el('label', 'config-row');
          const title = el('span'), hint = el('small');
          const input = el(field.type === 'select' ? 'select' : 'input');
          input.name = name;
          if (field.type === 'select') {
            for (const value of field.options) { const option = el('option'); option.value = value; input.append(option); }
          } else {
            input.type = field.type === 'boolean' ? 'checkbox' : field.type;
            if (field.min !== undefined) { input.min = field.min; input.max = field.max; input.step = '1'; }
            if (field.type !== 'boolean') input.required = true;
          }
          input.addEventListener('input', () => {
            if (!draft) return;
            draft[section][key] = field.type === 'boolean' ? input.checked : field.type === 'number' ? input.valueAsNumber : input.value;
            if (draft[section][key] === state.values[section][key]) dirty.delete(name); else dirty.add(name);
            if (!dirty.size) baseRevision = state.revision;
            onDirty();
          });
          row.append(title, input, hint); group.append(row);
          rows.set(name, { section, key, input, title, hint });
        }
        root.append(group);
      }
    }
    function render() {
      build();
      for (const [section, heading] of headings) heading.textContent = label(section);
      const presets = root.querySelector('.config-presets');
      if (presets) {
        presets.setAttribute('aria-label', zh() ? '分辨率预设' : 'Resolution preset');
        presets.options[0].textContent = zh() ? '选择分辨率预设…' : 'Choose a resolution…';
      }
      for (const [name, row] of rows) {
        const field = state.fields[row.section][row.key];
        const value = (draft || state.values)[row.section][row.key];
        row.title.textContent = label(name);
        row.input.disabled = !field.available;
        if (name === 'browser.language') {
          for (const option of [...row.input.options]) if (!field.options.includes(option.value) && option.value !== value) option.remove();
          if (![...row.input.options].some((option) => option.value === value)) {
            const option = el('option'); option.value = value; row.input.append(option);
          }
        }
        if (field.type === 'boolean') row.input.checked = value;
        else if (document.activeElement !== row.input && row.input.getRootNode().activeElement !== row.input) row.input.value = value;
        if (field.options) for (const option of row.input.options) option.textContent = optionLabel(field, option.value, name);
        row.hint.textContent = !field.available ? (zh() ? '当前运行模式下不可用' : 'Unavailable in this service mode')
          : field.apply === 'restart' ? (zh() ? '保存后需重启容器生效' : 'Requires a container restart after saving')
          : name === 'browser.language' ? (zh() ? '保存后新启动的浏览器进程生效，已运行的浏览器不受影响' : 'Applies to newly started browser processes after saving; running browsers keep their language')
          : field.apply === 'next-start' ? (zh() ? '用于下次启动，不改变当前浏览器' : 'Used on the next startup; leaves current browsers running')
          : (zh() ? '保存后在线应用' : 'Applies live after saving');
        if (dirty.has(name)) row.hint.textContent += (zh() ? ' · 当前保存值：' : ' · Currently saved: ') + textValue(state.values[row.section][row.key], field, name);
      }
      const messages = [];
      if (state?.pendingRestart?.length) messages.push((zh() ? '待重启生效：' : 'Restart required: ') + state.pendingRestart.map(label).join('、'));
      for (const [name, error] of Object.entries(state?.errors || {})) messages.push(`${label(name)}: ${error}`);
      if (state?.capabilities.browser) messages.push(zh()
        ? `当前浏览器模式：${state.capabilities.actualHeadless ? '无头' : '桌面'}；GPU：${state.capabilities.gpuDevice || '未检测到硬件设备'}`
        : `Current browser mode: ${state.capabilities.actualHeadless ? 'headless' : 'desktop'}; GPU: ${state.capabilities.gpuDevice || 'no hardware device detected'}`);
      result.textContent = messages.join('\n');
    }
    function update(view) {
      if (!view?.values) return;
      state = view;
      if (draft && !dirty.size) baseRevision = view.revision;
      if (draft) for (const [section, fields] of Object.entries(view.values)) for (const [key, value] of Object.entries(fields)) {
        if (!dirty.has(`${section}.${key}`)) draft[section][key] = value;
      }
      render(); onDirty();
    }
    function open(view) {
      if (!view?.values) return;
      draft = structuredClone(view.values); baseRevision = view.revision; dirty.clear(); update(view);
    }
    return {
      update, open, render,
      close() { draft = null; dirty.clear(); onDirty(); },
      ready: () => !!state?.revision,
      dirty: () => dirty.size > 0 || Object.keys(state?.errors || {}).length > 0,
      async save(call, ask) {
        if (!draft || !state) throw new Error(zh() ? '配置尚未加载' : 'Settings have not loaded yet');
        const patch = {};
        const changed = new Set([...dirty, ...Object.keys(state.errors || {})]);
        for (const name of changed) { const [s, k] = name.split('.'); (patch[s] ??= {})[k] = draft[s][k]; }
        if (!changed.size) return state;
        let confirmation;
        for (;;) {
          try {
            const view = await call({ revision: baseRevision, patch, ...(confirmation ? { confirmation } : {}) });
            open(view);
            return view;
          } catch (err) {
            if (err.code === 'confirm_evictions') {
              const names = err.evictions.map((v) => `${v.name} (${v.tabs} ${zh() ? '个标签页' : 'tabs'})`).join(', ');
              if (!await ask((zh() ? '保存这些修改将删除以下休眠浏览器及其副本：' : 'Saving will delete these hibernated browsers and their profiles: ') + names, zh() ? '保存并删除' : 'Save and delete')) return null;
              confirmation = err.confirmation;
              continue;
            }
            if (err.code === 'settings_conflict') {
              update(err.settings);
              baseRevision = err.settings.revision;
              err.message = zh() ? '配置已被其他页面修改。已更新当前保存值，请核对保留的草稿后再次保存。' : 'Settings changed elsewhere. Review the current saved values and your retained draft, then save again.';
            }
            throw err;
          }
        }
      },
    };
  } };
})();
