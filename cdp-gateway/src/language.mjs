// Auto is resolved per caller, never from another viewer's language or an env var.
import { AsyncLocalStorage } from 'node:async_hooks';

const requests = new AsyncLocalStorage();
export const DEFAULT_LANGUAGE = 'en-US';

export function canonicalLanguage(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(value)) return null;
  try { return Intl.getCanonicalLocales(value)[0] ?? null; } catch { return null; }
}

export function firstLanguage(header) {
  // Follow header order, not q-value ranking or the first translated language.
  const first = typeof header === 'string' ? header.split(',', 1)[0].split(';', 1)[0].trim() : '';
  return canonicalLanguage(first) || DEFAULT_LANGUAGE;
}

export const requestLanguage = () => requests.getStore() || DEFAULT_LANGUAGE;
export const resolveLanguage = (choice, detected = requestLanguage()) =>
  canonicalLanguage(choice === 'auto' ? detected : choice) || DEFAULT_LANGUAGE;

export function withRequestLanguage(header, run) {
  return requests.run(firstLanguage(header), run);
}

// Socket event emitters need an explicit binding to their handshake's caller.
export function bindRequestLanguage(fn) {
  const language = requestLanguage();
  return (...args) => requests.run(language, () => fn(...args));
}
