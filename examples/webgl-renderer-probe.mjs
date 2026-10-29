// webgl-renderer-probe.mjs — zero-dependency CDP probe: asks the RUNNING
// browser what its WebGL renderer is, and dumps the "Graphics Feature
// Status" block of chrome://gpu. Usage:
//   node webgl-renderer-probe.mjs [host] [port]   (defaults 127.0.0.1 9221)
import net from "node:net";
import http from "node:http";
import crypto from "node:crypto";

const HOST = process.argv[2] || "127.0.0.1";
const PORT = parseInt(process.argv[3] || "9221", 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => { console.error("probe: timeout"); process.exit(2); }, 25000);

// --- minimal websocket client -------------------------------------------------
function wsConnect(path) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString("base64");
    const sock = net.connect(PORT, HOST, () => {
      sock.write(
        `GET ${path} HTTP/1.1\r\nHost: ${HOST}:${PORT}\r\nUpgrade: websocket\r\n` +
        `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let buf = Buffer.alloc(0), hs = false, pend = [];
    const onMsg = [];
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (!hs) {
        const i = buf.indexOf("\r\n\r\n");
        if (i < 0) return;
        if (!buf.slice(0, i).toString().includes("101")) return reject(new Error("ws handshake failed"));
        buf = buf.slice(i + 4); hs = true; resolve(api);
      }
      for (;;) {
        if (buf.length < 2) break;
        const fin = buf[0] & 0x80, op = buf[0] & 0x0f;
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) break;
        const payload = buf.slice(off, off + len); buf = buf.slice(off + len);
        if (op === 0x1 || op === 0x0) {
          pend.push(payload);
          if (fin) { const msg = JSON.parse(Buffer.concat(pend).toString()); pend = []; onMsg.forEach((f) => f(msg)); }
        }
      }
    });
    sock.on("error", reject);
    let id = 0;
    const api = {
      send: (method, params = {}) =>
        new Promise((res) => {
          const mid = ++id;
          const f = (m) => { if (m.id === mid) { onMsg.splice(onMsg.indexOf(f), 1); res(m); } };
          onMsg.push(f);
          const json = Buffer.from(JSON.stringify({ id: mid, method, params }));
          const mask = crypto.randomBytes(4);
          let head;
          if (json.length < 126) head = Buffer.from([0x81, 0x80 | json.length]);
          else { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 0x80 | 126; head.writeUInt16BE(json.length, 2); }
          const masked = Buffer.from(json);
          for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
          sock.write(Buffer.concat([head, mask, masked]));
        }),
      close: () => sock.end(),
    };
  });
}

// --- HTTP json helper ----------------------------------------------------------
const getJson = (path) => new Promise((res, rej) =>
  http.get({ host: HOST, port: PORT, path }, (r) => {
    let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => res(JSON.parse(b)));
  }).on("error", rej));

// Probe in a throwaway background tab: navigating an existing page target
// would hijack whatever the user (or an automation client) has open there.
const ver = await getJson("/json/version");
const bws = await wsConnect(new URL(ver.webSocketDebuggerUrl).pathname);
const created = await bws.send("Target.createTarget", { url: "about:blank", background: true });
const targetId = created.result?.targetId;
if (!targetId) { console.error("cannot create probe target:", JSON.stringify(created.error ?? created)); process.exit(1); }
console.log(`target: probe tab ${targetId}`);
const cdp = await wsConnect(`/devtools/page/${targetId}`);

// 1) WebGL renderer in the live page
const r1 = await cdp.send("Runtime.evaluate", {
  returnByValue: true,
  expression: `(() => {
    const c = document.createElement('canvas');
    const g = c.getContext('webgl') || c.getContext('experimental-webgl');
    if (!g) return 'WEBGL: UNAVAILABLE';
    const e = g.getExtension('WEBGL_debug_renderer_info');
    const rend = e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER);
    const vend = e ? g.getParameter(e.UNMASKED_VENDOR_WEBGL) : g.getParameter(g.VENDOR);
    return 'WEBGL vendor=' + vend + ' renderer=' + rend;
  })()`,
});
console.log(r1.result?.result?.value ?? JSON.stringify(r1.result?.exceptionDetails?.exception?.description ?? r1));

// 2) chrome://gpu full text: Graphics Feature Status + Problems Detected
await cdp.send("Page.navigate", { url: "chrome://gpu/" });
await sleep(4000);
const r2 = await cdp.send("Runtime.evaluate", {
  returnByValue: true,
  // chrome://gpu renders into shadow roots, which body.innerText skips
  expression: `(() => {
    const kids = (r) => [...r.children].filter((c) => !/^(STYLE|SCRIPT)$/.test(c.tagName));
    const walk = (n) => n.shadowRoot
      ? kids(n.shadowRoot).map(walk).join('\\n')
      : (kids(n).some((c) => c.shadowRoot) ? kids(n).map(walk).join('\\n') : (n.innerText || ''));
    return walk(document.body).trim().slice(0, 3500);
  })()`,
});
console.log("--- chrome://gpu ---");
console.log(r2.result?.result?.value || "(empty)");

// 3) authoritative source: browser-level SystemInfo.getInfo — the very data
//    chrome://gpu renders (featureStatus map + detected problems)
try {
  const si = await bws.send("SystemInfo.getInfo");
  const g = si.result?.gpu ?? {};
  console.log("--- SystemInfo gpu ---");
  console.log("glRenderer:", g.auxAttributes?.glRenderer ?? "n/a");
  console.log("featureStatus:", JSON.stringify(g.featureStatus ?? g.features ?? {}, null, 1).slice(0, 1200));
  if (g.problems?.length) {
    console.log("problems:");
    for (const p of g.problems.slice(0, 6)) console.log(" -", p.description ?? JSON.stringify(p).slice(0, 200));
  } else {
    console.log("problems: none");
  }
} catch (e) {
  console.log("SystemInfo unavailable:", e.message);
}
cdp.close();
await bws.send("Target.closeTarget", { targetId });
bws.close();
process.exit(0);
