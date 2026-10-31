// "Something the console shows changed" (a context created or gone, the
// main browser's state, the window in front, a console action). The modules
// that change it notify; console-live.mjs listens and pushes the change
// right away instead of on its next tick. Keeps them free of an import of
// the console.

const listeners = new Set();

export function onChange(listener) {
  listeners.add(listener);
}

export function notifyChange() {
  for (const listener of listeners) listener();
}
