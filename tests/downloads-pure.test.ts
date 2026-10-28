/**
 * `src/store/downloads.ts` 纯路由/计数辅助的表征测试（characterization）。
 *
 * 这些断言钉的是**当前**的语义。它们只会在 `downloads.ts` 能从 Node 导入时才注册。
 * 本文件写作那天它还导入不了（`downloads.ts:5` 当时写 `import { toast } from
 * "../components/Toast"`，一个 `.tsx`，`node --test` 拒收）；`feat/r15-correct-2`
 * 把那一行改指 `../store/toast`（同一个再导出对象）后，整组用例这才真的跑起来。
 * 因此下面有几条跟着合并后的代码改了：跑起来之前它们从未被执行过。
 *
 * 两处跟着改动：
 *   - 未打标 progress 的投递对象：`feat/r15-correct-3` 修了路由，见该用例；
 *   - `activeDownloadCount`：这个导出早在 `5dfdc89`（r14-d10 死导出清理）就删了，
 *     用例当时因整块不执行而没报错，现在删掉，running+queued 的计数由上面的
 *     `countByStatus` 三条覆盖。
 * 最后那个哨兵用例原本证明"导入失败"，前提反过来了，于是它现在证明"导入成功"。
 *
 * 类型怎么引用：仍然不用 `typeof import(".../downloads.ts")`。这个写法当初是为避开
 * 它 import 的 `Toast.tsx`（测试工程故意没配 `--jsx`，配了就等于宣称能在这一层看 view
 * 文件）；那一行现在指回 `store/toast` 了，但结构类型的写法留着更划算——`downloads.ts`
 * 将来再拖进任何一个 `.tsx`，`tsc -p tsconfig.tests.json` 不会跟着一起挂，失败会落在
 * 上面那条哨兵与 `tests/lib-import-graph.test.ts` 上，那才是该响的地方。
 *
 * 每条期望值都是用一次性重定向加载器在真实 `downloads.ts` 上跑出来的，不是猜的：
 * appendLog 的折叠算式、stages 上限 12、按 ref/未打标路由、landing 的 trim 全部实测过。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { at } from "./helpers/definite.ts";

/** 最小结构镜像——只覆盖本文件用到的动作与字段。 */
type Status = string; // 真实是并集；这里放宽，好让兜底用例喂得进 "bogus"。
type TaskLite = {
  id: string;
  ref: string;
  source: string;
  targetDir?: string;
  overwrite?: boolean;
  startedAt: number;
  endedAt?: number;
  log: string[];
  stages: string[];
  progress: unknown;
  outcome: unknown;
  failure: string | null;
  status: Status;
  lastLine: string;
};
type Tally = { running: number; queued: number; paused: number; failed: number; finished: number };
type State = {
  tasks: TaskLite[];
  maxParallel: number;
  applyProgress: (ev: Record<string, unknown>) => void;
  finish: (id: string, outcome: unknown, failure: string | null) => void;
  dismiss: (id: string) => void;
  clearFinished: () => void;
};
type DlMod = {
  useDownloads: { getState: () => State; setState: (partial: Partial<State>) => void };
  countByStatus: (tasks: readonly TaskLite[]) => Tally;
};

// 运行时拼接，避免 tsc 把说明符当作可静态解析的字符串字面量而跟进 Toast.tsx。
const storeDir = "../src/store/";

let mod: DlMod | null = null;
let loadError: unknown = null;
try {
  mod = (await import(`${storeDir}downloads.ts`)) as unknown as DlMod;
} catch (e) {
  loadError = e;
}

/** 反向守卫：`feat/r15-correct-2` 把 toast 导入指回 `store/toast` 后，本块用例
 *  才第一次真的执行。这条钉住那个前提——它一旦退回 `.tsx`，上面整块会静默消失，
 *  没有这条就成了"绿色但什么都没跑"。 */
test("downloads.ts 从 Node 可达：toast 导入不再拖进 components/Toast.tsx", () => {
  assert.equal(loadError, null, `downloads.ts 应能被 Node 导入：${String((loadError as { message?: string })?.message ?? "")}`);
  assert.ok(mod, "整组表征用例因此真的注册并执行");
});

function mkTask(id: string, status: Status, extra: Partial<TaskLite> = {}): TaskLite {
  return {
    id,
    ref: id,
    source: "s",
    startedAt: 0,
    log: [],
    stages: [],
    progress: null,
    outcome: null,
    failure: null,
    status,
    lastLine: "",
    ...extra,
  };
}

if (mod) {
  const m = mod;

  // --- countByStatus：一遍扫出四个计数，finished = done + failed ----------------

  test("countByStatus: 空队列全 0", () => {
    assert.deepEqual(m.countByStatus([]), { running: 0, queued: 0, paused: 0, failed: 0, finished: 0 });
  });

  test("countByStatus: 逐状态计数，finished = done + failed", () => {
    const tally = m.countByStatus([
      mkTask("a", "running"),
      mkTask("b", "running"),
      mkTask("c", "queued"),
      mkTask("d", "failed"),
      mkTask("e", "done"),
    ]);
    assert.deepEqual(tally, { running: 2, queued: 1, paused: 0, failed: 1, finished: 2 });
    // finished 的定义正是 clearFinished 会移除的行：done + failed。
  });

  test("countByStatus: 兜底 else 把任何非 running/queued/failed 都算成 done（表征）", () => {
    // 今天它用 `else done += 1` 收尾，所以一个未知/未来新增的 status 会悄悄进 finished，
    // 进而被 clearFinished 当作"已完成"清掉。语义可疑，如实钉下来。
    assert.deepEqual(m.countByStatus([mkTask("x", "bogus")]), { running: 0, queued: 0, paused: 0, failed: 0, finished: 1 });
  });

  // --- 未打标 progress 事件投递给"调度器先服务的那条" running —— r15-correct-3 已修 ---

  test("applyProgress(未打标): 发给等待最久的 running（= 调度器先启动的那条）", () => {
    // 本用例写作时钉的是当时的 bug：数组 newest-first（add 用 unshift），旧的
    // `.find(t => t.status === "running")` 于是命中 **最新** 那条 running，而调度器
    // pump 反向遍历、把空出来的槽给 **最旧** 那条 queued——两处对"先服务谁"的判断
    // 正好相反。`feat/r15-correct-3` 让两边读同一个 `inServiceOrder`
    // （`src/store/downloads.ts:146`），未打标事件因此落到调度器先启动的那条上。
    // 表征跟着改成修复后的语义；正面用例在 `tests/downloads-routing.test.ts`。
    m.useDownloads.setState({ tasks: [mkTask("newest", "running"), mkTask("older", "running"), mkTask("q", "queued")], maxParallel: 3 });
    m.useDownloads.getState().applyProgress({ stage: "fetch", message: "M1" });
    const tasks = m.useDownloads.getState().tasks;
    assert.equal(at(tasks, 0).log.length, 0, "newest（数组最前）不再白吃邻居的进度");
    assert.equal(at(tasks, 1).log.length, 1, "older（等待最久）收到");
    assert.equal(at(tasks, 2).log.length, 0, "queued 不参与未打标投递");
    assert.deepEqual(at(tasks, 1).stages, ["fetch"]);
    assert.equal(at(tasks, 1).lastLine, "", "fetch 不是 *-progress，不改写 lastLine");
  });

  test("applyProgress(打标 by ref): 命中 ref 相同那条；-progress 只改 lastLine 不记日志", () => {
    m.useDownloads.setState({ tasks: [mkTask("n1", "running", { ref: "repo/x" }), mkTask("n2", "running")], maxParallel: 3 });
    m.useDownloads.getState().applyProgress({ stage: "fetch-progress", message: "90%", task: "repo/x" });
    const rows = m.useDownloads.getState().tasks;
    const n1 = at(rows, 0);
    const n2 = at(rows, 1);
    assert.equal(n1.lastLine, "90%", "按 ref 匹配到 n1");
    assert.equal(n1.log.length, 0, "*-progress 阶段不追加日志行");
    assert.deepEqual(n1.stages, [], "*-progress 阶段不进 stages");
    assert.equal(n2.lastLine, "", "n2 不受影响");
  });

  test("applyProgress(landing): 无 targetDir 时被 landing 消息 trim 后填满", () => {
    m.useDownloads.setState({ tasks: [mkTask("land", "running")], maxParallel: 3 });
    m.useDownloads.getState().applyProgress({ stage: "landing", message: "  D:\\x\\  " });
    assert.equal(at(m.useDownloads.getState().tasks, 0).targetDir, "D:\\x\\", "两端空白被 trim");
  });

  // --- appendLog 的 150/省略/150 折叠算式 ---------------------------------------

  test("appendLog: 越过 301 行时折成 头部150 + 省略标记 + 尾部150", () => {
    // LOG_HEAD=150, LOG_TAIL=150, max=301。喂 302 行 → 保留 301：头 150、标记、尾 150。
    // 标记写的是 "中间 ${omitted+1} 行已省略"，omitted = 302-301 = 1，所以文案是 "2 行"。
    const big = Array.from({ length: 301 }, (_, i) => `L${i}`);
    m.useDownloads.setState({ tasks: [mkTask("fold", "running", { log: big, startedAt: Date.now() })], maxParallel: 3 });
    m.useDownloads.getState().applyProgress({ stage: "fetch", message: "tail" });
    const log = at(m.useDownloads.getState().tasks, 0).log;
    assert.equal(log.length, 301, "折叠后总长恒为 max");
    assert.equal(at(log, 0), "L0", "头部从头保留");
    assert.match(at(log, 150), /中间 2 行已省略/, "省略标记落在第 150 个位置");
    assert.equal(at(log, 151), "L152", "尾部保留最后 150 行，L151 被省略");
    assert.match(at(log, 300), /\[fetch\] tail$/, "最后一条是刚喂进去的日志行");
  });

  test("stages: 去重且只留最近 12 个阶段", () => {
    m.useDownloads.setState({ tasks: [mkTask("stg", "running", { startedAt: Date.now() })], maxParallel: 3 });
    for (let i = 0; i < 15; i += 1) m.useDownloads.getState().applyProgress({ stage: `s${i}`, message: `m${i}` });
    const stages = at(m.useDownloads.getState().tasks, 0).stages;
    assert.equal(stages.length, 12, "slice(-12) 截断");
    assert.equal(at(stages, 0), "s3", "最早三个 s0/s1/s2 被挤掉");
    assert.equal(at(stages, 11), "s14");
  });

  // --- 队列维护：clearFinished / finish ---------------------------------------
  // 这里原本还有一条 `activeDownloadCount`：该导出在 `5dfdc89`（r14-d10 死导出清理）
  // 就被删了，用例因为整块当时从不执行而一直没响。running+queued 的计数语义由上面的
  // `countByStatus` 三条覆盖，不再单独钉一个不存在的函数。

  test("clearFinished: 只留 running 与 queued（= done+failed 被清）", () => {
    m.useDownloads.setState({ tasks: [mkTask("r", "running"), mkTask("q", "queued"), mkTask("dn", "done"), mkTask("fl", "failed")] });
    m.useDownloads.getState().clearFinished();
    assert.deepEqual(m.useDownloads.getState().tasks.map((t) => t.status), ["running", "queued"]);
  });

  test("finish: 带 failure 落 failed，不带落 done", () => {
    m.useDownloads.setState({ tasks: [mkTask("f1", "running", { startedAt: Date.now() })], maxParallel: 1 });
    m.useDownloads.getState().finish("f1", null, "炸了");
    const t = at(m.useDownloads.getState().tasks, 0);
    assert.equal(t.status, "failed");
    assert.equal(t.failure, "炸了");
  });
}
