// Local files a CDP client names (CDP_FILE_DIRS).
//
// The browsers run as the container's own user, and a few CDP commands make
// them read or write a local file the client names by path. A file input
// (DOM.setFileInputFiles), a drop (Input.dispatchDragEvent's data.files), a
// PWA launch (PWA.launchFilesInApp) or an unpacked extension
// (Extensions.loadUnpacked) can read any file that user can, the login's
// /browser/settings/auth.json included. A download directory
// (Browser/Page.setDownloadBehavior) can write a new file into any directory
// that user can write, including a fresh auth.json, which would claim the
// login before its setup. Blocking file:// URLs (chromium.sh) covers none
// of these.
//
// So every path in those commands has to lie inside one of the CDP_FILE_DIRS
// (the real location: symlinks and .. resolved). For a path that does not
// exist yet, its nearest existing ancestor is resolved and the rest is
// appended. A read elsewhere is refused. A download directory elsewhere is
// redirected into the first of the dirs instead, because Playwright names a
// temp directory on the CLIENT's machine on every connect (connectOverCDP),
// and refusing it would fail the connect. CDP_FILE_DIRS=* turns the check off.
// Commands wrapped in Target.sendMessageToTarget reach checkFiles one by one
// (client-frame.mjs unwraps them).

import fs from 'node:fs';
import path from 'node:path';
// FILE_DIRS: the CDP_FILE_DIRS, null = no check (*)
import { FILE_DIRS } from './config.mjs';

// The commands that read files: method -> the paths in its params
const READS = {
  'DOM.setFileInputFiles': (p) => p.files,
  'Input.dispatchDragEvent': (p) => p.data?.files,
  'PWA.launchFilesInApp': (p) => p.files,
  'Extensions.loadUnpacked': (p) => (p.path === undefined ? undefined : [p.path]),
};
const DOWNLOADS = new Set(['Browser.setDownloadBehavior', 'Page.setDownloadBehavior']);

// The real location of an absolute path that may not exist (yet): its
// nearest existing ancestor with symlinks resolved, plus the rest.
export function realLocation(p) {
  let head = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(head), ...rest);
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
      const parent = path.dirname(head);
      if (parent === head) throw err;
      rest.unshift(path.basename(head));
      head = parent;
    }
  }
}

function inside(real, dir) {
  return dir === '/' || real === dir || real.startsWith(`${dir}/`);
}

// Whether a path the client named lies inside one of the dirs.
export function allowedPath(p, dirs = FILE_DIRS) {
  if (dirs === null) return true;
  if (typeof p !== 'string' || !path.isAbsolute(p) || p.includes('\0')) return false;
  let real;
  try {
    real = realLocation(p);
  } catch {
    return false;
  }
  return dirs.some((dir) => {
    let realDir;
    try {
      realDir = realLocation(dir);
    } catch {
      return false;
    }
    return inside(real, realDir);
  });
}

// What the gateway does with a parsed client command:
//   { msg }           forward msg (the command itself, or a copy with the
//                     download directory redirected)
//   { msg, note }     the same, with what was redirected (for the log)
//   { error }         refuse it with this message
export function checkFiles(msg, dirs = FILE_DIRS) {
  if (dirs === null) return { msg };
  const { method } = msg;
  const params = msg.params && typeof msg.params === 'object' ? msg.params : {};

  if (Object.hasOwn(READS, method)) {
    const paths = READS[method](params);
    if (paths === undefined) return { msg };
    if (!Array.isArray(paths)) return { error: `${method}: the file list is not an array` };
    for (const p of paths) {
      if (!allowedPath(p, dirs)) return { error: `${method}: ${JSON.stringify(String(p))} is outside CDP_FILE_DIRS (refused by the CDP gateway)` };
    }
    return { msg };
  }

  if (DOWNLOADS.has(method)) {
    const p = params.downloadPath;
    if (p === undefined || allowedPath(p, dirs)) return { msg };
    const to = dirs[0];
    return {
      msg: { ...msg, params: { ...params, downloadPath: to } },
      note: `${method}: download directory ${JSON.stringify(String(p))} is outside CDP_FILE_DIRS, redirected to ${to}`,
    };
  }
  return { msg };
}
