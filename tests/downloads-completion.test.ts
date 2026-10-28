/**
 * `src/store/downloads.ts` + `src/App.tsx` — what a wall refresh is keyed on.
 *
 * The bug these pin (r15-correct-6): the effect in `App.tsx` subscribed to
 * `tasks.filter(t => t.status === "done").length` and refreshed whenever that
 * number moved. A count of rows also moves when rows are *removed*, so 清除已完成 —
 * or dismissing one finished card — re-ran a whole `list_repositories`, and the
 * app looked like it was re-scanning the container every time somebody tidied a
 * list.
 *
 * The store now publishes `doneSeq`: how many downloads have succeeded, ever. It
 * only goes up, and only for the event the wall actually cares about.
 *
 * Note on shape: every fixture here leaves the queue with no `queued` task at the
 * moment `finish` runs. `finish` calls `pump()`, and a queued task would make it
 * fire a real `invoke("download_repo")` — which cannot work here and would turn a
 * clean unit test into a race against an IPC rejection.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { useDownloads, type DownloadTask } from "../src/store/downloads.ts";
import type { DownloadOutcome } from "../src/types.ts";

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

/** A completed clone, as the backend reports it. */
const cloned = (path = "D:\\gh\\one"): DownloadOutcome => ({
  layer: "direct",
  path,
  attempts: [],
  degraded: false,
  viaThirdParty: false,
});

beforeEach(() => {
  useDownloads.setState({ tasks: [], maxParallel: 3, doneSeq: 0 });
});

test("doneSeq counts successes, which is the only thing that put a directory on disk", () => {
  useDownloads.setState({ tasks: [task({ id: "a" }), task({ id: "b", ref: "github.com/a/two" })] });

  useDownloads.getState().finish("a", cloned(), null);
  assert.equal(useDownloads.getState().doneSeq, 1, "one completed download");

  useDownloads.getState().finish("b", null, "克隆失败");
  assert.equal(useDownloads.getState().doneSeq, 1, "a failure changes nothing on disk");
  assert.equal(useDownloads.getState().tasks.find((t) => t.id === "b")!.status, "failed");
});

test("dismissing a finished row does not ask the wall to re-read the disk", () => {
  useDownloads.setState({ tasks: [task({ id: "a" }), task({ id: "b", ref: "github.com/a/two" })] });
  useDownloads.getState().finish("a", cloned(), null);
  const after = useDownloads.getState().doneSeq;
  assert.equal(after, 1);

  useDownloads.getState().dismiss("a");
  assert.equal(useDownloads.getState().tasks.length, 1, "the row is gone");
  assert.equal(useDownloads.getState().doneSeq, after, "and the refresh trigger did not move");

  useDownloads.getState().dismiss("no-such-id");
  assert.equal(useDownloads.getState().doneSeq, after, "dismissing nothing moves it either");
});

test("清除已完成 is tidying up, not a completed download", () => {
  useDownloads.setState({
    tasks: [
      task({ id: "done" }),
      task({ id: "failed", ref: "github.com/a/two" }),
      task({ id: "busy", ref: "github.com/a/three" }),
    ],
  });
  useDownloads.getState().finish("done", cloned(), null);
  useDownloads.getState().finish("failed", null, "失败");
  const before = useDownloads.getState().doneSeq;
  assert.equal(before, 1);

  useDownloads.getState().clearFinished();
  const s = useDownloads.getState();
  assert.deepEqual(s.tasks.map((t) => t.id), ["busy"], "finished rows were removed");
  assert.equal(s.doneSeq, before, "so the wall must not be re-listed because of it");
});

test("clearFinished keeps a queued task, and keeps doneSeq where it was", () => {
  useDownloads.setState({
    tasks: [task({ id: "queued", status: "queued" }), task({ id: "ok", status: "done" })],
  });
  useDownloads.getState().clearFinished();
  const s = useDownloads.getState();
  assert.deepEqual(s.tasks.map((t) => t.id), ["queued"], "the queue is not what gets cleared");
  assert.equal(s.doneSeq, 0, "removing an already-counted row does not recount it");
});

test("a task is counted once, however many times it is settled", () => {
  useDownloads.setState({ tasks: [task({ id: "a" })] });
  useDownloads.getState().finish("a", cloned(), null);
  useDownloads.getState().finish("a", cloned("D:\\other"), null);
  useDownloads.getState().finish("a", null, "again");
  assert.equal(useDownloads.getState().doneSeq, 1, "a duplicate settle is not a second download");
  const a = at(useDownloads.getState().tasks, 0);
  assert.equal(a.status, "done");
  assert.equal(a.outcome?.path, "D:\\gh\\one", "and it cannot rewrite the outcome");

  useDownloads.getState().finish("unknown-id", cloned(), null);
  assert.equal(useDownloads.getState().doneSeq, 1, "settling a task that is not there counts for nothing");
});

test("counting completions does not disturb the row tally the queue header shows", () => {
  useDownloads.setState({ tasks: [task({ id: "a" }), task({ id: "b", ref: "github.com/a/two" })] });
  useDownloads.getState().finish("a", cloned(), null);
  const s = useDownloads.getState();
  assert.equal(s.doneSeq, 1);
  assert.deepEqual(
    s.tasks.map((t) => t.status),
    ["done", "running"],
    "the other task is untouched by the counter",
  );
  assert.equal(s.tasks.find((t) => t.id === "a")!.endedAt !== undefined, true);
  assert.equal(s.tasks.find((t) => t.id === "a")!.outcome?.path, "D:\\gh\\one");
});

test("App.tsx subscribes to the monotonic counter, not to a row count", () => {
  // The component itself cannot be mounted at this layer (`.tsx` is refused by
  // `--experimental-strip-types`, DEVELOPMENT.md §8.1), so the wiring is pinned
  // structurally — the same approach as `tests/single-source.test.ts`.
  const source = readFileSync("src/App.tsx", "utf8");
  assert.match(
    source,
    /useDownloads\(\(s\) => s\.doneSeq\)/,
    "the wall must key on the counter that only ever goes up",
  );
  assert.doesNotMatch(
    source,
    /useDownloads\(\(s\) => s\.tasks\.filter\(\(t\) => t\.status === "done"\)\.length\)/,
    "the count-of-rows selector is what made 清除已完成 re-list the container",
  );
});
