/**
 * `src/store/appearance.ts` — `createChangeRecorder`, the coalescing that turns one
 * drag of 界面字号 into ONE 记录 row.
 *
 * The storage side of an appearance `set` was already coalesced (`lib/storage.ts`);
 * the activity record was not, so every pixel of a slider drag pushed its own
 * `log_activity` call and its own near-identical row. These tests pin the four
 * rules the fix rests on, with an injected clock for the same reason
 * `tests/poll-loop.test.ts` has one: the real `setTimeout` would make the assertion
 * about *when* a row lands a race instead of a fact.
 *
 * Nothing here reaches the backend: `emit` is a spy, and `recordChange` — the one
 * line that calls `invoke` — is what the production recorder wires in, not this.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createChangeRecorder,
  type AppearanceChangeRow,
} from "../src/store/appearance.ts";

/** A clock a test can advance by hand, same shape as the poll-loop helper. */
function fakeClock() {
  let nextId = 0;
  const pending: { id: number; cb: () => void; ms: number }[] = [];
  const cleared: number[] = [];
  return {
    pending,
    cleared,
    schedule: (cb: () => void, ms: number) => {
      const id = ++nextId;
      pending.push({ id, cb, ms });
      return id;
    },
    unschedule: (id: number) => {
      cleared.push(id);
      const at = pending.findIndex((p) => p.id === id);
      if (at >= 0) pending.splice(at, 1);
    },
    fire: () => {
      const soonest = pending.shift();
      if (!soonest) throw new Error("fake clock: nothing is scheduled");
      soonest.cb();
    },
  };
}

/** Runs a burst of 界面字号 values, the way a drag does. */
function drag(recorder: ReturnType<typeof createChangeRecorder>, from: number, to: number) {
  let previous = from;
  const step = from < to ? 1 : -1;
  for (let value = from + step; ; value += step) {
    recorder.push("uiFontPx", previous, value);
    previous = value;
    if (value === to) break;
  }
}

test("change recorder: a burst on one key emits exactly one row", () => {
  const clock = fakeClock();
  const rows: AppearanceChangeRow[] = [];
  const recorder = createChangeRecorder((r) => rows.push(r), {
    schedule: clock.schedule,
    unschedule: clock.unschedule,
  });

  drag(recorder, 16, 22);
  assert.deepEqual(rows, [], "nothing may be written before the burst settles");
  clock.fire();
  assert.equal(rows.length, 1, `one gesture is one row, got ${rows.length}`);
  assert.deepEqual(rows[0], { key: "uiFontPx", before: 16, after: 22 });
});

test("change recorder: the row carries the FIRST before, so 回退 undoes the gesture", () => {
  const clock = fakeClock();
  const rows: AppearanceChangeRow[] = [];
  const recorder = createChangeRecorder((r) => rows.push(r), {
    schedule: clock.schedule,
    unschedule: clock.unschedule,
  });

  drag(recorder, 14, 19);
  clock.fire();
  // The last `set` in the burst saw before 18; a record that reverted to 18 would
  // put the font back one notch short of where the drag started.
  assert.equal(rows[0]?.before, 14);
  assert.equal(rows[0]?.after, 19);
});

test("change recorder: two keys in one burst are two rows", () => {
  const clock = fakeClock();
  const rows: AppearanceChangeRow[] = [];
  const recorder = createChangeRecorder((r) => rows.push(r), {
    schedule: clock.schedule,
    unschedule: clock.unschedule,
  });

  recorder.push("uiFontPx", 16, 18);
  recorder.push("theme", "dark", "light");
  clock.fire();
  assert.deepEqual(rows, [
    { key: "uiFontPx", before: 16, after: 18 },
    { key: "theme", before: "dark", after: "light" },
  ]);
  assert.equal(clock.pending.length, 0, "one timer covers the whole burst");
});

test("change recorder: a burst that ends on the value it started on records nothing", () => {
  const clock = fakeClock();
  const rows: AppearanceChangeRow[] = [];
  const recorder = createChangeRecorder((r) => rows.push(r), {
    schedule: clock.schedule,
    unschedule: clock.unschedule,
  });

  drag(recorder, 16, 22);
  drag(recorder, 22, 16);
  clock.fire();
  assert.deepEqual(rows, [], "记录 must not claim a change the user dragged back");
});

test("change recorder: flush emits now, cancels the timer and cannot emit twice", () => {
  const clock = fakeClock();
  const rows: AppearanceChangeRow[] = [];
  const recorder = createChangeRecorder((r) => rows.push(r), {
    schedule: clock.schedule,
    unschedule: clock.unschedule,
  });

  recorder.push("fontWeight", "normal", "bold");
  recorder.flush();
  assert.equal(rows.length, 1);
  assert.deepEqual(clock.cleared, [1], "the pending trailing flush must be cancelled");
  recorder.flush();
  assert.equal(rows.length, 1, "a flush with nothing pending writes nothing");
  assert.equal(clock.pending.length, 0, "no timer may survive the flush");
});

test("change recorder: each burst gets its own row and its own timer", () => {
  const clock = fakeClock();
  const rows: AppearanceChangeRow[] = [];
  const recorder = createChangeRecorder((r) => rows.push(r), {
    schedule: clock.schedule,
    unschedule: clock.unschedule,
  });

  drag(recorder, 16, 18);
  clock.fire();
  drag(recorder, 18, 20);
  assert.equal(rows.length, 1, "the second burst is still open");
  clock.fire();
  assert.deepEqual(rows.map((r) => [r.before, r.after]), [
    [16, 18],
    [18, 20],
  ]);
});

test("change recorder: the window is the storage coalescing window", () => {
  const clock = fakeClock();
  const recorder = createChangeRecorder(() => {}, {
    schedule: clock.schedule,
    unschedule: clock.unschedule,
  });
  recorder.push("uiFontPx", 16, 17);
  assert.equal(clock.pending[0]?.ms, 250);
});
