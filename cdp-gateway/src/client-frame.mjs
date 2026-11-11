// What the gateway checks in a client's CDP command before it goes upstream,
// on a browser connection (mux.mjs) and on a page one (relay.mjs) alike:
// Browser.close / Browser.crash (browser-exit.mjs), local file paths
// (file-access.mjs), and the commands that would open a CDP channel the
// gateway never sees (UNCHECKED_CHANNELS).
//
// Every client frame is parsed — the pipe the browsers speak CDP on (pipe.mjs)
// needs each command's id and session anyway — and goes upstream as the
// command the check read, re-serialized, never as it came: the gateway's
// JSON.parse and chromium's own parser differ in places (raw control
// characters in strings, duplicate keys), and a frame both read differently
// could otherwise hide a command from the check. A frame JSON.parse rejects
// is answered here with chromium's own parse error, for the same reason.

import { REFUSED_MESSAGE, browserExitAction } from './browser-exit.mjs';
import { checkFiles } from './file-access.mjs';

const WRAPPER = 'Target.sendMessageToTarget';
// how deep sendMessageToTarget wrappers are followed (each is a session
// attached, with flatten: false, inside another); deeper ones are refused
const MAX_DEPTH = 8;

// Commands that hand a page a CDP channel of its own, which the checks here
// would never see: Target.exposeDevToolsProtocol gives the page's script a
// binding that speaks CDP to the browser target, and from there it can
// attach to anything (Target.attachToBrowserTarget) and send any command —
// the method names assembled at run time, so no frame the gateway reads
// ever names them. Refused at any depth.
const UNCHECKED_CHANNELS = new Set(['Target.exposeDevToolsProtocol']);

// A raw frame as a command: { msg } or { answer } (chromium's own error for
// a frame that is no JSON object; it has no id to answer under).
export function parseCommand(data) {
  let msg;
  try {
    msg = JSON.parse(data.toString());
  } catch (err) {
    return { answer: { error: { code: -32700, message: `JSON: ${err.message}` } } };
  }
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
    return { answer: { error: { code: -32600, message: 'Message must be an object' } } };
  }
  return { msg };
}

// What the gateway does with a parsed client command:
//   { msg, notes }           forward msg (the command, or a rewritten copy);
//                            notes: what was rewritten, for the log
//   { answer, close, note }  answer the client with answer (the caller adds
//                            the command's id and sessionId) instead; close:
//                            end the client's connection afterwards
export function guardCommand(msg, depth = 0) {
  if (UNCHECKED_CHANNELS.has(msg.method)) {
    return refuse(`${msg.method} refused by the CDP gateway: it would give the page a CDP channel the gateway cannot check`);
  }
  const exit = browserExitAction(msg.method);
  if (exit === 'close' && depth === 0) {
    return { answer: { result: {} }, close: true, note: 'Browser.close: closing this client\'s connection, not the shared browser' };
  }
  if (exit) {
    // a wrapped Browser.close cannot end the client's connection: refused too
    return refuse(`${msg.method} ${REFUSED_MESSAGE}`);
  }
  const files = checkFiles(msg);
  if (files.error) return refuse(files.error);
  const notes = files.note ? [files.note] : [];

  const params = files.msg.params;
  if (files.msg.method === WRAPPER && params && typeof params.message === 'string') {
    if (depth >= MAX_DEPTH) return refuse(`${WRAPPER}: nested too deep (refused by the CDP gateway)`);
    const inner = parseCommand(params.message);
    if (inner.answer) return refuse(`${WRAPPER}: the message is not a JSON object (refused by the CDP gateway)`);
    const checked = guardCommand(inner.msg, depth + 1);
    if (checked.answer) return checked;
    notes.push(...checked.notes);
    return { msg: { ...files.msg, params: { ...params, message: JSON.stringify(checked.msg) } }, notes };
  }
  return { msg: files.msg, notes };
}

function refuse(message) {
  return { answer: { error: { code: -32000, message } }, close: false, note: message };
}

// The answer to a command, as the client gets it.
export function answerFor(msg, answer) {
  return { id: msg.id, sessionId: msg.sessionId, ...answer };
}

// The whole check of one client frame, as every caller applies it (mux.mjs,
// relay.mjs — one decision, not one per connection kind):
//   { msg, notes }           send msg upstream (the parsed command, or a
//                            rewritten copy); notes: what was rewritten
//   { answer, close, note }  never forwarded. Answer the client instead —
//                            answer is null when the command has no id to
//                            answer under (a parse error). close: end the
//                            client's connection after the answer (its own
//                            Browser.close, which is all a client can tell of
//                            a closed browser). note: why, for the log.
export function guardFrame(data) {
  const parsed = parseCommand(data);
  if (parsed.answer) return { answer: parsed.answer, close: false };
  const guarded = guardCommand(parsed.msg);
  if (guarded.msg) return { msg: guarded.msg, notes: guarded.notes };
  return {
    answer: parsed.msg.id === undefined ? null : answerFor(parsed.msg, guarded.answer),
    close: guarded.close,
    note: guarded.note,
  };
}
