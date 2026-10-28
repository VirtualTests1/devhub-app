/**
 * `process://update` receiver — one full snapshot, merged without re-basing clocks.
 *
 * The Rust side is tested in `src-tauri/src/process_events.rs`; this file pins the
 * webview half: a payload is a complete `live_processes` answer, a clock-only row
 * keeps its old object, absent pids are gone, malformed payloads leave the poll's
 * last answer alone, and the listener is removable (including before it resolves).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  applyProcessUpdate,
  mergeProcessUpdates,
  subscribeProcessUpdates,
  useProcesses,
} from "../src/store/processes.ts";
import type { ProcessState } from "../src/types.ts";

const proc = (over: Partial<ProcessState> = {}): ProcessState => ({
  pid: 4000,
  label: "npm run dev",
  slug: "github.com/a/b",
  state: "running",
  exitCode: null,
  elapsedMs: 1000,
  stoppable: true,
  suspendable: true,
  ...over,
});

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const APP = readFileSync("src/App.tsx", "utf8").replace(/\r\n/g, "\n");

type Handler = (event: { payload: unknown }) => void;
type InvokeArgs = { event?: string; handler?: number; eventId?: number };

let callbacks = new Map<number, Handler>();
let registered: { event: string; handler: number }[] = [];
let unregistered: number[] = [];
let nextCallback = 1;
let nextEventId = 1;
let gate: Promise<void> | null = null;

function installTauri() {
  callbacks = new Map();
  registered = [];
  unregistered = [];
  nextCallback = 1;
  nextEventId = 1;
  gate = null;
  (globalThis as unknown as { window: unknown }).window = {
    __TAURI_INTERNALS__: {
      transformCallback(callback: Handler) {
        const id = nextCallback;
        nextCallback += 1;
        callbacks.set(id, callback);
        return id;
      },
      async invoke(cmd: string, args: InvokeArgs = {}) {
        if (cmd === "plugin:event|listen") {
          if (gate !== null) await gate;
          registered.push({ event: String(args.event), handler: Number(args.handler) });
          const eventId = nextEventId;
          nextEventId += 1;
          return eventId;
        }
        if (cmd === "plugin:event|unlisten") {
          unregistered.push(Number(args.eventId));
        }
        return null;
      },
    },
    __TAURI_EVENT_PLUGIN_INTERNALS__: {
      unregisterListener() {},
    },
  };
}

function dispatch(payload: unknown) {
  const subscription = registered[registered.length - 1];
  assert.ok(subscription, "the listener must be registered before dispatching");
  const callback = callbacks.get(subscription.handler);
  assert.ok(callback, "transformCallback must have stored the handler");
  callback({ payload });
}

test("mergeProcessUpdates keeps the old row when only the clock moved", () => {
  const old = proc({ pid: 1, elapsedMs: 1000 });
  const current = [old];

  const merged = mergeProcessUpdates(current, [proc({ pid: 1, elapsedMs: 9000 })]);

  assert.equal(merged, current, "a clock-only snapshot must not replace the store array");
  assert.equal(merged[0], old, "the row object carries the elapsed baseline");
});

test("mergeProcessUpdates orders by pid, keeps unchanged rows, drops absent pids", () => {
  const unchanged = proc({ pid: 2 });
  const changed = proc({ pid: 1, label: "new label" });
  const added = proc({ pid: 3 });

  const merged = mergeProcessUpdates(
    [unchanged, proc({ pid: 1, label: "old label" })],
    [added, changed, proc({ pid: 2 })],
  );

  assert.deepEqual(
    merged.map((p) => p.pid),
    [1, 2, 3],
  );
  assert.equal(merged[0], changed, "a changed row is replaced by the incoming object");
  assert.equal(merged[1], unchanged, "an unchanged row keeps its identity");
  assert.equal(merged[2], added, "a new row uses the incoming object");
});

test("applyProcessUpdate ignores malformed payloads wholesale and clears on []", () => {
  useProcesses.setState({ live: [proc({ pid: 1 })] });

  applyProcessUpdate({});
  assert.equal(useProcesses.getState().live.length, 1);

  applyProcessUpdate([proc({ pid: 1 }), { pid: 2 }]);
  assert.equal(useProcesses.getState().live.length, 1, "one bad row rejects the snapshot");

  applyProcessUpdate([]);
  assert.deepEqual(useProcesses.getState().live, [], "an empty snapshot means nothing is running");

  applyProcessUpdate([proc({ pid: 5 })]);
  assert.deepEqual(
    useProcesses.getState().live.map((p) => p.pid),
    [5],
  );
});

test("subscribeProcessUpdates listens for process://update and unlistens on cleanup", async () => {
  useProcesses.setState({ live: [] });
  installTauri();

  const cleanup = subscribeProcessUpdates();
  await flush();
  assert.equal(registered.length, 1);
  assert.equal(registered[0]?.event, "process://update");

  dispatch([proc({ pid: 2 }), proc({ pid: 1 })]);
  assert.deepEqual(
    useProcesses.getState().live.map((p) => p.pid),
    [1, 2],
  );

  cleanup();
  await flush();
  assert.deepEqual(unregistered, [1]);
});

test("unmounting before listen resolves unlistens the late subscription", async () => {
  useProcesses.setState({ live: [] });
  installTauri();
  let release: () => void = () => {};
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const cleanup = subscribeProcessUpdates();
  cleanup();
  release();
  await flush();

  assert.deepEqual(unregistered, [1], "a late listen must not outlive its component");
  assert.equal(registered.length, 1);
});

test("App mounts the subscription once and runs its cleanup on unmount", () => {
  assert.match(APP, /import \{[^}]*subscribeProcessUpdates[^}]*\} from "\.\/store\/processes"/);
  assert.match(APP, /const unProcesses = subscribeProcessUpdates\(\);/);
  assert.match(APP, /unProcesses\(\);/);
});
