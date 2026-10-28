/**
 * 存储配额提示的节奏：阈值一次、写失败最多每分钟一次。说话太多会淹掉第一条有用的警告。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import type { QuotaEvent } from "../src/lib/kv-store.ts";
import {
  megabytes,
  nextStorageHealth,
  STORAGE_HEALTH_INITIAL,
  WRITE_ERROR_COOLDOWN_MS,
} from "../src/lib/storage-health.ts";

const threshold = (bytes = 2 * 1024 * 1024): QuotaEvent => ({
  reason: "threshold",
  key: "devhub.wall.v1",
  bytes,
  warnAtBytes: 1024 * 1024,
});
const writeError = (key = "devhub.wall.v1"): QuotaEvent => ({
  reason: "write-error",
  key,
  bytes: 2 * 1024 * 1024,
  warnAtBytes: 1024 * 1024,
  error: new Error("quota"),
});

test("阈值只播报一次，后续阈值事件静默", () => {
  const first = nextStorageHealth(STORAGE_HEALTH_INITIAL, threshold(), 1_000);
  assert.equal(first.announce, true);
  const second = nextStorageHealth(first.state, threshold(), 2_000);
  assert.equal(second.announce, false);
  assert.equal(second.state.thresholdAnnounced, true);
});

test("写失败首次立即播报，冷却期内静默，冷却后再次播报", () => {
  const first = nextStorageHealth(STORAGE_HEALTH_INITIAL, writeError(), 10_000);
  assert.equal(first.announce, true);
  const quiet = nextStorageHealth(first.state, writeError("another.key"), 10_000 + WRITE_ERROR_COOLDOWN_MS - 1);
  assert.equal(quiet.announce, false);
  const later = nextStorageHealth(quiet.state, writeError(), 10_000 + WRITE_ERROR_COOLDOWN_MS);
  assert.equal(later.announce, true);
});

test("阈值与写失败是两条独立通道，不互相消耗", () => {
  const a = nextStorageHealth(STORAGE_HEALTH_INITIAL, threshold(), 1_000);
  const b = nextStorageHealth(a.state, writeError(), 2_000);
  assert.equal(b.announce, true);
  assert.equal(b.state.thresholdAnnounced, true);
  assert.equal(b.state.lastWriteErrorAt, 2_000);
});

test("megabytes: 至少 1，按 MiB 四舍五入", () => {
  assert.equal(megabytes(0), 1);
  assert.equal(megabytes(1_048_576), 1);
  assert.equal(megabytes(1_600_000), 2);
});
