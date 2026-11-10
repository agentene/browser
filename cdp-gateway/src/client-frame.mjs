// What the gateway checks in a client's CDP command before it goes upstream,
// on a browser connection (mux.mjs) and on a page one (relay.mjs) alike:
// Browser.close / Browser.crash (browser-exit.mjs) and local file paths
// (file-access.mjs).
//
// Most frames are not even parsed (needsGuard: none of the methods can be in
// them). A frame that is parsed goes upstream re-serialized from the parsed
// command, never as it came: the gateway's JSON.parse and chromium's own
// parser differ in places (raw control characters in strings, duplicate
// keys), and a frame both read differently could otherwise hide a command
// from the check. A frame JSON.parse rejects is answered here with
// chromium's own parse error, for the same reason.

import { REFUSED_MESSAGE, browserExitAction, hasEscape, mayEndBrowser } from './browser-exit.mjs';
import { checkFiles, mayTouchFiles } from './file-access.mjs';

const WRAPPER = 'Target.sendMessageToTarget';
// how deep sendMessageToTarget wrappers are followed (each is a session
// attached, with flatten: false, inside another); deeper ones are refused
const MAX_DEPTH = 8;

// Whether a raw frame may hold a command the gateway checks.
export function needsGuard(data) {
  return hasEscape(data) || mayEndBrowser(data) || mayTouchFiles(data);
}

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
//   { msg, forward, notes }  send forward upstream: the command re-serialized
//                            (msg: the parsed command, for mux's routing)
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
  if (guarded.msg) return { msg: guarded.msg, forward: JSON.stringify(guarded.msg), notes: guarded.notes };
  return {
    answer: parsed.msg.id === undefined ? null : answerFor(parsed.msg, guarded.answer),
    close: guarded.close,
    note: guarded.note,
  };
}
