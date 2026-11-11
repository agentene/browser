// CDP_FILE_DIRS (file-access.mjs) and the client frame guard
// (client-frame.mjs) on their own (node --test).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { guardCommand, needsGuard, parseCommand } from '../src/client-frame.mjs';
import { parseFileDirs } from '../src/config.mjs';
import { allowedPath, checkFiles, mayTouchFiles, realLocation } from '../src/file-access.mjs';

// a scratch tree:
//   root/allowed/file.txt
//   root/allowed/out -> root/secret          (a symlink out of the dir)
//   root/allowed/sub/
//   root/secret/auth.json
//   root/link-to-allowed -> root/allowed     (the dir itself through a link)
let root;
let allowed;
let secret;
let dirs;

before(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'file-access-')));
  allowed = path.join(root, 'allowed');
  secret = path.join(root, 'secret');
  fs.mkdirSync(path.join(allowed, 'sub'), { recursive: true });
  fs.mkdirSync(secret);
  fs.writeFileSync(path.join(allowed, 'file.txt'), 'ok');
  fs.writeFileSync(path.join(secret, 'auth.json'), '{}');
  fs.symlinkSync(secret, path.join(allowed, 'out'));
  fs.symlinkSync(allowed, path.join(root, 'link-to-allowed'));
  dirs = [allowed];
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

test('parseFileDirs: * = no check, absolute dirs only, never empty', () => {
  assert.equal(parseFileDirs('*'), null);
  assert.equal(parseFileDirs(' * '), null);
  assert.deepEqual(parseFileDirs('/browser/downloads'), ['/browser/downloads']);
  assert.deepEqual(parseFileDirs('/a/:/b/../c: /d '), ['/a', '/c', '/d']);
  assert.throws(() => parseFileDirs(''), /empty/);
  assert.throws(() => parseFileDirs(' : '), /empty/);
  assert.throws(() => parseFileDirs('/a:rel/dir'), /not an absolute path/);
});

test('realLocation: symlinks of the existing part resolved, the rest appended', () => {
  assert.equal(realLocation(path.join(allowed, 'out', 'auth.json')), path.join(secret, 'auth.json'));
  assert.equal(realLocation(path.join(allowed, 'new', 'deeper', 'f')), path.join(allowed, 'new', 'deeper', 'f'));
  assert.equal(realLocation(path.join(allowed, 'out', 'new.json')), path.join(secret, 'new.json'));
  assert.equal(realLocation(path.join(allowed, 'sub', '..', '..', 'secret')), secret);
});

test('allowedPath: only real locations inside the dirs', () => {
  assert.equal(allowedPath(path.join(allowed, 'file.txt'), dirs), true);
  assert.equal(allowedPath(allowed, dirs), true, 'the dir itself (a directory upload)');
  assert.equal(allowedPath(path.join(allowed, 'sub'), dirs), true);
  assert.equal(allowedPath(path.join(allowed, 'not-yet', 'x.bin'), dirs), true, 'a path that does not exist yet');
  assert.equal(allowedPath(path.join(root, 'link-to-allowed', 'file.txt'), dirs), true, 'through a link to the dir');
  assert.equal(allowedPath(path.join(secret, 'auth.json'), dirs), false);
  assert.equal(allowedPath(path.join(allowed, '..', 'secret', 'auth.json'), dirs), false, '..');
  assert.equal(allowedPath(path.join(allowed, 'out', 'auth.json'), dirs), false, 'a symlink out of the dir');
  assert.equal(allowedPath(path.join(allowed, 'out'), dirs), false, 'a symlinked dir (directory upload)');
  assert.equal(allowedPath(root, dirs), false, 'a parent of the dir: a directory upload would include it all');
  assert.equal(allowedPath('/', dirs), false);
  assert.equal(allowedPath(`${allowed}-evil/x`, dirs), false, 'a sibling sharing the prefix');
  assert.equal(allowedPath('file.txt', dirs), false, 'relative');
  assert.equal(allowedPath('', dirs), false);
  assert.equal(allowedPath(`${allowed}/a\0b`, dirs), false);
  assert.equal(allowedPath(42, dirs), false);
  assert.equal(allowedPath(['x'], dirs), false);
  assert.equal(allowedPath('/etc/passwd', null), true, '* allows any');
  assert.equal(allowedPath('/etc/passwd', ['/']), true, '/ allows any');
  assert.equal(allowedPath(path.join(allowed, 'file.txt'), [path.join(root, 'link-to-allowed')]), true, 'a listed dir that is a link');
  assert.equal(allowedPath(path.join(allowed, 'file.txt'), [path.join(root, 'missing')]), false);
});

test('checkFiles: reads outside the dirs are refused, in every command that reads', () => {
  const ok = path.join(allowed, 'file.txt');
  const bad = path.join(secret, 'auth.json');
  const cases = [
    ['DOM.setFileInputFiles', (f) => ({ files: f, nodeId: 1 })],
    ['Input.dispatchDragEvent', (f) => ({ type: 'drop', x: 1, y: 1, data: { items: [], files: f, dragOperationsMask: 1 } })],
    ['PWA.launchFilesInApp', (f) => ({ manifestId: 'm', files: f })],
  ];
  for (const [method, params] of cases) {
    const good = { id: 1, method, params: params([ok]) };
    assert.equal(checkFiles(good, dirs).msg, good, `${method}: passed as it is`);
    assert.match(checkFiles({ id: 1, method, params: params([ok, bad]) }, dirs).error, /outside CDP_FILE_DIRS/, method);
    assert.match(checkFiles({ id: 1, method, params: params('/etc/passwd') }, dirs).error, /not an array/, method);
    assert.equal(checkFiles({ id: 1, method, params: params([bad]) }, null).msg.method, method, `${method}: * allows it`);
  }
  assert.match(checkFiles({ id: 1, method: 'Extensions.loadUnpacked', params: { path: secret } }, dirs).error, /outside/);
  assert.ok(checkFiles({ id: 1, method: 'Extensions.loadUnpacked', params: { path: path.join(allowed, 'sub') } }, dirs).msg);
  // no paths at all: chromium answers it
  assert.ok(checkFiles({ id: 1, method: 'Input.dispatchDragEvent', params: { type: 'dragCancel' } }, dirs).msg);
  assert.ok(checkFiles({ id: 1, method: 'DOM.setFileInputFiles' }, dirs).msg);
  assert.ok(checkFiles({ id: 1, method: 'DOM.setFileInputFiles', params: null }, dirs).msg);
  assert.ok(checkFiles({ id: 1, method: 'Input.dispatchDragEvent', params: { data: null } }, dirs).msg);
  // other commands are not looked at
  const other = { id: 1, method: 'Runtime.evaluate', params: { expression: '1' } };
  assert.equal(checkFiles(other, dirs).msg, other);
});

test('checkFiles: a download directory outside the dirs is redirected into the first one', () => {
  for (const method of ['Browser.setDownloadBehavior', 'Page.setDownloadBehavior']) {
    const pw = { id: 3, method, params: { behavior: 'allowAndName', downloadPath: '/tmp/playwright-artifacts-x', eventsEnabled: true } };
    const r = checkFiles(pw, [allowed, '/elsewhere']);
    assert.deepEqual(r.msg, { id: 3, method, params: { behavior: 'allowAndName', downloadPath: allowed, eventsEnabled: true } });
    assert.match(r.note, /redirected/);
    assert.equal(pw.params.downloadPath, '/tmp/playwright-artifacts-x', 'the original is left alone');
    assert.equal(checkFiles({ id: 3, method, params: { behavior: 'allow', downloadPath: secret } }, dirs).msg.params.downloadPath, allowed);
    assert.equal(checkFiles({ id: 3, method, params: { behavior: 'allow', downloadPath: 'C:\\Users\\me\\Temp' } }, dirs).msg.params.downloadPath, allowed);
    const inside = { id: 3, method, params: { behavior: 'allow', downloadPath: path.join(allowed, 'run-1') } };
    assert.equal(checkFiles(inside, dirs).msg, inside);
    const none = { id: 3, method, params: { behavior: 'default' } };
    assert.equal(checkFiles(none, dirs).msg, none);
  }
});

test('mayTouchFiles / needsGuard: the cheap pre-checks on raw frames', () => {
  for (const m of ['DOM.setFileInputFiles', 'Input.dispatchDragEvent', 'PWA.launchFilesInApp', 'Extensions.loadUnpacked', 'Browser.setDownloadBehavior', 'Page.setDownloadBehavior']) {
    const frame = Buffer.from(JSON.stringify({ id: 1, method: m, params: {} }));
    assert.equal(mayTouchFiles(frame, dirs), true, m);
    assert.equal(mayTouchFiles(frame, null), false, `${m} with *`);
    // wrapped in a sendMessageToTarget: only its quotes are escaped
    const wrapped = JSON.stringify({ id: 2, method: 'Target.sendMessageToTarget', params: { sessionId: 's', message: frame.toString() } });
    assert.equal(mayTouchFiles(Buffer.from(wrapped), dirs), true, `${m} wrapped`);
  }
  assert.equal(needsGuard(Buffer.from('{"id":1,"method":"Runtime.evaluate","params":{"expression":"1"}}')), false);
  assert.equal(needsGuard(Buffer.from('{"id":1,"method":"DOM.\\u0073etFileInputFiles"}')), true, 'escaped');
  assert.equal(needsGuard(Buffer.from('{"id":1,"method":"DOM.setFileInputFiles"}')), true);
  assert.equal(needsGuard(Buffer.from('{"id":1,"method":"Browser.close"}')), true);
  assert.equal(needsGuard(Buffer.from('{"id":1,"method":"Target.exposeDevToolsProtocol","params":{"targetId":"T"}}')), true);
});

test('guardCommand: Target.exposeDevToolsProtocol is refused, wrapped or not', () => {
  // the page's binding would speak CDP to the browser target past every check
  const expose = { id: 1, method: 'Target.exposeDevToolsProtocol', params: { targetId: 'T', bindingName: 'cdp' } };
  const direct = guardCommand(expose);
  assert.equal(direct.close, false);
  assert.equal(direct.answer.error.code, -32000);
  assert.match(direct.answer.error.message, /exposeDevToolsProtocol refused by the CDP gateway/);
  const wrapped = guardCommand({ id: 2, method: 'Target.sendMessageToTarget', params: { sessionId: 's', message: JSON.stringify(expose) } });
  assert.match(wrapped.answer.error.message, /exposeDevToolsProtocol refused/);
  // with CDP_FILE_DIRS=* and CDP_ALLOW_BROWSER_CLOSE=true it stays refused:
  // it would bypass whatever checks are on
  assert.equal(guardCommand({ ...expose, params: { ...expose.params, inheritPermissions: true } }).answer.error.code, -32000);
});

test('parseCommand: chromium\'s own errors for what is no JSON object', () => {
  assert.deepEqual(parseCommand(Buffer.from('{"id":1,"method":"Browser.getVersion"}')).msg, { id: 1, method: 'Browser.getVersion' });
  // a raw TAB in a string: chromium reads it, JSON.parse does not
  const tab = parseCommand(Buffer.from('{"id":11,"method":"Browser.close","params":{"a":"\t"}}'));
  assert.equal(tab.msg, undefined);
  assert.equal(tab.answer.error.code, -32700);
  assert.match(tab.answer.error.message, /^JSON: /);
  assert.equal(tab.answer.id, undefined, 'no id: the frame could not be read');
  for (const v of ['null', '[]', '1', '"x"']) {
    assert.deepEqual(parseCommand(Buffer.from(v)).answer, { error: { code: -32600, message: 'Message must be an object' } }, v);
  }
});

test('guardCommand: Browser.close, file paths, and both inside sendMessageToTarget', () => {
  const close = guardCommand({ id: 1, method: 'Browser.close' });
  assert.deepEqual(close.answer, { result: {} });
  assert.equal(close.close, true);
  assert.match(guardCommand({ id: 1, method: 'Browser.crash' }).answer.error.message, /refused/);
  const plain = { id: 1, method: 'Runtime.evaluate', params: { expression: '1' } };
  assert.deepEqual(guardCommand(plain), { msg: plain, notes: [] });

  // the default CDP_FILE_DIRS (/browser/downloads) in the module
  const refused = guardCommand({ id: 2, method: 'DOM.setFileInputFiles', params: { files: ['/browser/settings/auth.json'], nodeId: 1 } });
  assert.equal(refused.close, false);
  assert.equal(refused.answer.error.code, -32000);
  assert.match(refused.answer.error.message, /auth\.json.*outside CDP_FILE_DIRS/);
  const redirected = guardCommand({ id: 3, method: 'Browser.setDownloadBehavior', params: { behavior: 'allow', downloadPath: '/browser/settings' } });
  assert.equal(redirected.msg.params.downloadPath, '/browser/downloads');
  assert.equal(redirected.notes.length, 1);

  const wrap = (message, depth = 1) => {
    let msg = message;
    for (let i = 0; i < depth; i++) msg = { id: 100 + i, method: 'Target.sendMessageToTarget', params: { sessionId: `s${i}`, message: JSON.stringify(msg) } };
    return msg;
  };
  // a wrapped Browser.close cannot end the client's connection: refused
  const wrappedClose = guardCommand(wrap({ id: 4, method: 'Browser.close' }));
  assert.equal(wrappedClose.close, false);
  assert.match(wrappedClose.answer.error.message, /Browser\.close refused/);
  assert.match(guardCommand(wrap({ id: 5, method: 'DOM.setFileInputFiles', params: { files: ['/etc/passwd'] } }, 3)).answer.error.message, /outside/);
  // a wrapped download is redirected, and the message re-serialized from it
  const w = guardCommand(wrap({ id: 6, method: 'Page.setDownloadBehavior', params: { behavior: 'allow', downloadPath: '/tmp/x' } }, 2));
  const inner = JSON.parse(JSON.parse(w.msg.params.message).params.message);
  assert.deepEqual(inner, { id: 6, method: 'Page.setDownloadBehavior', params: { behavior: 'allow', downloadPath: '/browser/downloads' } });
  assert.equal(w.notes.length, 1);
  // a wrapped message the gateway cannot read is not passed on
  const unreadable = { id: 7, method: 'Target.sendMessageToTarget', params: { sessionId: 's', message: '{"id":1,"method":"Browser.close","params":{"a":"\t"}}' } };
  assert.match(guardCommand(unreadable).answer.error.message, /not a JSON object/);
  assert.match(guardCommand(wrap({ id: 8, method: 'Runtime.evaluate' }, 9)).answer.error.message, /nested too deep/);
  // what passes is re-serialized: duplicate keys collapse to the one checked
  const dup = parseCommand(Buffer.from('{"id":9,"method":"Target.sendMessageToTarget","params":{"sessionId":"s","message":"{\\"id\\":1,\\"method\\":\\"DOM.setFileInputFiles\\",\\"params\\":{\\"files\\":[\\"/etc/passwd\\"],\\"files\\":[\\"/browser/downloads/a\\"]}}"}}')).msg;
  const dupOut = guardCommand(dup);
  assert.equal(dupOut.msg.params.message, '{"id":1,"method":"DOM.setFileInputFiles","params":{"files":["/browser/downloads/a"]}}');
});
