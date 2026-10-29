// Minimal example: drive the containerized Chromium from your own machine
// over the CDP endpoint (host port 9222 by default).
//
//   npm init -y && npm i playwright      # no browsers needed locally
//   docker compose up -d                 # in this repo
//   node examples/connect-playwright.mjs https://example.com
//
// The browser runs HEADED on the container's Xvfb desktop by default, so you
// can watch this visit live in the Selkies stream (http://localhost:8080).

import { chromium } from "playwright";

const url = process.argv[2] ?? "https://example.com";
const endpoint = process.env.CDP_ENDPOINT ?? "http://localhost:9222";

const browser = await chromium.connectOverCDP(endpoint);
console.log(`connected to ${endpoint} -> ${browser.version()}`);

// Reuse the browser's default context (and its open tab) instead of
// creating a new one — the profile persists across restarts.
const context = browser.contexts()[0];
const page = context.pages()[0] ?? (await context.newPage());

await page.goto(url, { waitUntil: "domcontentloaded" });
console.log(`title: ${await page.title()}`);
console.log(`language: ${await page.evaluate(() => navigator.language)}`);

await browser.close(); // closes the CDP session, not the browser
