#!/usr/bin/env node
/**
 * update-chrome-node.mjs — keep the pinned Chrome for Testing + Node.js
 * versions in sync across the repo (Dockerfile, compose.yaml, and the
 * build-arg default tables in README.md / README.zh-CN.md).
 *
 * Versions come from live metadata instead of guesswork:
 *   1. Chrome: the Stable channel of Google's Chrome for Testing feed
 *      (last-known-good-versions-with-downloads.json); a version given on
 *      the command line is validated against known-good-versions-with-
 *      downloads.json. The linux64 zip must exist.
 *   2. Node.js (runs the CDP gateway): https://nodejs.org/dist/index.json
 *      lists every release; the script picks the NEWEST LTS major that
 *      satisfies NODE_MIN_MAJOR (production images should ride LTS lines).
 *      Only when no LTS major qualifies does it fall back to the newest
 *      even-numbered major (the next LTS line; odd majors never become LTS).
 *
 * Usage:
 *   node update-chrome-node.mjs                     # pin the latest stable Chrome for Testing
 *   node update-chrome-node.mjs 150.0.7871.100      # pin a specific version
 *   node update-chrome-node.mjs --node 22           # force the Node major
 *   node update-chrome-node.mjs --check             # exit 1 on drift, change nothing
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const CHECK_ONLY = args.includes("--check");
const nodeFlagIdx = args.indexOf("--node");
const FORCED_NODE_MAJOR =
  nodeFlagIdx !== -1 ? parseInt(args[nodeFlagIdx + 1], 10) : null;
const positional = args.filter(
  (a, i) => a && !a.startsWith("--") && i !== nodeFlagIdx + 1,
);
const WANTED_CHROME = positional[0] ?? null;

// The CDP gateway and the CI smoke tests use the global WebSocket client.
const NODE_MIN_MAJOR = 22;
const CFT = "https://googlechromelabs.github.io/chrome-for-testing";
// CfT platform the image builds for (linux/amd64 only).
const PLATFORM = "linux64";

const log = (msg) => console.log(`[update-chrome-node] ${msg}`);
const die = (msg) => {
  console.error(`[update-chrome-node] ERROR: ${msg}`);
  process.exit(1);
};

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { "accept": "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

async function main() {
  // --- 1. which Chrome for Testing version? ---------------------------------
  let entry;
  if (WANTED_CHROME) {
    const all = await fetchJson(
      `${CFT}/known-good-versions-with-downloads.json`,
    ).catch((e) => die(`cannot reach the Chrome for Testing feed: ${e.message}`));
    entry = all.versions.find((v) => v.version === WANTED_CHROME);
    if (!entry) die(`Chrome for Testing ${WANTED_CHROME} is not a known-good version`);
  } else {
    log("resolving the Stable channel from the Chrome for Testing feed ...");
    const lkg = await fetchJson(
      `${CFT}/last-known-good-versions-with-downloads.json`,
    ).catch((e) => die(`cannot reach the Chrome for Testing feed: ${e.message}`));
    entry = lkg.channels?.Stable ?? die("feed has no Stable channel");
  }
  const chromeVersion = entry.version;
  if (!entry.downloads?.chrome?.some((d) => d.platform === PLATFORM))
    die(`Chrome for Testing ${chromeVersion} has no ${PLATFORM} download`);

  // --- 2. which Node major? --------------------------------------------------
  let nodeMajor = FORCED_NODE_MAJOR;
  let nodeSource = "forced via --node";
  if (!nodeMajor) {
    const index = await fetchJson("https://nodejs.org/dist/index.json").catch(
      (e) => die(`cannot reach nodejs.org/dist: ${e.message}`),
    );
    // index.json is newest-first. Collect the majors that have shipped LTS
    // releases (r.lts is false until the line goes LTS), then prefer the
    // newest LTS major >= NODE_MIN_MAJOR; fall back to the newest even
    // major (the upcoming LTS line) when no LTS qualifies.
    const majorOf = (r) => parseInt(r.version.replace(/^v/, "").split(".")[0], 10);
    const ltsMajors = [
      ...new Set(index.filter((r) => r.lts !== false).map(majorOf)),
    ].filter(Number.isInteger);
    const allMajors = [...new Set(index.map(majorOf))].filter(Number.isInteger);
    const pick = (majors) =>
      majors.filter((m) => m >= NODE_MIN_MAJOR).sort((a, b) => b - a)[0] ?? null;
    nodeMajor = pick(ltsMajors) ?? pick(allMajors.filter((m) => m % 2 === 0));
    if (nodeMajor === null)
      die(`no released Node major satisfies >= ${NODE_MIN_MAJOR}`);
    nodeSource = ltsMajors.includes(nodeMajor)
      ? `newest Node LTS major >= ${NODE_MIN_MAJOR}`
      : `no LTS major >= ${NODE_MIN_MAJOR} -> newest even major`;
  }

  log(`chrome for testing ${chromeVersion}`);
  log(`node ${nodeMajor} (${nodeSource})`);

  // --- 3. rewrite the pinned defaults in place -------------------------------
  const rewrites = [
    {
      file: "Dockerfile",
      subs: [
        [/^(ARG CHROME_VERSION=)\S*/m, `$1${chromeVersion}`],
        [/^(ARG NODE_VERSION=)\S*/m, `$1${nodeMajor}`],
      ],
    },
    {
      file: "compose.yaml",
      subs: [
        [
          /^((\s*)CHROME_VERSION: "\$\{CHROME_VERSION:-)[^}]*(\}")$/m,
          `$1${chromeVersion}$3`,
        ],
        [/^((\s*)NODE_VERSION: "\$\{NODE_VERSION:-)[^}]*(\}")$/m, `$1${nodeMajor}$3`],
      ],
    },
    // The README build-arg tables mirror the same defaults (docs are a
    // deliverable); keep them riding along so they cannot drift.
    {
      file: "README.md",
      subs: [
        [/^(\| `CHROME_VERSION` \| `)[^`]+(`)/m, `$1${chromeVersion}$2`],
        [/^(\| `NODE_VERSION` \| `)[^`]+(`)/m, `$1${nodeMajor}$2`],
      ],
    },
    {
      file: "README.zh-CN.md",
      subs: [
        [/^(\| `CHROME_VERSION` \| `)[^`]+(`)/m, `$1${chromeVersion}$2`],
        [/^(\| `NODE_VERSION` \| `)[^`]+(`)/m, `$1${nodeMajor}$2`],
      ],
    },
  ];

  let changed = false;
  for (const { file, subs } of rewrites) {
    const abs = path.join(repoRoot, file);
    let text;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      log(`SKIP ${file} (not found)`);
      continue;
    }
    let next = text;
    for (const [re, replacement] of subs) {
      if (!re.test(next))
        die(`${file}: pattern ${re} not found — update the script`);
      next = next.replace(re, replacement);
    }
    if (next !== text) {
      changed = true;
      if (CHECK_ONLY) {
        log(`DRIFT: ${file} would be updated`);
      } else {
        writeFileSync(abs, next);
        log(`updated ${file}`);
      }
    }
  }
  if (!changed) log("everything already in sync, nothing to do");
  if (CHECK_ONLY && changed)
    die("version drift detected — run: node update-chrome-node.mjs");
}

main().catch((e) => die(e.stack ?? e.message));
