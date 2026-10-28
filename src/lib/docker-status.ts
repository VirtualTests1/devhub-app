/**
 * `docker_status` 的事实清单（r21-N2-1）。
 *
 * 面板要画三行——docker 命令在不在 PATH、守护进程跑没跑、compose 插件答不答话
 * ——而「哪些行该出现」这件事值得单独放一个能被 Node 直接 import 的 `.ts`：
 * `.tsx` 组件没法被 `pnpm test` 跑（Node 的类型剥离不认 JSX），那三条分支就只剩
 * 源码断言可写。这里用假的 `DockerStatus` 载荷直接钉行为，措辞则留在组件里走
 * `t()`（i18n 测试要求字面量调用点，所以本模块**不含任何文案**，只有结构）。
 *
 * 一条硬约定：`state === "ok"` 只在后端**正面回答**了这个探针时才成立。
 * 没装 docker、compose 没答话、探针本身抛错，都各有各的状态，绝不共用 "ok"——
 * 「不可判定时不要说成正常」这句要求就是被这四个状态值守住的。
 */

import type { DockerStatus } from "../types";

export type DockerFactId = "cli" | "daemon" | "compose";

/**
 *   ok       后端正面回答了这个探针（命令在、进程在跑、compose 答了版本）
 *   absent   根本没有这个前提（没装 docker，另外两项无从谈起）
 *   down     前提在，但答案是「没在跑 / 没答话」
 *   unknown  后端没能给出答案，连原因都没有
 */
export type DockerFactState = "ok" | "absent" | "down" | "unknown";

export type DockerFact = {
  id: DockerFactId;
  state: DockerFactState;
  /** 后端原话（版本串或拒绝原因），组件原样显示；没有就是 null。 */
  detail: string | null;
  /** 只有 `daemon` 且 `state === "ok"` 时有意义——daemon 不在跑时后端把两个计数
   *  置 0，那不是「0 个容器」，是「没查」，所以不塞进清单。 */
  containers?: number;
  images?: number;
};

/**
 * 把一次 `docker_status` 载荷摊成按优先级排好的事实行。
 *
 * CLI 没装时只返回一行：守护进程与 compose 的真原因都是「没装 docker」，
 * 再画两行只会把同一个结论说三遍，还容易被读成三个独立故障。
 */
export function dockerFacts(status: DockerStatus): DockerFact[] {
  if (!status.cliFound) {
    return [{ id: "cli", state: "absent", detail: null }];
  }
  const facts: DockerFact[] = [
    { id: "cli", state: status.version ? "ok" : "unknown", detail: status.version },
    status.daemonRunning
      ? {
          id: "daemon",
          state: "ok",
          detail: null,
          containers: status.runningContainers,
          images: status.imageCount,
        }
      : { id: "daemon", state: "down", detail: status.daemonError },
    status.composeVersion
      ? { id: "compose", state: "ok", detail: status.composeVersion }
      : { id: "compose", state: "unknown", detail: status.composeError },
  ];
  return facts;
}
