/**
 * `formatBytes`（TS）与 `human_bytes`（Rust）的跨语言字节格式契约。
 *
 * `src-tauri/src/lib.rs:346-357` 的 `human_bytes` 顶着一句注释："Mirrors
 * `formatBytes` in `src/types.ts` deliberately … having the two sides disagree on
 * units is worse than either choice." 那句注释是唯一的约束——两侧各写各的，靠人自觉。
 * 而 `lib.rs` 的 `mod tests`（5707 起，逐一读过）根本没有 `human_bytes` 的单测。所以
 * 这里就是那份跨语言契约被钉下来的地方：一张共享定义域上的 `(字节数 → 期望串)` 对照表，
 * 每行标注它对应 Rust 的哪个分支。
 *
 * 本文件不改 Rust 侧（另有工作流负责），只把 TS 侧的阈值、单位、小数位钉成一张
 * Rust 侧必须复现的表。任一侧改了阈值（比如 1024→1000）、单位拼写、或某个 tier 的
 * 小数位，这张表会先在测试里红。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { formatBytes } from "../src/lib/format.ts";
import { formatBytes as formatBytesViaTypes } from "../src/types.ts";

/**
 * 共享定义域：`human_bytes(n: u64)` 能接到的输入，即非负整数。每个 tier 的边界、
 * 进位上沿、以及清理报告里真实出现过的那个数，都列进来。
 *
 * 刻意避开 `.x5` 这类舍入平局值：JS 的 `toFixed` 与 Rust 的 `{:.N}` 对「正好一半」
 * 的舍入规则不同（一个偏向奇数、一个 half-to-even），拿平局值断言会把这种与阈值
 * 无关的差异也误报成漂移。表里所有值都是明确进/舍，两侧逐字节相同。
 */
const PARITY: { n: number; expect: string; rust: string }[] = [
  { n: 0, expect: "0 B", rust: "if n < K → {n} B" },
  { n: 1, expect: "1 B", rust: "if n < K" },
  { n: 999, expect: "999 B", rust: "if n < K" },
  { n: 1000, expect: "1000 B", rust: "1000 < 1024：仍是 B tier，不是 KB——阈值是 1024" },
  { n: 1023, expect: "1023 B", rust: "if n < K 的上沿" },
  { n: 1024, expect: "1.0 KB", rust: "else if n < K*K → {:.1} KB" },
  { n: 1536, expect: "1.5 KB", rust: "{:.1} KB" },
  { n: 1025, expect: "1.0 KB", rust: "{:.1}：1.00097 舍成 1.0" },
  { n: 1024 * 1024 - 1, expect: "1024.0 KB", rust: "KB tier 顶：{:.1} 仍写成 1024.0" },
  { n: 1024 * 1024, expect: "1.0 MB", rust: "else if n < K*K*K → {:.1} MB" },
  { n: 1024 * 1024 * 100, expect: "100.0 MB", rust: "{:.1} MB" },
  { n: 125829120, expect: "120.0 MB", rust: "注释里那句「释放 125829120 字节」的真值" },
  { n: 1024 * 1024 * 1024 - 1, expect: "1024.0 MB", rust: "MB tier 顶：不升格为 1.00 GB" },
  { n: 1024 * 1024 * 1024, expect: "1.00 GB", rust: "else → {:.2} GB（唯一两位小数 tier）" },
  { n: 1024 * 1024 * 1024 * 1.5, expect: "1.50 GB", rust: "{:.2} GB" },
];

test("formatBytes: types.ts 的再导出与 lib/format 是同一个函数", () => {
  // Rust 注释点名的是 `src/types.ts`；那条路径必须是 pass-through，不能是第二份实现，
  // 否则这张对照表钉的就不是 Rust 侧真正镜像的那个函数。
  assert.equal(formatBytesViaTypes, formatBytes, "types.ts must re-export lib/format, not copy it");
});

test("formatBytes ↔ human_bytes 共享定义域对照表（阈值 / 单位 / 小数位）", () => {
  for (const row of PARITY) {
    // 走 types.ts 那条路径断言——正是 Rust 注释所指的那条。
    assert.equal(
      formatBytesViaTypes(row.n),
      row.expect,
      `n=${row.n} 必须产出 "${row.expect}"（对应 Rust: ${row.rust}）。改了这个就说明两侧单位在漂。`,
    );
  }
});

test("formatBytes: 每个 tier 的小数位与 Rust 分支一致（B/KB/MB 一位、GB 两位）", () => {
  // 小数位数是 `toFixed(1)/toFixed(2)` 与 `{:.1}/{:.2}` 的接缝；tier 换错位数会
  // 让同一块字节在两栏里宽度/进位都不一致。
  assert.match(formatBytes(2048), /^[\d.]+ KB$/, "KB 仍是一位小数");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(3 * 1024 * 1024), "3.0 MB", "MB 一位");
  assert.equal(formatBytes(2 * 1024 * 1024 * 1024), "2.00 GB", "GB 两位，末位补 0");
});

// --- 定义域差异：u64 装不下的输入，是 TS 独占的分支 ------------------------------

test("formatBytes: 负数与非有限值是 TS 独占分支，Rust 的 u64 根本进不来", () => {
  // `human_bytes(n: u64)` 在类型上就不可能收到这些值，所以它们不是「漂移」，而是
  // 「Rust 侧靠类型挡住、TS 侧靠 tier 条件穿透」的分工。这里把 TS 的真实输出钉住，
  // 并写下必须维持的不变式。
  assert.equal(formatBytes(-1), "-1 B");
  assert.equal(formatBytes(-1024 * 1024), "-1048576 B", "负值永远落在 B tier， magnitude 再大也不给单位");
  assert.equal(formatBytes(Number.NaN), "NaN GB", "NaN 让每个 < 都成假，一路穿到 GB 分支");
  assert.equal(formatBytes(Number.POSITIVE_INFINITY), "Infinity GB");
  // 不变式（读代码得出，交给 Rust 流维护）：`freed_bytes` 必须是 u64，永远非负，
  // 这条链才成立；TS 侧不夹符号，负号会原样出现在记录里。
});
