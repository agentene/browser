// /json/*: chromium's DevTools HTTP endpoints, over all browsers, made from
// CDP over their pipes (the browsers serve none: pipe.mjs), with URLs on
// the public host:port the client dialed.

import fs from 'node:fs/promises';
import { browserNames, pipeOf, targetAddress } from './browsers.mjs';
import { contexts } from './contexts.mjs';
import { cdpOriginDenied } from './cdp-origin.mjs';
import { PROTOCOL_FILE } from './config.mjs';
import { mainBrowser } from './main-browser.mjs';
import { HttpError, publicHost, send } from './respond.mjs';
import { listEntry, targetInfos, versionEntry } from './targets.mjs';
import { knownVersion } from './version.mjs';

const TEXT = 'text/plain; charset=UTF-8';

// chromium's /json/new?<url>: the query is the URL, percent-decoded
function newTabUrl(search) {
  const raw = search.slice(1);
  if (!raw) return 'about:blank';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// Answers the request and returns true if it is one of these routes.
export async function jsonRoute(req, res, url) {
  const p = url.pathname.replace(/(.)\/$/, '$1'); // /json/version/ as /json/version
  if (!/^\/json(\/|$)/.test(p)) return false;
  const denied = cdpOriginDenied(req);
  if (denied) {
    send(res, denied[0], { error: denied[1] });
    return true;
  }
  const host = publicHost(req);
  if (p === '/json/new') {
    // chromium takes /json/new by PUT only, so that no page can open tabs
    // with a mere <img> or link (and answers a GET with this 405)
    if (req.method !== 'PUT') {
      send(res, 405, `Using unsafe HTTP verb ${req.method} to invoke /json/new. This action supports only PUT verb.`, TEXT);
      return true;
    }
    // a tab in the default context: a stopped main browser starts for it
    await mainBrowser.ensure();
    const { targetId } = await mainBrowser.pipe.call('Target.createTarget', { url: newTabUrl(url.search) });
    const { targetInfo } = await mainBrowser.pipe.call('Target.getTargetInfo', { targetId });
    send(res, 200, listEntry(targetInfo, host, mainBrowser.pipe.version?.revision));
    return true;
  }
  if (p === '/json/version') {
    // a stopped main browser stays stopped (the browser WebSocket does not
    // need it either, upgrade.mjs); one starting is waited for
    const version = (mainBrowser.state === 'stopped' || mainBrowser.stopping) && knownVersion();
    if (version) {
      send(res, 200, versionEntry(version, host, mainBrowser.browserId || 'gateway'));
      return true;
    }
    await mainBrowser.ensure();
    send(res, 200, versionEntry(mainBrowser.version, host, mainBrowser.browserId));
    return true;
  }
  if (p === '/json' || p === '/json/list') {
    // all browsers at once (a stopped main browser lists nothing and is not
    // started); one shutting down meanwhile lists nothing either
    const lists = await Promise.all(browserNames().map(async (name) => {
      const pipe = pipeOf(name);
      if (!pipe) return [];
      const context = contexts.get(name);
      return targetInfos(pipe).then((infos) => infos.map((info) => listEntry({ ...info,
        targetId: context?.logicalTarget(info.targetId) ?? info.targetId }, host, pipe.version?.revision)), () => []);
    }));
    send(res, 200, lists.flat());
    return true;
  }
  if (p === '/json/protocol') {
    let protocol;
    try {
      protocol = await fs.readFile(PROTOCOL_FILE);
    } catch (err) {
      throw new HttpError(404, `no protocol description (${err.code})`);
    }
    send(res, 200, protocol);
    return true;
  }
  const m = p.match(/^\/json\/(activate|close)\/([^/]+)$/);
  if (m) {
    const [, action, targetId] = m;
    const target = await targetAddress(targetId, true);
    if (!target) {
      send(res, 404, `No such target id: ${targetId}`, TEXT);
    } else if (action === 'activate') {
      target.context?.touch();
      await target.pipe.call('Target.activateTarget', { targetId: target.id });
      send(res, 200, 'Target activated', TEXT);
    } else {
      target.context?.touch();
      await target.pipe.call('Target.closeTarget', { targetId: target.id });
      send(res, 200, 'Target is closing', TEXT);
    }
    return true;
  }
  return false;
}
