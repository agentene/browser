// /console/*: the dashboard, the sidebar and input overlay scripts nginx
// injects into the Selkies page (nginx proxies /cdp-console/ on the web port here), and the
// console's actions, POST/DELETE /console/api/<name>… (its state comes over
// the /console/ws WebSocket, console-live.mjs):
//   POST   /console/api/main/start|stop     the main browser
//   POST   /console/api/<name>/focus[/<id>] bring a browser (tab) to the front
//   DELETE /console/api/<context>           destroy a context (and end the
//                                           CDP connection that owns it)
//   GET    /console/api/settings            the server-side settings (settings.mjs)
//   PATCH  /console/api/settings            change some: {section: {key: value}}

import fs from 'node:fs/promises';
import path from 'node:path';
import { notifyChange } from './changes.mjs';
import { ROOT } from './config.mjs';
import { consoleDenied } from './console-auth.mjs';
import { contexts } from './contexts.mjs';
import { focus } from './desktop.mjs';
import { mainBrowser } from './main-browser.mjs';
import { readJson, send } from './respond.mjs';
import { settingsView, updateSettings } from './settings.mjs';

const FILES = {
  '/console/': ['dashboard.html', 'text/html; charset=UTF-8'],
  '/console/panel.js': ['panel.js', 'text/javascript; charset=UTF-8'],
  '/console/overlay.js': ['overlay.js', 'text/javascript; charset=UTF-8'],
};

// Answers the request and returns true if it is one of these routes.
export async function consoleRoute(req, res, url) {
  const p = url.pathname;
  if (p === '/console') {
    res.writeHead(302, { Location: '/console/' });
    res.end();
    return true;
  }
  if (!p.startsWith('/console/')) return false;
  const denied = await consoleDenied(req);
  if (denied) {
    send(res, denied[0], { error: denied[1] });
    return true;
  }
  if (FILES[p]) {
    const [file, type] = FILES[p];
    send(res, 200, await fs.readFile(path.join(ROOT, file)), type);
    return true;
  }
  if (p === '/console/api/settings') {
    if (req.method === 'GET') {
      send(res, 200, settingsView());
    } else if (req.method === 'PATCH') {
      try {
        send(res, 200, await updateSettings(await readJson(req)));
      } catch (err) {
        send(res, err.status ?? 500, { error: err.message });
      }
    } else {
      send(res, 405, { error: 'GET or PATCH' });
    }
    return true;
  }
  const a = p.match(/^\/console\/api\/([\w.-]+)(?:\/(focus|start|stop)(?:\/([^/]+))?)?$/);
  if (!a) return false;
  const [, name, action, targetId] = a;
  if ((action === 'start' || action === 'stop') && req.method === 'POST' && !targetId) {
    if (name !== 'main') send(res, 404, { error: 'only the main browser can be started or stopped' });
    else {
      if (action === 'start') await mainBrowser.ensure();
      else await mainBrowser.stop();
      send(res, 200, { ok: true, state: mainBrowser.state });
    }
    return true;
  }
  if (action === 'focus' && req.method === 'POST') {
    if (name === 'main' && !mainBrowser.running) {
      send(res, 409, { error: `the main browser is ${mainBrowser.state}` });
    } else if (!(await focus(name, targetId))) {
      send(res, 404, { error: 'nothing to focus' });
    } else {
      notifyChange(); // the new current tab
      send(res, 200, { ok: true });
    }
    return true;
  }
  if (!action && req.method === 'DELETE') {
    const context = contexts.get(name);
    if (!context) {
      send(res, 404, { error: `no context ${name}` });
    } else {
      // its client's whole connection goes too: a client whose context
      // vanished under it would otherwise go on with a half-dead browser
      // (Playwright then reports the browser as disconnected)
      await context.destroy('deleted via API');
      context.mux?.close('context deleted via API');
      send(res, 200, { ok: true });
    }
    return true;
  }
  return false;
}
