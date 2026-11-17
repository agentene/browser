// Shared configuration form for the standalone console and the shadow-root panel.
(() => {
  'use strict';
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
      .config-section[hidden], .config-row[hidden] { display:none; }
      .config-section h4 { margin:0; font-size:14px; }
      .config-row { display:grid; gap:5px; min-width:0; font-size:13px; }
      .config-row input:not([type=checkbox]), .config-row select { box-sizing:border-box; width:100%; max-width:360px; min-width:0; padding:7px 9px; border:1px solid var(--line); border-radius:6px; background:var(--card); color:var(--text); font:inherit; }
      .config-row input[type=checkbox] { justify-self:start; accent-color:var(--accent); }
      .config-row small, .config-result, .config-capability { color:var(--muted); font-size:12px; overflow-wrap:anywhere; }
      .config-row :disabled { opacity:.5; }
      .config-result { grid-column:1 / -1; margin:0; white-space:pre-line; }
      .config-result:empty { display:none; }
      .config-capability { margin:0; }
    `;
    root.append(style, result);
    container.append(root);
    const t = (key, ...args) => window.AgenteneI18n.t(getLang(), key, ...args);
    const label = (key) => t(key === 'hibernate' ? 'hibernatePolicy' : key);
    function optionLabel(field, value, name) {
      if (value === 'auto') return t('auto');
      const translated = field.optionLabels?.[value]?.[getLang() === 'zh-CN' ? 1 : getLang() === 'en-US' ? 0 : -1];
      if (translated) return translated;
      if (name === 'desktop.resolution') return value.replace('x', ' × ')
        + (field.options.includes(value) ? '' : t('savedChoice'));
      if (name === 'browser.language') {
        // An older settings file may contain a valid locale outside the common
        // choices. Keep it selected and show its name instead of resetting it.
        try {
          const translatedName = new Intl.DisplayNames([getLang()], { type: 'language', fallback: 'none' }).of(value);
          if (translatedName) return translatedName;
        } catch { /* unknown locale */ }
        return t('savedLanguage');
      }
      return label(value);
    }
    const textValue = (v, field, name) => typeof v === 'boolean' ? t(v ? 'on' : 'off')
      : field.type === 'select' ? optionLabel(field, String(v), name) : label(String(v));
    function build() {
      if (!state?.fields || rows.size) return;
      for (const [section, fields] of Object.entries(state.fields)) {
        const group = el('section', 'config-section');
        group.hidden = !state.capabilities.browser && ['contexts', 'overlay'].includes(section);
        const heading = el('h4');
        headings.set(section, heading);
        group.append(heading);
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
            if (name === 'contexts.overflow') render();
            onDirty();
          });
          row.append(title, input, hint); group.append(row);
          rows.set(name, { section, key, element: row, input, title, hint });
        }
        root.append(group);
      }
    }
    function render() {
      build();
      for (const [section, heading] of headings) heading.textContent = label(section);
      for (const [name, row] of rows) {
        const field = state.fields[row.section][row.key];
        const value = (draft || state.values)[row.section][row.key];
        row.title.textContent = label(name);
        row.element.hidden = name === 'contexts.maxHibernated' && (draft || state.values).contexts.overflow === 'reject';
        row.input.disabled = !field.available || row.element.hidden;
        if (name === 'browser.language' || name === 'desktop.resolution') {
          for (const option of [...row.input.options]) if (!field.options.includes(option.value) && option.value !== value) option.remove();
          if (![...row.input.options].some((option) => option.value === value)) {
            const option = el('option'); option.value = value; row.input.append(option);
          }
        }
        if (field.type === 'boolean') row.input.checked = value;
        else if (document.activeElement !== row.input && row.input.getRootNode().activeElement !== row.input) row.input.value = value;
        if (field.options) for (const option of row.input.options) option.textContent = optionLabel(field, option.value, name);
        row.hint.textContent = !field.available ? t('settingUnavailable')
          : field.apply === 'restart' ? t('settingRestart')
          : name === 'browser.language' ? t(state.capabilities.browser ? 'settingLanguage' : 'settingLanguageOnly')
          : field.apply === 'next-start' ? t('settingNextStart') : t('settingLive');
        if (name === 'browser.language') row.hint.textContent += ` · ${t('settingLanguageAuto')}`;
        if (dirty.has(name)) row.hint.textContent += t('currentlySaved', textValue(state.values[row.section][row.key], field, name));
        if (field.available && name === 'desktop.resolution') row.hint.textContent += t('settingResolution');
        if (field.available && name === 'overlay.mode') row.hint.textContent += t('settingAllViewers');
      }
      const messages = [];
      if (state?.pendingRestart?.length) messages.push(t('restartRequired', state.pendingRestart.map(label).join(', ')));
      for (const [name, error] of Object.entries(state?.errors || {})) messages.push(`${label(name)}: ${error}`);
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
    // Keep hidden edits in the draft for switching back, but do not apply them.
    const editedFields = () => [...dirty].filter((name) => !rows.get(name).element.hidden);
    return {
      update, open, render,
      close() { draft = null; dirty.clear(); onDirty(); },
      ready: () => !!state?.revision,
      dirty: () => editedFields().length > 0 || Object.keys(state?.errors || {}).length > 0,
      async save(call, ask) {
        if (!draft || !state) throw new Error(t('settingsNotLoaded'));
        const patch = {};
        const changed = new Set([...editedFields(), ...Object.keys(state.errors || {})]);
        for (const name of changed) {
          const [s, k] = name.split('.');
          (patch[s] ??= {})[k] = rows.get(name)?.element.hidden ? state.values[s][k] : draft[s][k];
        }
        if (!changed.size) return state;
        let confirmation;
        for (;;) {
          try {
            const view = await call({ revision: baseRevision, patch, ...(confirmation ? { confirmation } : {}) });
            open(view);
            return view;
          } catch (err) {
            if (err.code === 'confirm_evictions') {
              const names = err.evictions.map((v) => `${v.name} (${t('tabs', v.tabs)})`).join(', ');
              if (!await ask(t('confirmEvictions', names), t('saveAndDelete'))) return null;
              confirmation = err.confirmation;
              continue;
            }
            if (err.code === 'settings_conflict') {
              update(err.settings);
              baseRevision = err.settings.revision;
              err.message = t('settingsConflict');
            }
            throw err;
          }
        }
      },
    };
  } };
})();
