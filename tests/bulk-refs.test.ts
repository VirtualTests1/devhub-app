/**
 * `src/lib/bulk-refs.ts` — 批量粘贴的解析与上限。
 *
 * 规则只有两条值得反复看：什么算一个仓库（复用 `parseGithubRepoUrl`，裸
 * `owner/repo` 只收两段安全字符），以及超过 20 个时哪一个进队列（先到先得，
 * 后面的报 overflow，不静默丢）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { BULK_MAX, normalizeBulkRef, parseBulkRefs } from "../src/lib/bulk-refs.ts";

test("normalizeBulkRef: URL、.git、裸 slug、SSH 四种写法都归一到 owner/repo", () => {
  assert.equal(normalizeBulkRef("https://github.com/rust-lang/rust"), "rust-lang/rust");
  assert.equal(normalizeBulkRef("https://github.com/rust-lang/rust.git"), "rust-lang/rust");
  assert.equal(normalizeBulkRef("github.com/rust-lang/rust/tree/main"), "rust-lang/rust");
  assert.equal(normalizeBulkRef("tauri-apps/tauri"), "tauri-apps/tauri");
  assert.equal(normalizeBulkRef("git@github.com:tauri-apps/tauri.git"), "tauri-apps/tauri");
  assert.equal(normalizeBulkRef('  "- owner/repo"  '), "owner/repo", "列表符号与引号被剥掉");
});

test("normalizeBulkRef: 非 GitHub、保留路由、三段路径、点段一律拒绝", () => {
  assert.equal(normalizeBulkRef("https://gitlab.com/a/b"), null);
  assert.equal(normalizeBulkRef("https://github.com/settings/profile"), null);
  assert.equal(normalizeBulkRef("a/b/c"), null);
  assert.equal(normalizeBulkRef("../etc"), null);
  assert.equal(normalizeBulkRef("owner/../repo"), null);
  assert.equal(normalizeBulkRef(""), null);
});

test("parseBulkRefs: 换行 / 逗号 / 分号 / Tab 都是分隔符，空行忽略", () => {
  const parsed = parseBulkRefs(`
    rust-lang/rust
    https://github.com/tauri-apps/tauri,  serde-rs/serde;
    tokio-rs/tokio\tcli/cli
  `);
  assert.deepEqual(parsed.accepted, [
    "rust-lang/rust",
    "tauri-apps/tauri",
    "serde-rs/serde",
    "tokio-rs/tokio",
    "cli/cli",
  ]);
  assert.deepEqual(parsed.invalid, []);
  assert.equal(parsed.overflow, 0);
});

test("parseBulkRefs: 重复按不区分大小写去重，保留第一次的拼写", () => {
  const parsed = parseBulkRefs("Rust-Lang/Rust\nrust-lang/rust\nRust-Lang/Rust");
  assert.deepEqual(parsed.accepted, ["Rust-Lang/Rust"]);
  assert.deepEqual(parsed.duplicates, ["rust-lang/rust"]);
});

test("parseBulkRefs: 无效行带序号返回，不占 accepted 名额", () => {
  const parsed = parseBulkRefs("rust-lang/rust\nnot a repo\nhttps://gitlab.com/a/b\n\nfine/repo");
  assert.deepEqual(parsed.accepted, ["rust-lang/rust", "fine/repo"]);
  assert.deepEqual(parsed.invalid.map((i) => i.text), ["not a repo", "https://gitlab.com/a/b"]);
  assert.deepEqual(parsed.invalid.map((i) => i.at), [2, 3], "at 是第几个非空 token，不是行号");
});

test("parseBulkRefs: 第 21 个有效且唯一的仓库进入 overflow，不静默丢", () => {
  const lines = Array.from({ length: BULK_MAX + 3 }, (_, i) => `owner/repo-${i}`);
  const parsed = parseBulkRefs(lines.join("\n"));
  assert.equal(parsed.accepted.length, BULK_MAX);
  assert.equal(parsed.overflow, 3);
  assert.equal(parsed.accepted[BULK_MAX - 1], `owner/repo-${BULK_MAX - 1}`);
});

test("parseBulkRefs: 自定义 max 也生效（测试与 UI 不为上限各写一份）", () => {
  const parsed = parseBulkRefs("a/1\nb/2\nc/3", 2);
  assert.deepEqual(parsed.accepted, ["a/1", "b/2"]);
  assert.equal(parsed.overflow, 1);
});
