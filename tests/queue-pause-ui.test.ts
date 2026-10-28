/**
 * `src/components/DownloadQueue.tsx` — 暂停/继续的接线与词条（r25-N4）。
 *
 * 结构与上一轮的文件对话框一致：`.tsx` 在 `--experimental-strip-types` 下不能挂载，
 * 所以钉源码里的接线形状；行为规则在 `tests/downloads-pause.test.ts`，词条在这里
 * 直接问 `tFor`，不复制一份中英对照。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { tFor } from "../src/lib/i18n.ts";

const QUEUE = readFileSync("src/components/DownloadQueue.tsx", "utf8");
const STORE = readFileSync("src/store/downloads.ts", "utf8");

test("行内按钮：只给排队行，点击在读暂停位后切换", () => {
  assert.match(QUEUE, /import \{[\s\S]*?\bPause\b[\s\S]*?\bPlay\b[\s\S]*?\} from "lucide-react"/);
  assert.match(QUEUE, /\{task\.status === "queued" && \(/);
  assert.match(QUEUE, /onClick=\{\(\) => \(task\.paused \? resume\(id\) : pause\(id\)\)\}/);
  assert.match(QUEUE, /aria-pressed=\{task\.paused === true\}/);
  assert.match(QUEUE, /const pause = useDownloads\(\(s\) => s\.pause\)/);
  assert.match(QUEUE, /const resume = useDownloads\(\(s\) => s\.resume\)/);
});

test("右键菜单：暂停项对 running 禁用并说明原因", () => {
  assert.match(QUEUE, /id: "pause-or-resume"/);
  assert.match(QUEUE, /disabled: task\.status !== "queued"/);
  assert.match(QUEUE, /note: task\.status === "running" \? t\("queue\.pauseUnavailable"\) : undefined/);
});

test("头部与状态词：暂停数是排队数的子集，暂停行显示「已暂停」", () => {
  assert.match(QUEUE, /tally\.paused > 0 && t\("queue\.pausedTail", \{ n: tally\.paused \}\)/);
  assert.match(QUEUE, /case "queued": return paused \? t\("queue\.statusPaused"\) : t\("queue\.statusQueued"\)/);
  assert.match(QUEUE, /task\.paused \? t\("queue\.statusPaused"\) : t\("queue\.statusQueued"\)/);
  assert.match(STORE, /if \(t\.paused\) paused \+= 1/);
});

test("词条: zh/en 成对且模板变量一致", () => {
  assert.equal(tFor("zh-CN", "queue.pause"), "暂停排队");
  assert.equal(tFor("en", "queue.pause"), "Pause queued download");
  assert.equal(tFor("zh-CN", "queue.resume"), "继续排队");
  assert.equal(tFor("en", "queue.resume"), "Resume queued download");
  assert.equal(tFor("zh-CN", "queue.pauseAria", { ref: "o/r" }), "暂停 o/r 的排队");
  assert.equal(tFor("en", "queue.pauseAria", { ref: "o/r" }), "Pause queued download for o/r");
  assert.equal(tFor("zh-CN", "queue.resumeAria", { ref: "o/r" }), "继续 o/r 的排队");
  assert.equal(tFor("en", "queue.resumeAria", { ref: "o/r" }), "Resume queued download for o/r");
  assert.equal(tFor("zh-CN", "queue.pausedTail", { n: 2 }), " · 2 已暂停");
  assert.equal(tFor("en", "queue.pausedTail", { n: 2 }), " · 2 paused");
  assert.equal(tFor("zh-CN", "queue.statusPaused"), "已暂停");
  assert.equal(tFor("en", "queue.statusPaused"), "Paused");
});

test("取消（r27-O2）：运行行有取消按钮，右键菜单也有；移除对 running 关闭", () => {
  assert.match(QUEUE, /const cancel = useDownloads\(\(s\) => s\.cancel\)/);
  assert.match(QUEUE, /\{task\.status === "running" && \(/);
  assert.match(QUEUE, /disabled=\{task\.cancelRequested === true\}/);
  assert.match(QUEUE, /id: "cancel"/);
  assert.match(QUEUE, /disabled: task\.status !== "running" \|\| task\.cancelRequested === true/);
  assert.match(QUEUE, /id: "remove"[\s\S]{0,500}disabled: task\.status === "running"/);
  assert.match(QUEUE, /note: task\.status === "running" \? t\("queue\.cancelFirst"\) : undefined/);
  assert.match(STORE, /invoke<boolean>\("cancel_download", \{ task: id \}\)/);
  assert.match(STORE, /const cancelled = Boolean\(target\.cancelRequested\) && Boolean\(failure\)/);
});

test("取消词条：zh/en 成对且模板变量一致", () => {
  assert.equal(tFor("zh-CN", "queue.cancel"), "取消下载");
  assert.equal(tFor("en", "queue.cancel"), "Cancel download");
  assert.equal(tFor("zh-CN", "queue.cancelling"), "取消中…");
  assert.equal(tFor("en", "queue.cancelling"), "Cancelling…");
  assert.equal(tFor("zh-CN", "queue.cancelled"), "已取消");
  assert.equal(tFor("en", "queue.cancelled"), "Cancelled");
  assert.equal(tFor("zh-CN", "queue.cancelAria", { ref: "o/r" }), "取消 o/r 的下载");
  assert.equal(tFor("en", "queue.cancelAria", { ref: "o/r" }), "Cancel the download of o/r");
  assert.equal(tFor("zh-CN", "queue.cancelledToast", { ref: "o/r" }), "o/r 已取消");
  assert.equal(tFor("en", "queue.cancelledToast", { ref: "o/r" }), "o/r cancelled");
});
