/**
 * `src/store/downloads.ts` — which card an untagged progress event paints.
 *
 * The bug these pin (r15-correct-3): `tasks` is newest-first for the screen
 * (需求 9), and `pump()` deliberately walks it *backwards* so a freed slot goes
 * to the task that has waited longest. The progress router used
 * `tasks.find(t => t.status === "running")`, i.e. the **newest** running task.
 * Two ends of the same queue, one event stream: with a concurrent download
 * running, one repository's log lines and progress bar landed on another
 * repository's card, and the card that looked stalled was the one whose output
 * had been handed to its neighbour.
 *
 * Both answers now come from `inServiceOrder`, so the property worth testing is
 * not "the router picks the tail" but "the router and the scheduler pick the
 * same end".
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  inServiceOrder,
  untaggedProgressTarget,
  useDownloads,
  type DownloadTask,
} from "../src/store/downloads.ts";
import type { ProgressEvent } from "../src/types.ts";

import { at } from "./helpers/definite.ts";

const task = (over: Partial<DownloadTask> = {}): DownloadTask => ({
  id: "dl-1",
  ref: "github.com/a/one",
  source: "github",
  startedAt: 1_000,
  log: [],
  stages: [],
  progress: null,
  outcome: null,
  failure: null,
  status: "running",
  lastLine: "",
  ...over,
});

/** Newest-first, the way the store keeps it: `newer` was enqueued second. */
const older = task({ id: "dl-older", ref: "github.com/a/older", startedAt: 1_000 });
const newer = task({ id: "dl-newer", ref: "github.com/b/newer", startedAt: 2_000 });

beforeEach(() => {
  useDownloads.setState({ tasks: [], maxParallel: 3 });
});

test("inServiceOrder turns the display array back into arrival order", () => {
  assert.deepEqual(inServiceOrder([newer, older]).map((t) => t.id), ["dl-older", "dl-newer"]);
  // The display order is not disturbed: `inServiceOrder` copies.
  assert.deepEqual([newer, older].map((t) => t.id), ["dl-newer", "dl-older"]);
});

test("an untagged event belongs to the task the scheduler started first", () => {
  useDownloads.setState({ tasks: [newer, older] });
  const target = untaggedProgressTarget(useDownloads.getState().tasks);
  assert.equal(target?.id, "dl-older", "the oldest running task, not the newest");
  assert.equal(
    target?.startedAt,
    Math.min(...[newer, older].map((t) => t.startedAt)),
    "which is exactly the task pump() picked, by startedAt",
  );
});

test("applyProgress writes an untagged event onto the oldest card only", () => {
  useDownloads.setState({
    tasks: [task({ ...newer }), task({ ...older })],
  });
  const ev: ProgressEvent = { stage: "resolving", message: "正在解析引用" };
  useDownloads.getState().applyProgress(ev);

  const after = useDownloads.getState().tasks;
  const [n, o] = [after.find((t) => t.id === "dl-newer")!, after.find((t) => t.id === "dl-older")!];
  assert.equal(o.log.length, 1, "the serving task gets the line");
  assert.equal(o.stages.includes("resolving"), true);
  assert.equal(n.log.length, 0, "and the other running task is left alone");
  assert.equal(n.stages.length, 0, "no borrowed progress either");
});

test("a tagged event still matches by id, and by ref for a pre-queue payload", () => {
  useDownloads.setState({ tasks: [task({ ...newer }), task({ ...older })] });
  useDownloads.getState().applyProgress({ stage: "fetching", message: "m", task: "dl-newer" });
  let after = useDownloads.getState().tasks;
  assert.equal(after.find((t) => t.id === "dl-newer")!.log.length, 1, "matched by task id");
  assert.equal(after.find((t) => t.id === "dl-older")!.log.length, 0);

  useDownloads.setState({ tasks: [task({ ...newer }), task({ ...older })] });
  useDownloads.getState().applyProgress({
    stage: "fetching",
    message: "m",
    task: "github.com/a/older",
  });
  after = useDownloads.getState().tasks;
  assert.equal(after.find((t) => t.id === "dl-older")!.log.length, 1, "matched by ref");
  assert.equal(after.find((t) => t.id === "dl-newer")!.log.length, 0);
});

test("routing skips a queued or finished task and takes the oldest *running* one", () => {
  // Newest-first: a queued task that arrived last must not steal the stream,
  // and neither must a task that already ended.
  useDownloads.setState({
    tasks: [
      task({ id: "dl-queued", ref: "c", startedAt: 3_000, status: "queued" }),
      task({ id: "dl-new", ref: "b", startedAt: 2_000 }),
      task({ id: "dl-old", ref: "a", startedAt: 1_000 }),
      task({ id: "dl-done", ref: "d", startedAt: 4_000, status: "done" }),
    ],
  });
  assert.equal(untaggedProgressTarget(useDownloads.getState().tasks)?.id, "dl-old");

  useDownloads.getState().applyProgress({ stage: "checkout", message: "检出中" });
  const after = useDownloads.getState().tasks;
  assert.equal(after.find((t) => t.id === "dl-old")!.log.length, 1);
  assert.equal(after.find((t) => t.id === "dl-new")!.log.length, 0);
  assert.equal(after.find((t) => t.id === "dl-queued")!.log.length, 0);
});

test("no running task means the event lands nowhere rather than on a queued row", () => {
  useDownloads.setState({ tasks: [task({ id: "dl-q", status: "queued" })] });
  const before = useDownloads.getState().tasks;
  useDownloads.getState().applyProgress({ stage: "fetching", message: "m" });
  assert.equal(useDownloads.getState().tasks, before, "untouched — the store returns the same state");
  assert.equal(at(useDownloads.getState().tasks, 0).log.length, 0);
});

test("progress-line events update lastLine without appending to the log", () => {
  // Newest-first, as the store keeps it — `newer` was enqueued last, so it is at
  // the head, and the tail (`older`) is what the scheduler is serving.
  useDownloads.setState({ tasks: [task({ ...newer }), task({ ...older })] });
  useDownloads.getState().applyProgress({
    stage: "fetch-progress",
    message: "Receiving objects: 42%",
  });
  const after = useDownloads.getState().tasks;
  const o = after.find((t) => t.id === "dl-older")!;
  const n = after.find((t) => t.id === "dl-newer")!;
  assert.equal(o.lastLine, "Receiving objects: 42%", "the oldest card is the one that moves");
  assert.equal(o.log.length, 0, "a progress bar is not a log line");
  assert.equal(n.lastLine, "", "the other card keeps saying nothing");
  assert.equal(typeof o.progressAt, "number", "the ETA keys off arrival time, not render time");
});
