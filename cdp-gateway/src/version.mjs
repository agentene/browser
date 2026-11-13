// The browser's Browser.getVersion while the main browser does not run (a
// client connecting does not start it, mux.mjs): what a client connecting
// asks first (/json/version, Browser.getVersion), answered without it.
//
// The last answer a chromium the gateway started gave (launch.mjs) — all of
// them run the same binary with the same flags — or, before any did, the one
// captured from the binary at image build (VERSION_FILE, chromium's own
// /json/version). That one ran headless, so its user agent says
// HeadlessChrome; the browsers here run headed unless CDP_CONTEXTS_HEADLESS
// (Playwright tells headed from headless by that very string).

import { readFileSync } from 'node:fs';
import { CONTEXTS_HEADLESS, VERSION_FILE } from './config.mjs';

let last = null;

export function rememberVersion(version) {
  if (version) last = version;
}

// /json/version's fields as Browser.getVersion's, or null.
export function fromJsonVersion(json, headless = CONTEXTS_HEADLESS) {
  if (!json?.Browser || !json['User-Agent']) return null;
  const headed = (s) => (headless ? s : s.replace('HeadlessChrome', 'Chrome'));
  return {
    protocolVersion: json['Protocol-Version'],
    product: headed(json.Browser),
    revision: /\((@[^)]+)\)/.exec(json['WebKit-Version'] ?? '')?.[1] ?? '',
    userAgent: headed(json['User-Agent']),
    jsVersion: json['V8-Version'],
  };
}

let captured;

function capturedVersion() {
  if (captured === undefined) {
    try {
      captured = fromJsonVersion(JSON.parse(readFileSync(VERSION_FILE, 'utf8')));
    } catch {
      captured = null;
    }
  }
  return captured;
}

// Browser.getVersion's result, or null when there is none to give (then the
// main browser has to start to answer it).
export function knownVersion() {
  return last ?? capturedVersion();
}
