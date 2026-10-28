/**
 * `src/lib/download-rate.ts` — the numbers next to the progress bar.
 *
 * The UI may only claim a speed git printed, and an ETA derived from at least two
 * distinct percentages. These tests pin both halves, including the cases where the
 * honest answer is `null`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  estimateEta,
  formatEta,
  parseGitProgress,
  pushRateSample,
  RATE_MIN_SPAN_MS,
  RATE_WINDOW_MS,
  type RateSample,
} from "../src/lib/download-rate.ts";

test("parseGitProgress: 项目里记录过的真实行形状", () => {
  // downloader.rs 的 progress_percent 文档用这一行做例子。
  const line = "Receiving objects:  45% (1234/2740), 1.20 MiB | 3.40 MiB/s";
  assert.deepEqual(parseGitProgress(line), {
    percent: 45,
    bytesPerSec: 3.4 * 1024 ** 2,
  });
});

test("parseGitProgress: 只有百分比 / 只有速率 / 都没有", () => {
  assert.deepEqual(parseGitProgress("Receiving objects: 42%"), { percent: 42, bytesPerSec: null });
  assert.deepEqual(parseGitProgress("Resolving deltas: 100% (12/12), done."), {
    percent: 100,
    bytesPerSec: null,
  });
  assert.equal(parseGitProgress("remote: Counting objects: done.").percent, null);
  assert.equal(parseGitProgress("").percent, null);
  assert.equal(parseGitProgress(null).bytesPerSec, null);
});

test("parseGitProgress: 单位大小写与 KiB/MB/B 都换算成字节", () => {
  assert.equal(parseGitProgress("x 1 KiB/s").bytesPerSec, 1024);
  assert.equal(parseGitProgress("x 2 MB/s").bytesPerSec, 2 * 1024 ** 2);
  assert.equal(parseGitProgress("x 512 B/s").bytesPerSec, 512);
  assert.equal(parseGitProgress("x 0 B/s").bytesPerSec, null, "0 不是速率，别画每秒 0 字节");
});

test("parseGitProgress: 非法百分比不产出数字", () => {
  assert.equal(parseGitProgress("x 101%").percent, null);
  assert.equal(parseGitProgress("x 999%").percent, null);
});

test("pushRateSample: 同百分比重复不追加；窗口外的旧样本被丢弃", () => {
  let samples: RateSample[] = [];
  samples = pushRateSample(samples, 10, 1_000);
  samples = pushRateSample(samples, 10, 2_000);
  assert.deepEqual(samples, [{ percent: 10, at: 1_000 }], "没动就不采样");
  samples = pushRateSample(samples, 20, 3_000);
  assert.equal(samples.length, 2);
  samples = pushRateSample(samples, 30, 1_000 + RATE_WINDOW_MS + 5_000);
  assert.deepEqual(samples.map((s) => s.percent), [30], "窗口外的 10/20 不再参与斜率");
});

test("estimateEta: 至少两个样本、跨度够、且百分比在前进；否则 null", () => {
  const two = [
    { percent: 10, at: 0 },
    { percent: 20, at: 1_000 },
  ];
  assert.equal(estimateEta(two), 8_000, "10% 用 1s，剩余 80% 约 8s");
  assert.equal(estimateEta([{ percent: 10, at: 0 }]), null);
  assert.equal(
    estimateEta([
      { percent: 10, at: 0 },
      { percent: 12, at: RATE_MIN_SPAN_MS - 1 },
    ]),
    null,
    "样本太近，斜率不可信",
  );
  assert.equal(
    estimateEta([
      { percent: 20, at: 0 },
      { percent: 20, at: 5_000 },
    ]),
    null,
    "没前进就没有剩余时间",
  );
  assert.equal(
    estimateEta([
      { percent: 10, at: 0 },
      { percent: 5, at: 5_000 },
    ]),
    null,
    "倒退是异常，不编 ETA",
  );
});

test("estimateEta: 到 100% 是 0，不是负数", () => {
  assert.equal(
    estimateEta([
      { percent: 90, at: 0 },
      { percent: 100, at: 2_000 },
    ]),
    0,
  );
});

test("formatEta: 分:秒，超过一小时才出现小时", () => {
  assert.equal(formatEta(8_000), "0:08");
  assert.equal(formatEta(130_000), "2:10");
  assert.equal(formatEta(3_723_000), "1:02:03");
  assert.equal(formatEta(-1), "0:00");
});
