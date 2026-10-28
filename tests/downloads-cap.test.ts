/**
 * `src/store/downloads.ts` — where the parallel cap comes from.
 *
 * The bug these pin (r15-correct-2): the store hard-coded `maxParallel: 3` and
 * only ever learned the real number from a `maxParallel` field on a
 * `download://progress` payload — i.e. *after* a clone was already running. So a
 * cold start ran three concurrent clones for a user who had set 同时下载数 to 1
 * (`parallelDownloads`, SettingsView's 网络 section), and `DownloadQueue`'s
 * header printed 3 for the same queue. The backend had been reporting the
 * configured value all along (`lib.rs:999` reads `parallel_downloads`); the
 * frontend just never asked until one was in flight.
 *
 * The store now reads 设置 itself, and these tests cover the three things that
 * decision is made of: the coercion, the fallback when the read is unavailable,
 * and the fact that a cap change is clamped rather than trusted.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  capReady,
  clampMaxParallel,
  parallelFromSettings,
  useDownloads,
} from "../src/store/downloads.ts";

test("clampMaxParallel: junk falls back to the shipped default, not to 0 or NaN", () => {
  for (const junk of [undefined, null, NaN, Infinity, -Infinity, "3", true, {}, []]) {
    assert.equal(clampMaxParallel(junk), 3, `${String(junk)} is not a usable cap`);
  }
  // A real `0` is not junk, it is out of range: 设置's own writer does
  // `Number(parallel) || 1`, so a stored 0 means "one at a time", not "never".
  assert.equal(clampMaxParallel(0), 1);
});

test("clampMaxParallel: in-range values round into the setting's own 1..6 bounds", () => {
  assert.equal(clampMaxParallel(1), 1);
  assert.equal(clampMaxParallel(6), 6);
  assert.equal(clampMaxParallel(2.7), 3, "a fractional stored value still means whole clones");
  assert.equal(clampMaxParallel(-5), 1, "a negative cap would stop the queue dead");
  assert.equal(clampMaxParallel(99), 6, "the 设置 input's max is 6");
});

test("parallelFromSettings: the field is read by name, with the same fallback", () => {
  assert.equal(parallelFromSettings({ parallelDownloads: 1 }), 1, "the user who set 1 gets 1");
  assert.equal(parallelFromSettings({ parallelDownloads: 4 }), 4);
  assert.equal(parallelFromSettings({ parallelDownloads: "2" }), 3, "a string is not a number");
  assert.equal(parallelFromSettings({}), 3, "a settings payload without the field");
  assert.equal(parallelFromSettings(null), 3);
  assert.equal(parallelFromSettings(undefined), 3);
  assert.equal(parallelFromSettings("nope"), 3);
});

test("the store starts on the default and only the setting can move it", () => {
  assert.equal(useDownloads.getState().maxParallel, 3);

  useDownloads.getState().setMaxParallel(1);
  assert.equal(useDownloads.getState().maxParallel, 1, "同时下载数 = 1 must reach the scheduler");

  useDownloads.getState().setMaxParallel(99);
  assert.equal(useDownloads.getState().maxParallel, 6, "an out-of-range value is clamped");

  useDownloads.getState().setMaxParallel(-3);
  assert.equal(useDownloads.getState().maxParallel, 1);

  useDownloads.getState().setMaxParallel(Number.NaN);
  assert.equal(useDownloads.getState().maxParallel, 3, "junk resolves to the default, never to 0");
});

test("capReady settles even with no backend, so the queue cannot deadlock on it", async () => {
  // Under test there is no Tauri `invoke`, which is exactly the failure the queue
  // must survive: a settings read that throws or hangs must not mean 下载 never
  // starts. `add()` awaits `capReady()` before pumping.
  const first = await capReady();
  assert.equal(first, undefined, "it resolves rather than rejecting");

  const second = await capReady();
  assert.equal(second, undefined, "and a second call is still a resolution, not a new wait");
});
