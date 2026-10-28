/**
 * `src/shell/StatusStrip.tsx` — the download numbers come from the store's
 * one-pass tally, in one subscription.
 *
 * The defect (r16-o4-2): the strip ran five separate passes over `s.tasks` per
 * progress notification — four `filter(...).length` selectors plus a fifth loop
 * for `headline` — while `src/store/downloads.ts` already exported
 * `countByStatus()`, a one-pass tally whose own doc comment names StatusStrip as
 * the intended consumer (`tests/downloads-pure.test.ts` pins its semantics).
 *
 * The displayed numbers must not change: 未完成 stays `status !== "done"`
 * (running + queued + failed), which is NOT `finished`'s complement — the
 * store's `finished` is done+failed, the rows `clearFinished` removes. The
 * combinational identity is pinned here next to the structure, because "one
 * subscription" is worth nothing if the numbers quietly became different ones.
 *
 * Structural, same harness as `tests/statusstrip-nesting.test.ts`: `.tsx` cannot
 * be mounted under `--experimental-strip-types` (DEVELOPMENT.md §8.1).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const STRIP = "src/shell/StatusStrip.tsx";

/** Code only, line numbers preserved. */
function codeOnly(src: string): string[] {
  const kept: string[] = [];
  let inBlock = false;
  for (const raw of src.split(/\r?\n/)) {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf("*/");
      if (end < 0) {
        kept.push("");
        continue;
      }
      line = line.slice(end + 2);
      inBlock = false;
    }
    const open = line.indexOf("/*");
    if (open >= 0) {
      const close = line.indexOf("*/", open + 2);
      if (close >= 0) line = line.slice(0, open) + line.slice(close + 2);
      else {
        line = line.slice(0, open);
        inBlock = true;
      }
    }
    const slash = line.indexOf("//");
    kept.push(slash >= 0 ? line.slice(0, slash) : line);
  }
  return kept;
}

const lines = codeOnly(readFileSync(STRIP, "utf8"));
const code = lines.join("\n");

test("状态条不再自己 filter 任务数组——计数走 store 的 countByStatus", () => {
  assert.match(
    code,
    /import \{ countByStatus, useDownloads \} from "\.\.\/store\/downloads"/,
    "the tally is the store's export, not a re-derivation",
  );
  assert.match(code, /countByStatus\(s\.tasks\)/, "the strip's selector calls it on the live tasks");
  assert.doesNotMatch(
    code,
    /s\.tasks\.filter\(/,
    "no per-status filter left in the strip's own selectors — the five passes this replaces",
  );
});

test("一条 useShallow 订阅装下三个计数、未完成与 headline", () => {
  assert.match(code, /useDownloads\(\s*useShallow\(\(s\) => \{/, "one shallow-compared object subscription");
  // Every value the strip renders from downloads comes out of that one object.
  for (const field of ["running: tally.running", "queued: tally.queued", "failed: tally.failed", "headline:"]) {
    assert.ok(code.includes(field), `${field} is part of the single selector's result`);
  }
  // 未完成 = status !== "done" = running+queued+failed — the same number the old
  // `s.tasks.filter((t) => t.status !== "done").length` produced. It is
  // deliberately NOT `finished`'s complement (that would drop the failures the
  // popover still lists).
  assert.match(
    code,
    /unfinished: tally\.running \+ tally\.queued \+ tally\.failed/,
    "未完成 keeps the status !== \"done\" definition, derived from the one tally",
  );
});

test("strip 展示的字段名一个没变（胶囊与文案照旧）", () => {
  // The JSX below the selector still reads the same identifiers, so the pills
  // and their pinned labels (statusstrip-nesting / pill-contrast) are untouched.
  // r16-n2-2 moved the three Chinese templates into `lib/i18n.ts`'s `strip.*`
  // entries: what is pinned here is now the wiring — key plus the identifier
  // that feeds it — and the zh-CN wording itself is pinned byte for byte in
  // `tests/i18n.test.ts` (下载中 3 (+2 排队) / 下载失败 1), so a rewrite of the
  // copy still fails the gate rather than sliding through this file.
  assert.match(code, /t\("strip\.downloadFailed", \{ n: dlFailed \}\)/, "the failure count is still in the label");
  assert.match(code, /t\("strip\.downloading", \{ n: dlRunning \}\)/, "and the running count with it");
  assert.match(code, /t\("strip\.queued", \{ n: dlQueued \}\)/, "and the queued offset");
  assert.match(code, /dlUnfinished > 0 && \(/, "the popover section still keys on 未完成");
});
