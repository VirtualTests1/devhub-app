/**
 * `src/store/processes.ts` — the live-process poll's schedule and its failure voice.
 *
 * The defect (r15-correct-12): `pollStarted` was a one-way module flag, `setInterval`'s
 * handle was thrown away so nothing could ever cancel it, `catch {}` discarded every
 * rejection, and no listener for `visibilitychange` existed anywhere in `src/`. Put
 * together: a dead `live_processes` command was dialled twice a second for the rest of
 * the session — including while the window was hidden, when nobody could see the
 * count it was failing to update — without producing one signal.
 *
 * `nextPollPolicy` is the part that was missing, and it is pure, so all of it is
 * pinned here as data: backoff curve, the once-per-streak report, the suspension while
 * hidden, and the two races that a `setInterval` used to lose. Shape copied from
 * `tests/poll-loop.test.ts`; the wiring it cannot reach (`document.hidden`, real
 * timers) is pinned structurally instead, as in `tests/statusstrip-*.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  POLL_BASE_MS,
  POLL_MAX_MS,
  initialPollPolicy,
  nextPollPolicy,
  pollDelayMs,
  type PollEvent,
  type PollPolicy,
} from "../src/store/processes.ts";

/** Fold a run of events from the initial state, the way the loop would. */
function drive(events: readonly PollEvent[]) {
  let p: PollPolicy = initialPollPolicy();
  const seen: ReturnType<typeof nextPollPolicy>[] = [];
  for (const e of events) {
    const d = nextPollPolicy(p, e);
    seen.push(d);
    p = { fails: d.fails, hidden: d.hidden };
  }
  return { state: p, seen };
}

test("pollDelayMs: doubles from the 2 s baseline and stops at the cap", () => {
  assert.equal(pollDelayMs(0), 2000, "a healthy poll keeps the interval the strip was designed around");
  assert.equal(pollDelayMs(1), 4000);
  assert.equal(pollDelayMs(2), 8000);
  assert.equal(pollDelayMs(3), 16000);
  assert.equal(pollDelayMs(4), POLL_MAX_MS, "2000·2^4 = 32000 is already past the cap");
  assert.equal(pollDelayMs(9), POLL_MAX_MS);
  assert.equal(pollDelayMs(2000), POLL_MAX_MS, "the exponent is clamped: never a number that cannot fire");
  assert.ok(Number.isFinite(pollDelayMs(1e6)), "no Infinity into setTimeout");
});

test("连续失败：退避一次比一次长，恢复后回到基线", () => {
  const { seen, state } = drive([
    { type: "fail" },
    { type: "fail" },
    { type: "fail" },
    { type: "ok" },
  ]);
  assert.deepEqual(
    seen.map((d) => d.nextDelayMs),
    [4000, 8000, 16000, POLL_BASE_MS],
    "the schedule is the backoff curve, then the normal gap again",
  );
  assert.equal(state.fails, 0, "one good answer clears the streak");
});

test("失败只说一次：一条坏消息是一个事实，不是一串", () => {
  const { seen } = drive([{ type: "fail" }, { type: "fail" }, { type: "fail" }, { type: "ok" }, { type: "fail" }]);
  assert.deepEqual(
    seen.map((d) => d.report),
    [true, false, false, false, true],
    "the streak speaks on its first tick, stays shut after that, and a NEW streak speaks again",
  );
});

test("窗口不可见就停摆，回来立刻补一次", () => {
  const hidden = nextPollPolicy({ fails: 2, hidden: false }, { type: "hidden" });
  assert.equal(hidden.nextDelayMs, null, "suspended outright, not merely slowed down");
  assert.equal(hidden.fails, 2, "and the streak is remembered — hiding is not recovery");

  const back = nextPollPolicy({ fails: hidden.fails, hidden: true }, { type: "visible" });
  assert.equal(back.nextDelayMs, 0, "the count on screen is stale the moment the window shows again");
  assert.equal(back.fails, 2, "still the same bad backend, still the same backoff step");
});

test("在飞行途中被隐藏：落地的答案不许把循环重新点着", () => {
  // The race `setInterval` could not express: the tick was already out when the
  // window hid, so its answer arrives against a hidden policy.
  const late = nextPollPolicy({ fails: 0, hidden: true }, { type: "ok" });
  assert.equal(late.nextDelayMs, null, "a good answer while hidden schedules nothing");
  assert.equal(late.fails, 0, "it still counts as recovery");

  const lateFail = nextPollPolicy({ fails: 1, hidden: true }, { type: "fail" });
  assert.equal(lateFail.nextDelayMs, null, "a rejection while hidden must not restart the poll");
  assert.equal(lateFail.report, false, "and the streak was already reported before the window hid");
});

test("整段隐藏期：一次都不拨号，退出隐藏后恢复计数", () => {
  const { seen } = drive([{ type: "fail" }, { type: "hidden" }, { type: "fail" }, { type: "ok" }, { type: "visible" }]);
  assert.deepEqual(
    seen.map((d) => d.nextDelayMs),
    [4000, null, null, null, 0],
    "hidden swallows everything until the window comes back",
  );
  assert.deepEqual(seen.map((d) => d.report), [true, false, false, false, false]);
});

// --- the wiring the pure part cannot reach, pinned structurally ----------------

const rawSource = readFileSync("src/store/processes.ts", "utf8");
/**
 * Comments out, because this house documents a fix by quoting the code it deleted —
 * the file says in prose what `setInterval` and `catch {}` used to be, and a scanner
 * that reads that prose would "find" the very thing it is meant to forbid.
 */
const source = rawSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

test("接线部分：句柄被留下、可见性有人听、失败走 toast 而不是 console", () => {
  assert.match(source, /let timer: number \| null = null;/, "the handle the old code passed into the void");
  assert.match(source, /window\.clearTimeout\(timer\)/, "and something that uses it");
  assert.doesNotMatch(source, /window\.setInterval\(\(\) => void tick\(\)/, "the interval that could stack probes is gone");
  assert.match(source, /document\.addEventListener\("visibilitychange"/, "nothing in src/ listened before this");
  assert.match(source, /document\.removeEventListener\("visibilitychange"/, "and stop() unlistens");
  assert.match(source, /reportError\(err, "读取运行进程失败"\)/, "the app's one failure path, not the console");
  assert.doesNotMatch(source, /console\./, "console is not a signal a user can see");
  assert.doesNotMatch(source, /catch \{\s*\}/, "an empty catch was the whole silence");
});
