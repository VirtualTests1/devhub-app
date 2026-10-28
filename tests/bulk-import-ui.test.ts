/**
 * `src/views/AddRepoView.tsx` — bulk import wiring.
 *
 * The parser is covered by `tests/bulk-refs.test.ts`; the parts here are the
 * promises a pure test cannot see: every accepted ref goes through the SAME
 * `onDownload` the composer uses, overwrite is never inherited from a checkbox
 * meant for one repository, and the button says how many will queue.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tFor } from "../src/lib/i18n.ts";

const VIEW = readFileSync("src/views/AddRepoView.tsx", "utf8");

test("接线: 解析器来自 lib，输入变化即重算（不缓存旧粘贴）", () => {
  assert.match(VIEW, /import \{ BULK_MAX, parseBulkRefs \} from "\.\.\/lib\/bulk-refs"/);
  assert.match(VIEW, /const bulk = useMemo\(\(\) => parseBulkRefs\(bulkText\), \[bulkText\]\)/);
});

test("接线: 逐个入队，复用 onDownload，且批量永不覆盖已有目录", () => {
  assert.match(VIEW, /for \(const ref of bulk\.accepted\) \{[\s\S]*?onDownload\(\s*ref,\s*t\("add\.bulkSource"\),\s*targetOverride \|\| undefined,\s*false,\s*branch\.trim\(\) \|\| undefined,?\s*\)/);
});

test("接线: 无效行与超限不静默消失，按钮在无可入队项或 git 未就绪时禁用", () => {
  assert.match(VIEW, /t\("add\.bulkInvalid", \{ n: bulk\.invalid\.length \}\)/);
  assert.match(VIEW, /t\("add\.bulkOverflow", \{ n: bulk\.overflow \}\)/);
  assert.match(VIEW, /disabled=\{!bulk\.accepted\.length \|\| !gitReady\}/);
  assert.match(VIEW, /toast\.success\(t\("add\.bulkQueued", \{ n: bulk\.accepted\.length \}\)\)/);
});

test("词条: zh/en 成对，按钮带数量", () => {
  assert.equal(tFor("zh-CN", "add.bulkTitle"), "批量导入");
  assert.equal(tFor("en", "add.bulkTitle"), "Bulk import");
  assert.equal(tFor("zh-CN", "add.bulkQueue", { n: 3 }), "加入下载队列（3）");
  assert.equal(tFor("en", "add.bulkQueue", { n: 3 }), "Add to download queue (3)");
});
