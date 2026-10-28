/**
 * Renderer idle-cost sampler over the Chrome DevTools Protocol (r20-R3-2).
 *
 * ## Why a sampler and not a screenshot
 *
 * `docs/r3-webview2-perf.md` (round 18 R3) added three Chromium switches to
 * `windows[].additionalBrowserArgs` and closed with an honest gap: 「需在低内存机器上实测
 * 后台占用」. Nobody measured it, because nothing in the gate could measure it — the app's
 * own CDP harness (`scripts/cdp.mjs`, `scripts/scenarios/*.mjs`) asserts *DOM state*, which
 * is the right instrument for behaviour and the wrong one for cost. This script is the
 * missing instrument: it attaches to an already-running WebView2 that was started with
 * `--remote-debugging-port`, asks `Performance.getMetrics` on a interval, and writes the
 * series out.
 *
 * ## Tri-state, like every other checker here
 *
 *   0  a series was collected
 *   1  an endpoint exists but the DevHub page was not found in it
 *   2  no endpoint could be reached at all — *not* a failure of the app, and deliberately
 *      not reported as one. Nothing here is greened by the absence of a measurement.
 *
 * ## How to get a 0
 *
 *   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
 *   $env:DEVHUB_PROJECT_ROOT = "<repo>\.cdpfixtures"
 *   src-tauri\target\debug\devhub-app.exe        # or `pnpm tauri dev`
 *   node scripts/render-perf.mjs --port 9222 --samples 10
 *
 * Dependency-free by rule: node:http and the global WebSocket that Node 22 provides
 * (`node --version` here reports v22.19.0; `tests/` already rely on that runtime).
 */
import { request } from "node:http";

const argv = process.argv.slice(2);
const opts = { host: "127.0.0.1", port: 9222, samples: 8, intervalMs: 1500, out: null, match: "devhub" };
for (let i = 0; i < argv.length; i++) {
  const flag = argv[i];
  const next = () => argv[++i];
  if (flag === "--port") opts.port = Number(next());
  else if (flag === "--host") opts.host = next();
  else if (flag === "--samples") opts.samples = Number(next());
  else if (flag === "--interval") opts.intervalMs = Number(next());
  else if (flag === "--out") opts.out = next();
  else if (flag === "--match") opts.match = next();
  else {
    console.error(
      `render-perf.mjs: unrecognised argument '${flag}' (accepted: --host --port --samples --interval --out --match)`,
    );
    process.exit(2);
  }
}
for (const key of ["port", "samples", "intervalMs"]) {
  if (!Number.isFinite(opts[key]) || opts[key] <= 0) {
    console.error(`render-perf.mjs: --${key} wants a positive number, got '${opts[key]}'`);
    process.exit(2);
  }
}

function getJson(path) {
  return new Promise((resolve, reject) => {
    const req = request({ host: opts.host, port: opts.port, path, method: "GET", timeout: 2500 }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(text));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    req.end();
  });
}

/** One CDP command/response over the page's WebSocket, with the id bookkeeping done. */
function cdpConnect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const waiting = new Map();
    ws.addEventListener("open", () =>
      resolve({
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const myId = ++id;
            waiting.set(myId, { res, rej });
            ws.send(JSON.stringify({ id: myId, method, params }));
          });
        },
        close: () => ws.close(),
      }),
    );
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && waiting.has(msg.id)) {
        const { res, rej } = waiting.get(msg.id);
        waiting.delete(msg.id);
        if (msg.error) rej(new Error(`${msg.error.code}: ${msg.error.message}`));
        else res(msg.result);
      }
    });
    ws.addEventListener("error", () => reject(new Error("websocket failed")));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let targets;
try {
  targets = await getJson("/json/list");
} catch (e) {
  console.error(`CANNOT DECIDE  no CDP endpoint at http://${opts.host}:${opts.port} (${e.message})`);
  console.error("  start the app with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port and re-run.");
  process.exit(2);
}

const page = targets.find(
  (t) => t.type === "page" && (`${t.title} ${t.url}`.toLowerCase().includes(opts.match.toLowerCase())),
);
if (!page?.webSocketDebuggerUrl) {
  console.error(`FAIL  endpoint answered with ${targets.length} target(s), none matching '${opts.match}'`);
  for (const t of targets.slice(0, 6)) console.error(`  - ${t.type} ${t.title || t.url}`);
  process.exit(1);
}

const cdp = await cdpConnect(page.webSocketDebuggerUrl);
await cdp.send("Page.enable");
await cdp.send("Runtime.enable");
await cdp.send("Performance.enable");

// r21-O2-1: Documents/LayoutObjects joined the set — the idle series has to cover
// documents and layout, and LayoutObjects is where a layout-on-every-poll regression
// would show up even when the node count looks flat.
const WANTED = ["JSHeapUsedSize", "JSHeapTotalSize", "Documents", "Nodes", "LayoutObjects", "Listeners"];
const samples = [];
console.log(`render-perf — page "${page.title}" (${page.url})`);
console.log("sample  " + WANTED.map((w) => w.padStart(16)).join("") + "   dialogs  tiles");
for (let i = 0; i < opts.samples; i++) {
  const { metrics } = await cdp.send("Performance.getMetrics");
  const pick = Object.fromEntries(
    WANTED.map((name) => [name, metrics.find((m) => m.name === name)?.value ?? null]),
  );
  // DOM counts come from the page itself: `Nodes` is the *document's* node count as
  // Chromium sees it, which is the number the wall's windowing (r20-O1-1) actually moves.
  const probe = await cdp.send("Runtime.evaluate", {
    expression:
      "JSON.stringify({tiles: document.querySelectorAll('[data-layer=\"repo-tile\"], .repo-grid > *').length, dialogs: document.querySelectorAll('[role=\"dialog\"]').length, inert: document.querySelectorAll('[inert]').length})",
    returnByValue: true,
  });
  const dom = JSON.parse(probe?.result?.value ?? "{}");
  samples.push({ at: new Date().toISOString(), ...pick, ...dom });
  console.log(
    `${String(i).padStart(6)}  ` +
      WANTED.map((w) => String(Math.round(pick[w] ?? 0)).padStart(16)).join("") +
      `   ${String(dom.dialogs ?? 0).padStart(7)} ${String(dom.tiles ?? 0).padStart(5)}`,
  );
  if (i < opts.samples - 1) await sleep(opts.intervalMs);
}
cdp.close();

const first = samples[0];
const last = samples[samples.length - 1];
const drift = Math.max(0, (last.JSHeapUsedSize ?? 0) - (first.JSHeapUsedSize ?? 0));
console.log("");
console.log(`heap drift over ${samples.length} samples: ${Math.round(drift).toLocaleString()} bytes`);
console.log(`node range: ${Math.min(...samples.map((s) => s.Nodes))} … ${Math.max(...samples.map((s) => s.Nodes))}`);
console.log(`listener range: ${Math.min(...samples.map((s) => s.Listeners))} … ${Math.max(...samples.map((s) => s.Listeners))}`);
// r21-O2-1: median/peak per metric, so a run's summary (not just its endpoints) can be
// quoted without re-deriving it by hand in the write-up.
for (const name of ["JSHeapUsedSize", "Documents", "LayoutObjects"]) {
  const values = samples.map((s) => s[name]).filter((v) => v != null).sort((a, b) => a - b);
  if (values.length) {
    const median = values[Math.floor(values.length / 2)];
    console.log(`${name}: median ${median} / peak ${values[values.length - 1]}`);
  }
}

if (opts.out) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(opts.out, JSON.stringify({ page: page.url, targetUrl: page.url, samples }, null, 2));
  console.log(`wrote ${opts.out}`);
}
