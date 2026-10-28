/**
 * `src/lib/update-repo.ts` — the wall's 更新 (`git pull --ff-only`) call path.
 *
 * The tile menu and 批量更新 share this one function, so the two things that must
 * not drift are exactly the two things a reviewer cannot check by reading one
 * file: what a successful pull *says* (a `null` commit count is not "0 个新提交")
 * and what a refused one *says* (`AllLayersFailed` prints a download's header
 * over a pull, then repeats git's local refusal once per layer). Both are wording
 * decisions with a right and a wrong answer, and both are reachable from Node
 * with a stub invoker — no Tauri, no webview, no network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyUpdateFailure,
  compactUpdateFailure,
  describeUpdateOutcome,
  updateFailureLine,
  updateOneRepo,
} from "../src/lib/update-repo.ts";
import type { UpdateOutcome } from "../src/types.ts";

/** The smallest payload the wording functions read; `attempts` is never printed. */
function outcome(of: Partial<UpdateOutcome> = {}): UpdateOutcome {
  return {
    layer: "direct",
    path: "D:/x",
    before: "a1b2c3d",
    after: "e4f5g6h",
    commits: 3,
    viaThirdParty: false,
    attempts: [],
    ...of,
  };
}

test("describeUpdateOutcome: a moved HEAD reports the commits it took", () => {
  assert.equal(
    describeUpdateOutcome(outcome()),
    "已快进 a1b2c3d → e4f5g6h，新增 3 个提交（链路 直连）",
  );
});

test("describeUpdateOutcome: before === after is 已是最新, not 已快进 0 个提交", () => {
  const text = describeUpdateOutcome(outcome({ before: "a1b2c3d", after: "a1b2c3d", commits: 0 }));
  assert.match(text, /^已是最新（HEAD a1b2c3d，链路 直连）$/);
  assert.ok(!text.includes("已快进"), text);
});

test("describeUpdateOutcome: an uncountable pull never claims a number", () => {
  const text = describeUpdateOutcome(outcome({ commits: null }));
  assert.ok(!text.includes("新增"), text);
  assert.ok(!/新增 \d+ 个提交/.test(text), text);
  assert.ok(text.includes("数不出提交数"), text);
  // The lie this replaces: `commits ?? 0` would have printed a count for a
  // shallow clone where git simply would not say.
  assert.ok(!text.includes("，新增 0 个提交"), text);
});

test("describeUpdateOutcome: a third-party layer is printed, not hidden", () => {
  const text = describeUpdateOutcome(outcome({ layer: "mirror", viaThirdParty: true }));
  assert.match(text, /第三方镜像/);
  assert.match(text, /异常/);
});

test("compactUpdateFailure: a single-line rejection keeps the backend's own words", () => {
  for (const raw of [
    "IO 错误: 这个目录没有 git 历史（压缩包下载的仓库），无法更新，只能重新下载",
    "找不到 git。已查找系统 PATH 与应用内置 runtime\\git，均未找到。",
    "未找到仓库: github.com/a/b",
  ]) {
    assert.equal(compactUpdateFailure(raw), raw);
  }
});

test("compactUpdateFailure: the download header and the per-layer repeats fold away", () => {
  const raw =
    "四条下载路径全部失败：\n" +
    "  [失败] 直连 -> error: Your local changes to the following files would be overwritten by merge\n" +
    "  [失败] IP 钉死 (140.82.112.3，保留证书校验) -> error: Your local changes to the following files would be overwritten by merge\n";
  const text = compactUpdateFailure(raw);
  assert.ok(!text.includes("四条下载路径全部失败"), text);
  assert.equal(
    text,
    "error: Your local changes to the following files would be overwritten by merge（2 条链路同一原因）",
  );
});

test("compactUpdateFailure: different causes keep which layer said what", () => {
  const raw =
    "四条下载路径全部失败：\n" +
    "  [失败] 直连 -> fatal: unable to access: Recv failure: Connection was reset\n" +
    "  [失败] 本地代理 -> fatal: unable to access: Could not connect to server\n";
  const text = compactUpdateFailure(raw);
  assert.match(text, /直连：.*Connection was reset/);
  assert.match(text, /本地代理：.*Could not connect to server/);
});

test("compactUpdateFailure: a successful layer's row is not reported as a refusal", () => {
  // `finish_update` appends a `[失败] 写回 .devhub.json（lastPull）` row when the
  // pull worked and only the stamp failed; the count of *roads* must not absorb it.
  const raw =
    "四条下载路径全部失败：\n" +
    "  [成功] 直连 -> 已快进\n" +
    "  [失败] 写回 .devhub.json（lastPull） -> 只读文件系统\n";
  const text = compactUpdateFailure(raw);
  assert.match(text, /写回 \.devhub\.json（lastPull）：只读文件系统/);
  assert.ok(!text.includes("同一原因"), text);
});

test("classifyUpdateFailure: causes a retry cannot fix get a different next step", () => {
  for (const [raw, re] of [
    ["IO 错误: 这个目录没有 git 历史（压缩包下载的仓库），无法更新，只能重新下载", /重新下载/],
    ["找不到 git。已查找系统 PATH 与应用内置 runtime\\git，均未找到。", /winget install Git\.Git/],
    ["IO 错误: 找不到远程地址：.devhub.json 和 git remote 都没有", /git remote/],
    ["未找到仓库: github.com/a/b", /设置/],
    ["仓库不存在或没有访问权限: github.com/a/b", /私有/],
  ] as const) {
    const f = classifyUpdateFailure(raw);
    assert.equal(f.retryable, false, raw);
    assert.ok(f.remedy && re.test(f.remedy), `${raw} → ${f.remedy}`);
  }
});

test("classifyUpdateFailure: git's own refusals stay retryable, with the fix named", () => {
  const dirty = classifyUpdateFailure(
    "四条下载路径全部失败：\n  [失败] 直连 -> error: Your local changes to the following files would be overwritten by merge\n",
  );
  assert.equal(dirty.retryable, true);
  assert.match(dirty.remedy ?? "", /stash|提交/);

  const diverged = classifyUpdateFailure(
    "四条下载路径全部失败：\n  [失败] 直连 -> fatal: Not possible to fast-forward, aborting.\n",
  );
  assert.equal(diverged.retryable, true);
  assert.match(diverged.remedy ?? "", /分叉/);

  const timedOut = classifyUpdateFailure("操作超时: git 在 45 秒内没有答话（超过 45 秒无响应）");
  assert.equal(timedOut.retryable, true);
  assert.match(timedOut.remedy ?? "", /重试/);
});

test("classifyUpdateFailure: an unrecognised reason is retryable with no invented remedy", () => {
  const f = classifyUpdateFailure("更新任务异常: task killed");
  assert.equal(f.retryable, true);
  assert.equal(f.remedy, null);
});

test("updateFailureLine: a batch row carries the next step, not just the bad news", () => {
  assert.equal(
    updateFailureLine({ detail: "fatal: Not possible to fast-forward, aborting.", remedy: null }),
    "fatal: Not possible to fast-forward, aborting.",
  );
  assert.equal(
    updateFailureLine({ detail: "拒绝", remedy: "先提交或 stash。" }),
    "拒绝；先提交或 stash。",
  );
});

test("updateOneRepo: the happy path returns the sentence and the raw outcome", async () => {
  const seen: string[] = [];
  const res = await updateOneRepo("github.com/a/b", async (slug) => {
    seen.push(slug);
    return outcome();
  });
  assert.deepEqual(seen, ["github.com/a/b"]);
  assert.equal(res.ok, true);
  assert.equal(res.detail, "已快进 a1b2c3d → e4f5g6h，新增 3 个提交（链路 直连）");
});

test("updateOneRepo: a rejection becomes a result, never an exception", async () => {
  // The batch runner keeps going after one card refuses; a throw here would abort
  // the whole selection in `BatchBar`'s catch instead of naming this repository.
  const res = await updateOneRepo("github.com/a/b", async () => {
    throw "四条下载路径全部失败：\n  [失败] 直连 -> fatal: Not possible to fast-forward, aborting.\n";
  });
  if (res.ok) throw new Error("expected a refusal, got an outcome");
  assert.match(res.detail, /Not possible to fast-forward/);
  assert.equal(res.retryable, true);
});

test("updateOneRepo: a non-Error rejection is readable prose, not [object Object]", () => {
  // `messageOf` owns that rule; this pins that the update path actually goes
  // through it rather than stringifying whatever the command threw.
  return updateOneRepo("s", async () => {
    throw { weird: true };
  }).then((res) => {
    assert.equal(res.ok, false);
    if (res.ok) throw new Error("unreachable");
    assert.equal(res.detail, "后端未返回原因");
  });
});

test("describeUpdateOutcome: 新提交列表只取最近 3 条并说明还有多少", () => {
  const text = describeUpdateOutcome(
    outcome({
      recent: [
        { hash: "aaaaaaa", subject: "one" },
        { hash: "bbbbbbb", subject: "two" },
        { hash: "ccccccc", subject: "three" },
        { hash: "ddddddd", subject: "four" },
      ],
    }),
  );
  assert.ok(text.includes("ddddddd four"), text);
  assert.ok(text.includes("ccccccc three"), text);
  assert.ok(text.includes("bbbbbbb two"), text);
  assert.ok(!text.includes("aaaaaaa one"), "older commits belong to the panel, not the batch line");
  assert.ok(text.includes("等 4 个"), text);
});

test("RepoSyncPanel: 更新成功后展开完整提交列表", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("src/components/RepoSyncPanel.tsx", "utf8");
  assert.match(src, /outcome\.recent\?\.length/);
  assert.match(src, /t\("sync\.recent", \{ n: outcome\.recent\?\.length \?\? 0 \}\)/);
  assert.match(src, /outcome\.recent\?\.map/);
});
