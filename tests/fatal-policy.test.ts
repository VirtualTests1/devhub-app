/**
 * `src/lib/fatal-policy.ts` — when a rejection may destroy the app, and when it
 * may only say something.
 *
 * The bug these pin (round 12, 让失败可见 8.1): `main.tsx` wired
 * `window.addEventListener("unhandledrejection", …)` straight to the fatal
 * overlay, and the overlay's first statement is `root.innerHTML = ""`. Any
 * missing `.catch` in the app therefore replaced a running window with a stack
 * dump — no dedupe, no recovery. The fix keeps the overlay for boot and routes
 * post-boot rejections to the app's own toast surface, so the two rules worth
 * testing are *which phase* and *have we already shown this exact reason*.
 *
 * No DOM, no timer, no toast host: `decideFatal` takes `now` and `seen` as
 * arguments, which is the only reason it can be tested at all under
 * `node --experimental-strip-types`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEDUPE_MS,
  decideFatal,
  rejectionKey,
  rememberFatal,
} from "../src/lib/fatal-policy.ts";

const T0 = 1_700_000_000_000;

/** Runs the decision the way `main.tsx` does, so the dedupe state carries over. */
function drive(
  reasons: unknown[],
  { phase = "running" as const, stepMs = 0 }: { phase?: "boot" | "running"; stepMs?: number } = {},
) {
  let seen = new Map<string, number>();
  const actions: string[] = [];
  reasons.forEach((reason, i) => {
    const now = T0 + i * stepMs;
    const verdict = decideFatal({ reason, phase, now, seen });
    actions.push(verdict.action);
    if (verdict.action !== "skip") seen = rememberFatal(seen, verdict.key, now);
  });
  return { actions, seen };
}

test("boot phase: a rejection still gets the overlay — nothing is on screen to toast onto", () => {
  const v = decideFatal({ reason: "标记文件损坏", phase: "boot", now: T0, seen: new Map() });
  assert.equal(v.action, "overlay");
  assert.equal(v.text, "标记文件损坏");
});

test("boot phase ignores the dedupe table entirely", () => {
  // The overlay has its own once-only guard in `main.tsx`; the policy must not
  // turn a second boot failure into a silent `skip`.
  const seen = new Map([["后端未返回原因", T0]]);
  const v = decideFatal({ reason: new Error(""), phase: "boot", now: T0 + 1, seen });
  assert.equal(v.action, "overlay");
});

test("running phase: a new reason is reported, not painted over the tree", () => {
  const v = decideFatal({ reason: "端口段已被占用", phase: "running", now: T0, seen: new Map() });
  assert.equal(v.action, "report");
  assert.equal(v.text, "端口段已被占用", "the text is the backend's own words — reportError adds the verb");
});

test("running phase: the same reason twice in a row is shown once", () => {
  const { actions } = drive(["命令不存在", "命令不存在"]);
  assert.deepEqual(actions, ["report", "skip"]);
});

test("running phase: a failing poll that never recovers renews the same message, slowly", () => {
  // A self-rescheduling probe at 3 s against a 4 s window: it says it, goes quiet
  // for one tick, then renews — so a genuine stuck failure never scrolls off
  // screen for good, and a transient one still costs exactly one toast.
  const { actions } = drive(Array.from({ length: 6 }, () => "端口检查失败"), { stepMs: 3000 });
  assert.deepEqual(actions, ["report", "skip", "report", "skip", "report", "skip"]);
});

test("different reasons are not collapsed into one another", () => {
  const { actions } = drive(["端口段已被占用", "端口段已被占用", "仓库不存在"]);
  assert.deepEqual(actions, ["report", "skip", "report"]);
});

test("the key is the sentence, not the object that carried it", () => {
  // A command rejecting with a bare `String` and a `catch` upstream re-throwing
  // the same words are one failure to read, so the second must not consume a
  // queue slot.
  assert.equal(rejectionKey("剪贴板不可用"), rejectionKey(new Error("剪贴板不可用")));
  assert.equal(
    decideFatal({
      reason: new Error("剪贴板不可用"),
      phase: "running",
      now: T0,
      seen: new Map([["剪贴板不可用", T0]]),
    }).action,
    "skip",
  );
});

test("a stack never enters the key, or every throw would look unique", () => {
  assert.doesNotMatch(rejectionKey(new Error("读取标记失败")), /at /);
  // Two errors of two classes that read the same are one toast; an error with no
  // message at all still keys on its class name, because that is what `messageOf`
  // can honestly say about it.
  assert.equal(rejectionKey(new TypeError("bad")), rejectionKey(new RangeError("bad")));
  assert.equal(rejectionKey(new TypeError()), "TypeError");
});

test("a reason that says nothing still has an identity", () => {
  const key = rejectionKey(undefined);
  assert.equal(key, "后端未返回原因");
  assert.equal(
    drive([{}, {}]).actions.join(","),
    "report,skip",
    "two unreadable objects are the same unreadable failure",
  );
});

test("a huge reason is not kept as a huge key", () => {
  const key = rejectionKey({ message: "x".repeat(5000) });
  assert.ok(key.length <= 300, `key length ${key.length} exceeds the cap`);
});

test("rememberFatal: records the key at the given time", () => {
  const seen = rememberFatal(new Map(), "仓库不存在", T0);
  assert.equal(seen.get("仓库不存在"), T0);
});

test("rememberFatal: prunes entries outside the window and leaves the input alone", () => {
  const before = new Map([["旧的", T0 - DEDUPE_MS], ["新的", T0 - 10]]);
  const after = rememberFatal(before, "刚刚", T0);
  assert.equal(after.has("旧的"), false, "outside the window is dropped — this is what bounds the map");
  assert.equal(after.get("新的"), T0 - 10);
  assert.equal(after.get("刚刚"), T0);
  assert.equal(before.size, 2, "the caller's map is not mutated");
});

test("the dedupe window is what the caller is documented to use", () => {
  assert.equal(DEDUPE_MS, 4000);
  // Exactly at the window the reason is fresh again; one ms inside it is still a
  // repeat. Both edges are pinned because the toast queue only holds three.
  const seen = new Map([["x", T0]]);
  assert.equal(decideFatal({ reason: "x", phase: "running", now: T0 + DEDUPE_MS - 1, seen }).action, "skip");
  assert.equal(decideFatal({ reason: "x", phase: "running", now: T0 + DEDUPE_MS, seen }).action, "report");
});
