/**
 * The pure half of the local-README preview (round 17, n2-3).
 *
 * `lib/readme.ts` holds the three decisions the dialog would otherwise keep
 * inside a `.tsx` no test can import (the Node runner strips types and refuses
 * `.tsx` — see `tests/lib-import-graph.test.ts`): which filenames to probe,
 * where to cut an over-long file, and which backend refusal means "not there".
 *
 * Each one is asserted against the exact degradation the dialog has to make
 * honestly, because a blank screen — or a wrong "no README" — is the failure
 * this whole direction exists to prevent.
 *
 * Node native runner, `.ts` only (no JSX, no enum, no namespace).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  README_CANDIDATES,
  README_MAX_BYTES,
  capUtf8,
  isMissingFileReason,
} from "../src/lib/readme.ts";

// ---------------------------------------------------------------------------
// 1. Which filenames the dialog probes

test("readme 候选文件名：README.md 起、README 收，四个互不相同", () => {
  // GitHub's own order matters: README.md is what most repositories use, so it is
  // the first IPC the probe ever spends; README (no extension) is the rarer last
  // resort. Pinning the whole list also pins the order the dialog wastes calls in.
  assert.deepEqual(
    [...README_CANDIDATES],
    ["README.md", "readme.md", "README.markdown", "README"],
  );
  assert.equal(new Set(README_CANDIDATES).size, README_CANDIDATES.length, "duplicate candidate");
  for (const name of README_CANDIDATES) {
    assert.ok(name.trim() !== "", "an empty candidate would ask for the directory itself");
  }
  // The i18n `readme.notFound` copy spells the same four out; a fifth here without
  // updating that sentence would tell the user a probe ran that it did not.
  assert.equal(README_CANDIDATES.length, 4);
});

// ---------------------------------------------------------------------------
// 2. How much of the file is rendered

test("readme 截断：不超上限原样返回，且不报截断", () => {
  assert.deepEqual(capUtf8("hello"), { text: "hello", truncated: false });
  const atLimit = "a".repeat(10);
  assert.deepEqual(capUtf8(atLimit, 10), { text: atLimit, truncated: false });
});

test("readme 截断：超一个字节就截断，结果恰好到上限", () => {
  const out = capUtf8("a".repeat(11), 10);
  assert.equal(out.truncated, true);
  assert.equal(out.text, "a".repeat(10));
});

test("readme 截断：默认上限是 256 KB", () => {
  assert.equal(README_MAX_BYTES, 256 * 1024);
  const exact = "x".repeat(README_MAX_BYTES);
  assert.deepEqual(capUtf8(exact), { text: exact, truncated: false });
  const over = "x".repeat(README_MAX_BYTES + 1);
  const out = capUtf8(over);
  assert.equal(out.truncated, true);
  assert.equal(out.text.length, README_MAX_BYTES);
});

test("readme 截断：切在码点边界上，不产出 � 替换字符", () => {
  // 「中」is three UTF-8 bytes; a 4-byte limit lands one byte into the second
  // character. A naive `slice(0, limit)` + decode leaves that half-character as
  // U+FFFD, which the reader would see as the file's own text.
  const raw = "中".repeat(10);
  const out = capUtf8(raw, 4);
  assert.equal(out.truncated, true);
  assert.equal(out.text, "中");
  assert.ok(!out.text.includes("\uFFFD"), "a split byte decoded as the replacement char");
  // A four-byte emoji, cut just after it, must survive whole.
  assert.equal(capUtf8("😀abc", 5).text, "😀a");
});

test("readme 截断：任何上限下结果都是原文前缀、字节不越界、无替换字符", () => {
  const raw = "a中b😀c".repeat(50);
  const bytes = new TextEncoder().encode(raw).length;
  for (const limit of [0, 1, 2, 3, 4, 5, 7, 11, 100, bytes - 1, bytes, bytes + 1]) {
    const out = capUtf8(raw, limit);
    const got = new TextEncoder().encode(out.text).length;
    assert.ok(got <= Math.max(0, limit), `limit=${limit}: emitted ${got} bytes`);
    assert.ok(raw.startsWith(out.text), `limit=${limit}: not a prefix of the source`);
    assert.ok(!out.text.includes("\uFFFD"), `limit=${limit}: emitted U+FFFD`);
    assert.equal(out.truncated, bytes > limit, `limit=${limit}: wrong truncated flag`);
  }
});

// ---------------------------------------------------------------------------
// 3. Which refusal means "there is no such file"

test("readme 不存在判定：只认后端 path_guard 的 (missing) 后缀", () => {
  // The real sentence, as `GuardError::Display` renders it.
  assert.equal(isMissingFileReason(String.raw`路径不存在或无法解析：C:\clones\o\r\README.md (missing)`), true);
  assert.equal(isMissingFileReason("(missing)"), true);
  // Every other refusal is a real failure for that candidate and must be surfaced,
  // never silently retried into "this repository has no README".
  assert.equal(isMissingFileReason("拒绝访问：… 不在 DevHub 允许的目录内（已检查 8 个）(outside-roots)"), false);
  assert.equal(isMissingFileReason("拒绝访问：… 是 DevHub 自己的配置文件 (denied)"), false);
  assert.equal(isMissingFileReason("路径包含非法字符 (traversal)"), false);
  assert.equal(isMissingFileReason("文件过大"), false);
  assert.equal(isMissingFileReason("文件不是 UTF-8 文本"), false);
  assert.equal(isMissingFileReason(""), false);
});

test("readme 不存在判定：路径里带 (missing) 的目录不会被误判成缺文件", () => {
  // `GuardError::Missing { shown }` puts the *path* in the sentence, so a
  // substring match would read a denied path that merely contains `(missing)` as
  // a missing file and skip a candidate that is really there.
  assert.equal(
    isMissingFileReason(String.raw`拒绝访问：C:\roots\a (missing) dir\README.md (denied)`),
    false,
  );
  // The suffix test still accepts a genuinely missing file whose path ends with
  // the same token — the code is appended after the path, so the suffix is the code.
  assert.equal(isMissingFileReason(String.raw`路径不存在或无法解析：C:\roots\a (missing) (missing)`), true);
});
