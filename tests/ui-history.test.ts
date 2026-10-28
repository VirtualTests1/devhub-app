/**
 * `src/store/ui.ts` — the shell's navigation state machine.
 *
 * The history stack is the reason 后退 behaves like a browser, and the doc
 * comment on `go()` records the exact bug this test now guards: appending the
 * current destination instead of *replacing* the entry at the pointer left a
 * duplicate behind, so 后退 had to be pressed twice to move one page.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  VIEW_LABEL,
  registerViewContext,
  useUI,
  type ViewId,
} from "../src/store/ui.ts";

import { at } from "./helpers/definite.ts";

const reset = () => {
  useUI.setState({ view: "projects", history: [{ view: "projects" }], pointer: 0 });
};

beforeEach(reset);

test("starts on 项目 with a single-entry stack", () => {
  const s = useUI.getState();
  assert.equal(s.view, "projects");
  assert.equal(s.history.length, 1);
  assert.equal(s.pointer, 0);
});

test("go() replaces the entry under the pointer rather than appending", () => {
  const s = useUI.getState();
  s.go("add");
  const after = useUI.getState();
  assert.equal(after.view, "add");
  assert.equal(after.pointer, 1);
  assert.deepEqual(
    after.history.map((d) => d.view),
    ["projects", "add"],
    "one navigation must push exactly one destination",
  );
  // The regression this encodes: with an append, history would be
  // ["projects","projects","add"] and 后退 would look like a no-op.
  useUI.getState().go("add");
  assert.equal(useUI.getState().history.length, 2, "navigating to the current view pushes nothing");
});

test("a navigation after 后退 discards the forward branch", () => {
  useUI.getState().go("add");
  useUI.getState().go("settings");
  useUI.getState().back();
  assert.equal(useUI.getState().view, "add");
  assert.equal(useUI.getState().pointer, 1);

  useUI.getState().go("records");
  const s = useUI.getState();
  assert.deepEqual(
    s.history.map((d) => d.view),
    ["projects", "add", "records"],
    "the abandoned 设置 must not stay reachable via 前进",
  );
  assert.equal(s.pointer, 2);
});

test("back()/forward() clamp at the ends of the stack", () => {
  useUI.getState().back();
  assert.equal(useUI.getState().pointer, 0);
  assert.equal(useUI.getState().view, "projects");

  useUI.getState().go("frequent");
  useUI.getState().forward();
  assert.equal(useUI.getState().pointer, 1);
  assert.equal(useUI.getState().view, "frequent");
});

test("setView changes the page without pushing a history entry", () => {
  // The status strip's "jump to the setting that owns this card" is a side
  // effect, not a user navigation — if it pushed, the 后退 button would start
  // collecting stops the user never made.
  useUI.getState().setView("settings");
  const s = useUI.getState();
  assert.equal(s.view, "settings");
  assert.equal(s.history.length, 1, "no destination was pushed");
  assert.equal(s.pointer, 0, "and the pointer did not move");
  // r15-correct-7: the entry it *did* rewrite must name the page now on screen,
  // or every later snapshot files one page's ctx under another page's name.
  assert.equal(at(s.history, 0).view, "settings");
});

test("a mounted view's context is captured when the user leaves it", () => {
  let snapshotValue: Record<string, unknown> = { filter: "running", sort: "size" };
  const applied: Record<string, unknown>[] = [];
  const unregister = registerViewContext("projects", {
    get: () => snapshotValue,
    apply: (ctx) => applied.push(ctx),
  });

  useUI.getState().go("add");
  assert.deepEqual(at(useUI.getState().history, 0).ctx, { filter: "running", sort: "size" });

  // 后退 hands the snapshot to the bridge when the view re-registers, and the
  // pending handoff covers the case where it has not mounted yet.
  useUI.getState().back();
  assert.equal(useUI.getState().view, "projects");
  const reRegister = registerViewContext("projects", {
    get: () => snapshotValue,
    apply: (ctx) => applied.push(ctx),
  });
  // Indexed rather than `.at(-1)`: `lib` is `ES2020` here (`tsconfig.json`), so the
  // ES2022 method is outside the compiler's view — and the tests project mirrors it
  // on purpose instead of relaxing the bar.
  assert.deepEqual(applied[applied.length - 1], { filter: "running", sort: "size" });
  reRegister();
  unregister();
});

test("an unregistered view keeps no context instead of throwing", () => {
  // "history works for all six views the day it lands" only holds if a view that
  // never mounted a bridge is a plain no-op rather than a crash.
  useUI.getState().go("frequent");
  useUI.getState().back();
  assert.equal(useUI.getState().view, "projects");
  assert.equal(at(useUI.getState().history, 0).ctx, undefined);
});

test("registerViewContext's cleanup only removes its own bridge", () => {
  const a = registerViewContext("records", { get: () => ({ n: 1 }), apply: () => {} });
  const b = registerViewContext("records", { get: () => ({ n: 2 }), apply: () => {} });
  a();
  useUI.getState().go("records");
  useUI.getState().back();
  useUI.getState().forward();
  assert.equal(useUI.getState().view, "records");
  b();
});

test("VIEW_LABEL answers for every route in ViewId", () => {
  // `ViewId` was narrowed to five members in round 9 (需求 10) by deleting
  // `appearance`; a record that still carries the old key would be dead weight,
  // and one missing a live key renders a blank sidebar item.
  const views: ViewId[] = ["projects", "add", "settings", "records", "frequent"];
  assert.deepEqual(Object.keys(VIEW_LABEL).sort(), [...views].sort());
  for (const v of views) assert.ok(VIEW_LABEL[v].length > 0);
});

// ---------------------------------------------------------------------------
// r15-correct-7 — the history invariant: `history[pointer]` names the page on
// screen, and its `ctx` belongs to that page.
//
// `setView` changed `view` and left the entry under the pointer naming the page
// the user had just left. Every snapshot after that wrote the *new* page's ctx
// into the *old* page's entry, and because the ctx keys collide across views
// (`sort`, `filter`) 后退/前进 handed one page another page's sort and filter —
// quietly, and only once the user had navigated. `forward()` also never
// snapshotted, so a page you stepped away from with 前进 lost its edits while
// the same edit survived a 后退.
// ---------------------------------------------------------------------------

/** A bridge whose snapshot the test can move, because a real page's ctx changes. */
function liveBridge(ctx: Record<string, unknown>) {
  const current = { ...ctx };
  const applied: Record<string, unknown>[] = [];
  return {
    ctx: current,
    applied,
    bridge: { get: () => ({ ...current }), apply: (c: Record<string, unknown>) => applied.push(c) },
  };
}

test("the entry under the pointer always names the view on screen", () => {
  useUI.getState().go("records");
  assert.equal(at(useUI.getState().history, useUI.getState().pointer).view, useUI.getState().view);

  useUI.getState().setView("settings");
  const s = useUI.getState();
  assert.equal(s.view, "settings");
  assert.equal(
    at(s.history, s.pointer).view,
    "settings",
    "a side-effect jump is still a jump: the entry has to follow it",
  );

  useUI.getState().go("frequent");
  const t = useUI.getState();
  assert.equal(at(t.history, t.pointer).view, "frequent");
  // The page that was left behind kept its own name, and gained no foreign ctx.
  assert.equal(at(t.history, t.pointer - 1).view, "settings");
});

test("前进 restores a page with its OWN sort/filter context, not its neighbour's", () => {
  // The regression, end to end. 项目 owns `sort`; so does the page the status strip
  // side-effect-jumped to. Same key, different page — the collision that used to
  // make 后退 paint one page with another's context.
  const projects = liveBridge({ sort: "size" });
  const unProjects = registerViewContext("projects", projects.bridge);

  useUI.getState().go("add"); // leaves 项目, snapshotting {sort:"size"} into entry 0
  const add = liveBridge({ sort: "recent" });
  const unAdd = registerViewContext("add", add.bridge);

  useUI.getState().setView("settings"); // the strip's "跳到对应设置", not a user navigation
  const settings = liveBridge({ sort: "updated" });
  const unSettings = registerViewContext("settings", settings.bridge);

  useUI.getState().back(); // 设置 -> 项目, because the stack started on 项目
  assert.equal(useUI.getState().view, "projects");

  useUI.getState().forward(); // 项目 -> the entry at 1, which 设置 now owns

  const after = useUI.getState();
  assert.equal(after.view, "settings", "前进 goes back to the page that was there, not to 添加");
  assert.equal(at(after.history, after.pointer).view, "settings");
  assert.deepEqual(
    at(after.history, after.pointer).ctx,
    { sort: "updated" },
    "and the entry carries the settings page's own sort, never 添加's",
  );

  // Re-mounting the destination's bridge is what applies a restored context.
  const restored = liveBridge({});
  const unRestored = registerViewContext("settings", restored.bridge);
  assert.deepEqual(
    restored.applied[restored.applied.length - 1],
    { sort: "updated" },
    "the settings page must come back with the settings context it left with",
  );
  unRestored();
  unSettings();
  unAdd();
  unProjects();
});

test("前进 snapshots the page it leaves, the way 后退 already did", () => {
  const projects = liveBridge({ filter: "running" });
  const unProjects = registerViewContext("projects", projects.bridge);
  const add = liveBridge({ query: "abc" });

  useUI.getState().go("add");
  useUI.getState().back(); // -> 项目
  assert.deepEqual(
    at(useUI.getState().history, 0).ctx,
    { filter: "running" },
    "后退 stored the page's state on the way out",
  );

  // The user re-arranges the page, then presses 前进 instead of 后退.
  projects.ctx.filter = "stopped";
  const unAdd = registerViewContext("add", add.bridge);
  useUI.getState().forward();
  assert.equal(useUI.getState().view, "add");
  assert.deepEqual(
    at(useUI.getState().history, 0).ctx,
    { filter: "stopped" },
    "the page left behind via 前进 must carry the edits made on it",
  );

  useUI.getState().back();
  const fresh = liveBridge({});
  const unFresh = registerViewContext("projects", fresh.bridge);
  assert.deepEqual(
    fresh.applied[fresh.applied.length - 1],
    { filter: "stopped" },
    "and 后退 from there must bring them back, not the state from before 前进",
  );
  unFresh();
  unAdd();
  unProjects();
});

test("a setView jump does not donate the old page's ctx to the new view", () => {
  const settings = liveBridge({ section: "network" });
  const unSettings = registerViewContext("settings", settings.bridge);
  useUI.getState().setView("settings");
  assert.equal(at(useUI.getState().history, 0).view, "settings", "the entry followed the jump");

  const projects = liveBridge({ section: "git" });
  const unProjects = registerViewContext("projects", projects.bridge);
  useUI.getState().setView("projects");
  const s1 = useUI.getState();
  assert.equal(at(s1.history, s1.pointer).view, "projects");
  assert.equal(
    at(s1.history, s1.pointer).ctx,
    undefined,
    "a side-effect jump stores no context at all — storing the settings one under 项目's name is the bug",
  );

  // The first *user* navigation after the jump snapshots the page being left into
  // the entry that names it, so 项目 comes back with 项目's own `section`.
  useUI.getState().go("records");
  assert.deepEqual(at(useUI.getState().history, 0).ctx, { section: "git" });

  useUI.getState().back();
  const restored = liveBridge({});
  const unRestored = registerViewContext("projects", restored.bridge);
  assert.deepEqual(restored.applied[restored.applied.length - 1], { section: "git" });
  unRestored();
  unProjects();
  unSettings();
});

test("an entry dropped by setView does not survive as somebody else's context", () => {
  // A restored session whose pointer entry names a page the user is no longer on
  // must not be trusted: the view wins, and the stale ctx goes with the old name.
  useUI.setState({ view: "records", history: [{ view: "projects", ctx: { sort: "size" } }], pointer: 0 });
  useUI.getState().setView("projects");
  assert.equal(at(useUI.getState().history, 0).view, "projects");
  assert.deepEqual(at(useUI.getState().history, 0).ctx, undefined);

  useUI.getState().go("settings");
  const s = useUI.getState();
  assert.equal(at(s.history, 0).view, "projects");
  assert.equal(at(s.history, 0).ctx, undefined, "a context nobody snapshotted is not invented");
});
