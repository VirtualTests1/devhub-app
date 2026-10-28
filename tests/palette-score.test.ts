/**
 * 命令面板匹配规则（`src/lib/palette-score.ts`）的行为钉子（r21-R1-2）。
 *
 * 这个文件是抽取重构的**安全网**：`score()` 以前是 `CommandPalette.tsx` 里的私有
 * 函数，`.tsx` 在 Node 的类型剥离下根本加载不了，所以这条规则从未被测试跑过 ——
 * `docs/local-search-bm25.md` §6 记的「没有和 score() 做过对比」有一半原因就是它
 * 调不到。抽取时承诺「行为不变」，变没变由这里回答：三档分值、大小写、空查询、
 * 子序列的方向性，全部按抽取前的实现钉死。
 *
 * 外加一条来源守卫：面板只能从 `lib/palette-score` 取这条规则，自己不再声明一份 ——
 * 否则评测脚本测的那份和界面跑的那份会各自演化（`tests/single-source.test.ts` 的
 * 同一条纪律）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { score, scoreRow } from "../src/lib/palette-score.ts";

test("palette-score: 三档命中分值（前缀 3 / 子串 2 / 子序列 1）", () => {
  assert.equal(score("refresh scan 扫描 刷新", "refresh"), 3, "前缀命中");
  assert.equal(score("refresh scan 扫描 刷新", "scan"), 2, "子串命中但不是前缀");
  assert.equal(score("refresh scan 扫描 刷新", "rfh"), 1, "子序列：r-e-fresh 的首字母串");
  assert.equal(score("refresh", "zzz"), -1, "未命中是 -1，不是 0（0 留给空查询）");
});

test("palette-score: 大小写两侧都折叠，且用 toLowerCase 而不是 locale 变体", () => {
  assert.equal(score("CommandPalette", "commandpalette"), 3);
  assert.equal(score("commandpalette", "CommandPalette"), 3);
  assert.equal(score("GitHub.com/o/Repo", "REPO"), 2);
});

test("palette-score: 空查询返回 0 —— 面板靠它展示默认切片而不是全量打分", () => {
  assert.equal(score("refresh", ""), 0);
  assert.equal(score("", ""), 0);
  assert.equal(score("最近使用", ""), 0);
});

test("palette-score: 子序列是有序的，倒过来匹配不上", () => {
  // 逐字符推进的实现只往一个方向走：`hsr` 想在 `refresh` 里找 h→s→r，找到 h 之后
  // 再也没有 s，于是 i 停在 1。换成「字符集合」语义这里就会得 1，排序随之改变。
  assert.equal(score("refresh", "hsr"), -1);
  assert.equal(score("refresh", "rfh"), 1, "正序的首字母串能命中");
  assert.equal(score("abc", "abcd"), -1, "needle 比 haystack 还长不可能是子序列");
});

test("palette-score: scoreRow 取 label 与 keywords 里更好的那个", () => {
  // 与 CommandPalette 抽取前的 `Math.max(score(c.label, q), score(c.keywords, q))` 同式。
  assert.equal(scoreRow("刷新项目容器", "refresh scan 扫描 刷新", "refresh"), 3, "label 就是前缀");
  assert.equal(scoreRow("项目", "github.com/o/proj", "proj"), 2, "label 不中，keywords 中");
  assert.equal(scoreRow("项目", "github.com/o/proj", "刷"), -1, "都不中才是 -1");
  assert.equal(scoreRow("项目", "github.com/o/proj", ""), 0, "空查询两侧都是 0");
  assert.equal(
    scoreRow("scan", "github.com/o/proj", "scan"),
    Math.max(score("scan", "scan"), score("github.com/o/proj", "scan")),
    "scoreRow 就是两个 score 的最大值，没有第三套规则",
  );
});

test("palette-score: 面板只从 lib/palette-score 取规则，自己不再声明一份", () => {
  const source = readFileSync("src/components/CommandPalette.tsx", "utf8");
  assert.match(
    source,
    /import \{ scoreRow \} from "\.\.\/lib\/palette-score";/,
    "规则的唯一来源是 lib/palette-score",
  );
  assert.doesNotMatch(source, /function score\(/, "面板里不该再有私有的 score 声明");
});
