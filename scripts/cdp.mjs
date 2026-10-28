#!/usr/bin/env node
/**
 * Minimal Chrome DevTools Protocol client for driving the real DevHub window.
 *
 * WHY THIS EXISTS
 *   Screenshots were this project's only visual verification and they proved
 *   unreliable: two captures of different builds came out with identical hashes,
 *   `PrintWindow` dropped regions, and a window taller than the work area produced
 *   frames with unsynthesised areas. Three wrong "it is broken" diagnoses came out
 *   of reading those images.
 *
 *   The window is a WebView2 (Chromium), so with
 *   `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port>` it can be
 *   driven and inspected directly: click real controls, read real DOM state, measure
 *   real timing. That is evidence, not a picture of evidence.
 *
 * USAGE
 *   node scripts/cdp.mjs scripts/scenarios/<scenario>.mjs [--port 9222]
 *
 *   A scenario module default-exports `async (cdp) => result`. `cdp.evaluate(js)`
 *   runs `js` as an async function body inside the page and returns the value.
 */

import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const scenarioPath = args.find((a) => !a.startsWith("--"));
const portArg = args.indexOf("--port");
const port = portArg >= 0 ? args[portArg + 1] : process.env.CDP_PORT || "9222";
const dbg = (...a) => {
  if (process.env.CDP_DEBUG) process.stderr.write(`[cdp] ${a.join(" ")}\n`);
};

if (!scenarioPath) {
  console.error("usage: node scripts/cdp.mjs <scenario.mjs> [--port 9222]");
  process.exit(2);
}

async function listTargets() {
  const res = await fetch(`http://127.0.0.1:${port}/json`);
  if (!res.ok) throw new Error(`CDP endpoint returned HTTP ${res.status}`);
  return res.json();
}

/** The app page, not the DevTools front-end or an extension background page. */
function pickPage(targets) {
  const pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
  const app =
    pages.find((t) => /tauri|localhost|127\.0\.0\.1/.test(t.url) && !t.url.startsWith("devtools://")) ??
    pages[0];
  if (!app) throw new Error("no page target found; is the app running with the debug port?");
  return app;
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    const handlers = [];
    let nextId = 1;

    const api = {
      ws,
      send(method, params = {}) {
        const id = nextId++;
        return new Promise((res, rej) => {
          pending.set(id, { res, rej });
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
      onMessage(handler) {
        handlers.push(handler);
      },
    };

    // The message pump has to exist before the first `send`, otherwise the reply
    // to `Runtime.enable` arrives with nothing listening and the promise never
    // settles (observed: the run hung right after "connected").
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
        return;
      }
      for (const handler of handlers) handler(msg);
    });
    ws.addEventListener("open", () => resolve(api));
    ws.addEventListener("error", (e) => reject(new Error(`websocket error: ${e.message ?? e.type}`)));
  });
}

const target = pickPage(await listTargets());
dbg("target", target.url);
const client = await connect(target.webSocketDebuggerUrl);
dbg("connected");

await client.send("Runtime.enable");
await client.send("Page.enable");
dbg("domains enabled");

const consoleErrors = [];
client.onMessage((msg) => {
  if (msg.method === "Runtime.exceptionThrown") {
    consoleErrors.push(msg.params?.exceptionDetails?.text ?? "exception");
  }
  if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
    consoleErrors.push(
      (msg.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" "),
    );
  }
});

// A failure before the verdict is printed (the reload wait below is the one that
// fired 27/27 in a row) used to exit with only "app did not remount" on stderr
// while the page's own exceptions — the actual reason it did not remount — sat
// in `consoleErrors` unprinted. Dump both on any top-level failure; the exit
// code stays 1, so nothing that reads verdicts observes a difference.
// `snaps` carries the page self-description captured at connect and at the
// reload deadline (href/readyState/root), because "no console errors and still
// no [data-skin]" leaves "the target never served the app" indistinguishable
// from "React never committed" without it.
const snaps = {};
const fail = (e) => {
  process.stderr.write(`\n[cdp] ${(e && e.stack) || e}\n`);
  process.stderr.write(`[cdp] target ${target?.url}\n`);
  if (snaps.initial) process.stderr.write(`[cdp] page at connect: ${JSON.stringify(snaps.initial)}\n`);
  if (snaps.preReload) process.stderr.write(`[cdp] page before reload: ${JSON.stringify(snaps.preReload)}\n`);
  if (snaps.afterReload) process.stderr.write(`[cdp] page after reload: ${JSON.stringify(snaps.afterReload)}\n`);
  if (consoleErrors.length) {
    process.stderr.write(`[cdp] page exceptions/console errors (${consoleErrors.length}):\n`);
    for (const line of consoleErrors.slice(-8)) process.stderr.write(`[cdp]   ${line}\n`);
  }
  process.exit(1);
};
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);

const cdp = {
  send: client.send,
  /** Runs `js` as the body of an async function inside the page. */
  async evaluate(js) {
    const result = await client.send("Runtime.evaluate", {
      expression: `(async () => { ${js} })()`,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        `page threw: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
      );
    }
    return result.result?.value;
  },
  /** Reloads the webview and waits for the app to mount again. */
  async reload(settleMs = 3000) {
    await client.send("Page.reload", { ignoreCache: true });
    await new Promise((r) => setTimeout(r, settleMs));
    // After a reload the execution context is replaced, so an evaluate issued too
    // early can fail with "Cannot find context" - retried rather than treated as a
    // failure, because the first reload after a restart is genuinely slower.
    //
    // The deadline follows the machine, not an assertion: this box has 4 cores and
    // routinely sits at 94-100% (concurrent sessions' gates + IDEs), where 30s
    // produced `last value: false` for 27 scenarios in a row while a contended
    // WebView2 was still working through `Page.reload {ignoreCache:true}`. This
    // wait asks "did the app mount at all", never "did it mount fast" — boot speed
    // is measured by boot-state.mjs, not here — and font-source.mjs already allows
    // 60s for the same reason.
    const deadline = Date.now() + 60000;
    let last;
    while (Date.now() < deadline) {
      try {
        last = await cdp.evaluate(`return document.querySelector('[data-skin]') !== null;`);
        if (last) return;
      } catch (e) {
        dbg(`evaluate during reload failed: ${e.message}`);
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    snaps.afterReload = await pageStateSafe();
    throw new Error(`app did not remount after reload (last value: ${JSON.stringify(last)})`);
  },
  /** Waits until `js` returns truthy, or throws. */
  async waitFor(js, { timeoutMs = 15000, everyMs = 150, label = "condition" } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      last = await cdp.evaluate(`return ${js};`);
      if (last) return last;
      await new Promise((r) => setTimeout(r, everyMs));
    }
    throw new Error(`timed out waiting for ${label} (last value: ${JSON.stringify(last)})`);
  },
  consoleErrors,
  target: { url: target.url, title: target.title },
};

/** What the page actually is right now — failure evidence only, never an assertion. */
const pageStateSafe = async () => {
  try {
    return await cdp.evaluate(`
      return {
        href: location.href,
        ready: document.readyState,
        skin: document.querySelector('[data-skin]') !== null,
        rootLen: document.getElementById('root')?.innerHTML.length ?? -1,
        title: document.title,
      };
    `);
  } catch (e) {
    return { evalError: e.message };
  }
};
snaps.initial = await pageStateSafe();

// Mount first, reload second. The harness's ready check answers on the debug
// port the moment WebView2's browser process starts — before this window's
// initial navigation to the dev URL has committed. Reloading in that window
// cancels the pending navigation, and a reload of about:blank reloads nothing:
// the app then never arrives at all, which is exactly what 27 scenarios in a
// row measured (`page at connect: about:blank`, `page after reload:
// about:blank`, zero console errors). So: if the app is not mounted yet,
// navigate explicitly (retrying while the document is still blank or on an
// error page — on a warm restart the window can come up before vite binds),
// and only once [data-skin] exists does the scenario's reload run against a
// real document.
if (!snaps.initial.skin) {
  if (snaps.initial.href === "about:blank") {
    dbg("window still on about:blank — issuing the initial navigation");
    await client.send("Page.navigate", { url: target.url }).catch(() => {});
  }
  const mountDeadline = Date.now() + 60000;
  let mounted = false;
  while (Date.now() < mountDeadline) {
    const st = await pageStateSafe();
    snaps.preReload = st;
    if (st.skin) {
      mounted = true;
      break;
    }
    const href = st.href ?? "";
    if (href === "about:blank" || href.startsWith("chrome-error") || href.startsWith("data:")) {
      await client.send("Page.navigate", { url: target.url }).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!mounted) {
    throw new Error(`app never mounted before the scenario (state: ${JSON.stringify(snaps.preReload)})`);
  }
}

if (args.includes("--reload")) {
  dbg("reloading page");
  await cdp.reload();
  dbg("page reloaded");
}

let output;
try {
  const mod = await import(pathToFileURL(scenarioPath).href);
  dbg("scenario imported");
  if (typeof mod.default !== "function") {
    throw new Error(`${scenarioPath} must default-export an async function`);
  }
  output = await mod.default(cdp);
  dbg("scenario finished");
} finally {
  try {
    client.ws.close();
  } catch {
    /* already closed */
  }
}

console.log(JSON.stringify(output, null, 2));

// Propagate the verdict. The WebSocket keeps the event loop alive, so the work is
// done and we must exit — but "the print happened" was never "the fix passed": the
// old unconditional `process.exit(0)` meant a scenario whose report said
// `"verdict": "FAIL"` still exited 0, so anything that trusts exit codes (CI, a
// wrapper, `&&`) read a failed scenario as success. Exit 1 when a verdict is
// present and is not PASS (FAIL / TIMEOUT / SKIP are all "did not pass"); a report
// with no verdict key ran fine and just asserts nothing, so it stays 0. A scenario
// that THROWS already exits 1 — the rejected top-level await is never reached here.
const verdict = output && typeof output === "object" ? output.verdict : undefined;
if (typeof verdict === "string" && verdict !== "PASS") {
  dbg(`verdict ${verdict} — exiting 1`);
  process.exit(1);
}
process.exit(0);
