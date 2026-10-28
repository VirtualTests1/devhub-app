/**
 * `src/components/DownloadProgress.tsx` + `DownloadQueue.tsx` — speed/ETA wiring.
 *
 * The parser and estimator are covered by `tests/download-rate.test.ts`. What is
 * pinned here: the component reads git's line through the pure parser (no second
 * percent regex), the store's arrival time reaches the sampler, and the numbers
 * disappear while stalled — a stale "12 MB/s" next to a frozen bar is worse than
 * saying "已 N 秒无更新".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tFor } from "../src/lib/i18n.ts";

const PROGRESS = readFileSync("src/components/DownloadProgress.tsx", "utf8");
const QUEUE = readFileSync("src/components/DownloadQueue.tsx", "utf8");

test("接线: 百分比与速率来自 parseGitProgress，ETA 来自 estimateEta", () => {
  assert.match(PROGRESS, /import \{[\s\S]*?parseGitProgress[\s\S]*?\} from "\.\.\/lib\/download-rate"/);
  assert.match(PROGRESS, /const parsedProgress = parseGitProgress\(progress\?\.message\)/);
  assert.match(PROGRESS, /const percent = parsedProgress\.percent/);
  assert.match(PROGRESS, /estimateEta\(samples\)/);
  assert.doesNotMatch(PROGRESS, /function percentOf/, "旧的百分比正则已搬进纯模块，不在 .tsx 里留副本");
});

test("接线: store 的到达时间传入采样器；卡住时不显示速率/ETA", () => {
  assert.match(QUEUE, /progressAt=\{task\.progressAt\}/);
  assert.match(PROGRESS, /pushRateSample\(samplesRef\.current, parsed\.percent, progressAt \?\? Date\.now\(\)\)/);
  assert.match(PROGRESS, /\{!stalled && \(rate\.bytesPerSec != null \|\| rate\.etaMs != null\)/);
  assert.match(PROGRESS, /t\("dl\.rate", \{ speed: `\$\{formatBytes\(rate\.bytesPerSec\)\}\/s` \}\)/);
  assert.match(PROGRESS, /t\("dl\.eta", \{ eta: formatEta\(rate\.etaMs\) \}\)/);
});

test("词条: zh/en 成对", () => {
  assert.equal(tFor("zh-CN", "dl.rate", { speed: "3.4 MB/s" }), "速度 3.4 MB/s");
  assert.equal(tFor("en", "dl.rate", { speed: "3.4 MB/s" }), "Speed 3.4 MB/s");
  assert.equal(tFor("zh-CN", "dl.eta", { eta: "0:08" }), "剩余约 0:08");
  assert.equal(tFor("en", "dl.eta", { eta: "0:08" }), "About 0:08 remaining");
});
