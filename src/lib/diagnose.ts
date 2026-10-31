/**
 * 仓库健康诊断（round 17 方向 N3）——把**已有**的逐仓库探针结果归约成一份分级问题清单。
 *
 * ## 它不是什么（先划清边界，免得再写一个导出）
 *
 * master 上已有 `export_diagnostics`：它把 OS / 版本 / git / 配置路径 / 仓库计数**导出**
 * 成一个 Markdown 文件，给人和外部工具看。本模块不重复它——本模块要的是**应用内的
 * 诊断**：输入是各探针已经在算的结果，输出是「有什么问题、多严重、怎么修、跳哪去修」，
 * 每条都带一个可以直接执行的跳转目标。
 *
 * ## 纯函数，且不碰 React
 *
 * 本文件是 `.ts`，Node 的 type-stripping runner 能直接 import（`tests/diagnose.test.ts`
 * 就是这么驱动它的）。它只做「给定事实 → 判定」的函数变换，不发起 IPC、不持有状态、
 * 不认识 React：`diagText` 只接受调用方传入的翻译器（和 `views/records/filter-words.ts`
 * 同一套「把 `t` 当参数」的做法），这样界面订阅的语言和判定的结论不会各说各话。
 *
 * ## 输入覆盖哪些探针（依据 `src/types.ts` 的真实返回类型）
 *
 *   - `Freshness`（`repo_freshness`）— 远端同步状态。
 *   - `WorktreeStatus`（`repo_worktree_status`）— 工作区脏/未推送。
 *   - `RepoDetail`（`repo_detail`）— 启动命令与虚拟环境状态（`VenvState`）。
 *   - `PortHealth[]`（`repo_port_health`）— 端口是否真的在应答。
 *   - `InstallPlan`（`install_plan`）— 依赖清单与所选管理器是否在本机。
 *   - `ClearReport`（`scan_cache`）— 缓存占用。
 *   - `Environments`（`repo_environments`）— 项目需要的运行时是否在 PATH 上。
 *   - `EnvironmentReport`（`environment`）— git 是否可用、hosts 是否被改写。
 *
 * ## 两条「不许说谎」的判定纪律（沿用各探针自己的注释）
 *
 *   - 探针说 `unknown` 就只报「无法确认」，绝不升级成 `error`；`repo_port_health`
 *     只在**进程正在运行**时才有意义，所以未运行时端口不响不算问题（否则每张卡片
 *     都会因为「没启动」而永远挂着警告）。
 *   - 每个探针缺席（`null`）时该规则整条不产生，而不是按默认值猜——`null` 是「没法
 *     问出来」，和「没问题」是两件事。
 */
import { formatBytes } from "./format";
import type { TFunc } from "./i18n";
import type {
  ClearReport,
  EnvironmentReport,
  Environments,
  Freshness,
  InstallPlan,
  PortHealth,
  RepoDetail,
  WorktreeStatus,
} from "../types";

/** 一条问题的严重度。`error` = 功能已经坏了；`warn` = 有风险/会带走东西；`info` = 只是信息。 */
export type DiagSeverity = "error" | "warn" | "info";

/**
 * 规则码：稳定的机器可读标识。
 *
 * 界面**不**把码直接印给用户——`diagText` 把码翻译成词条。码稳定，是为了单测能按码断言，
 * 而不是按中文字符串断言（文案会改，码不该改）。
 */
export type DiagCode =
  // 全局（环境级）
  | "env.noGit"
  | "env.hostsHijacked"
  // 单仓库
  | "repo.noGit"
  | "repo.remoteMissing"
  | "repo.remoteUnknown"
  | "repo.behind"
  | "repo.dirty"
  | "repo.unpushed"
  | "repo.noLaunch"
  | "repo.venvStale"
  | "repo.portDown"
  | "repo.depsInstall"
  | "repo.toolMissing"
  | "repo.cacheLarge";

/** 修这条问题的入口。`panel`/`repoSettings` 归属某仓库；`appSettings` 跳全局设置页。 */
export type DiagJump =
  | { kind: "panel"; slug: string }
  | { kind: "repoSettings"; slug: string }
  | { kind: "appSettings" };

export type Diagnostic = {
  code: DiagCode;
  severity: DiagSeverity;
  /** 归属仓库；全局问题为 `null`。 */
  slug: string | null;
  /** `diagText` 需要的槽位（例如 `{n}` `{port}` `{service}`）；无槽位时为空对象。 */
  vars: Record<string, string | number>;
  jump: DiagJump;
};

/** 一个仓库的探针结果集合。字段为 `null` = 这个探针没跑/没成功，对应规则整条跳过。 */
export type RepoDiagInput = {
  slug: string;
  /** 该仓库当前是否有本应用启动的进程在跑（决定端口探针是否适用于本仓库）。 */
  running: boolean;
  freshness: Freshness | null;
  worktree: WorktreeStatus | null;
  detail: RepoDetail | null;
  ports: readonly PortHealth[] | null;
  plan: InstallPlan | null;
  cache: ClearReport | null;
  tools: Environments | null;
};

export type DiagInput = {
  repos: readonly RepoDiagInput[];
  env: EnvironmentReport | null;
};

/**
 * Which named probes returned no answer.
 *
 * `diagnose` deliberately drops a rule when its input is `null` — "could not ask"
 * is not "nothing wrong". That is honest at the rule level, but the dialog then
 * rendered an empty issue list, which reads as "all clear" after eight of nine
 * probes failed. This names the missing inputs so the surface can say what the
 * conclusion does and does not cover.
 */
export function missingProbes(probes: Readonly<Record<string, unknown>>): string[] {
  return Object.entries(probes)
    .filter(([, value]) => value === null || value === undefined)
    .map(([name]) => name);
}

/** 缓存「过大」的阈值：200 MB。超过才提示可清理，免得把每条缓存都当成问题。 */
export const CACHE_BIG_BYTES = 200 * 1024 * 1024;

/** 虚拟环境里「需要提醒」的状态；`ready` 与 `nothing`（不适用）不算问题。 */
const VENV_BAD: ReadonlySet<string> = new Set(["missing", "notAVenv", "staleDir", "unrecorded"]);

/**
 * 把探针结果归约成分级问题清单。
 *
 * 空输入（无仓库、无环境）→ 空清单；这是「没发现问题」这个结论的唯一来源，不是靠猜。
 */
export function diagnose(input: DiagInput): Diagnostic[] {
  const out: Diagnostic[] = [];

  const env = input.env;
  if (env) {
    // git 不可用：下载、更新、回退全线失效，属 error。
    if (!env.git) {
      out.push({ code: "env.noGit", severity: "error", slug: null, vars: {}, jump: { kind: "appSettings" } });
    }
    // hosts 被改写成 loopback：应用已自动绕过，属信息（不是需要用户动手的问题）。
    if (env.hostsHijacked) {
      out.push({ code: "env.hostsHijacked", severity: "info", slug: null, vars: {}, jump: { kind: "appSettings" } });
    }
  }

  for (const r of input.repos) {
    out.push(...diagnoseRepo(r));
  }

  return sortDiagnostics(out);
}

function diagnoseRepo(r: RepoDiagInput): Diagnostic[] {
  const out: Diagnostic[] = [];
  const panel = { kind: "panel", slug: r.slug } as const;
  const repoSettings = { kind: "repoSettings", slug: r.slug } as const;

  // 远端同步状态：五种状态各是一句话，`unknown` 只说无法确认。
  const f = r.freshness;
  if (f) {
    switch (f.state) {
      case "no-git":
        out.push({ code: "repo.noGit", severity: "error", slug: r.slug, vars: {}, jump: panel });
        break;
      case "missing":
        out.push({ code: "repo.remoteMissing", severity: "warn", slug: r.slug, vars: {}, jump: panel });
        break;
      case "unknown":
        out.push({ code: "repo.remoteUnknown", severity: "info", slug: r.slug, vars: {}, jump: panel });
        break;
      case "behind":
        out.push({ code: "repo.behind", severity: "warn", slug: r.slug, vars: {}, jump: panel });
        break;
      default:
        // `fresh` 与未来可能新增的状态都不报——不把未知值硬塞进某条规则。
        break;
    }
  }

  // 工作区状态：这两条都会影响「删除/清理会带走什么」。
  const wt = r.worktree;
  if (wt?.hasGit) {
    if (wt.dirty > 0) {
      out.push({ code: "repo.dirty", severity: "warn", slug: r.slug, vars: { n: wt.dirty }, jump: panel });
    }
    // `ahead === null` = 没有上游/问不出来，不是「没有未推送的提交」。
    if (typeof wt.ahead === "number" && wt.ahead > 0) {
      out.push({ code: "repo.unpushed", severity: "warn", slug: r.slug, vars: { n: wt.ahead }, jump: panel });
    }
  }

  // 启动配置与虚拟环境：都归项目设置去修。
  const d = r.detail;
  if (d) {
    if (!d.launch) {
      out.push({ code: "repo.noLaunch", severity: "info", slug: r.slug, vars: {}, jump: repoSettings });
    }
    if (VENV_BAD.has(d.venvState)) {
      out.push({ code: "repo.venvStale", severity: "warn", slug: r.slug, vars: {}, jump: repoSettings });
    }
  }

  // 端口：只在进程确实在跑时才有意义（探针自己的注释：证明「served」而非「started」）。
  if (r.running && r.ports) {
    for (const p of r.ports) {
      if (!p.listening) {
        out.push({
          code: "repo.portDown",
          severity: "warn",
          slug: r.slug,
          vars: { port: p.port, service: p.service },
          jump: panel,
        });
      }
    }
  }

  // 依赖：有清单 = 运行前要先装；所选管理器不在本机 = 装不了。
  const plan = r.plan;
  if (plan) {
    if (plan.toolPresent) {
      out.push({
        code: "repo.depsInstall",
        severity: "info",
        slug: r.slug,
        vars: { manager: plan.toolName },
        jump: panel,
      });
    } else {
      out.push({
        code: "repo.toolMissing",
        severity: "warn",
        slug: r.slug,
        vars: { tool: plan.toolName },
        jump: { kind: "appSettings" },
      });
    }
  }

  // 缓存：超过阈值才提示，且大小按 `lib/format` 的单一格式器渲染。
  const cache = r.cache;
  if (cache && cache.totalBytes >= CACHE_BIG_BYTES) {
    out.push({
      code: "repo.cacheLarge",
      severity: "info",
      slug: r.slug,
      vars: { size: formatBytes(cache.totalBytes) },
      jump: panel,
    });
  }

  return out;
}

const SEVERITY_RANK: Record<DiagSeverity, number> = { error: 0, warn: 1, info: 2 };

/**
 * 稳定排序：先按严重度（严重在前），再按规则码，再按仓库 slug，最后按跳转类型。
 *
 * 全键比较、不依赖 `Array.prototype.sort` 的稳定性来打破平局——同一份输入两次跑出的
 * 顺序必须逐条相同（`tests/diagnose.test.ts` 钉住这一点）。
 */
export function sortDiagnostics(list: readonly Diagnostic[]): Diagnostic[] {
  return [...list].sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.code.localeCompare(b.code) ||
      (a.slug ?? "").localeCompare(b.slug ?? "") ||
      a.jump.kind.localeCompare(b.jump.kind),
  );
}

/**
 * 把一条问题翻译成结论句。
 *
 * `t` 是参数而非模块内的全局单例：界面用 `useI18n()` 的 `t`（订阅语言），单测可以传
 * 任意翻译器。（参数名保持 `t`，与 `filter-words.ts` 同一约定——键集守卫按「`t` + 字面
 * 量键」扫调用点，改名的键会被当成没人读。）
 */
export function diagText(t: TFunc, issue: Diagnostic): string {
  switch (issue.code) {
    case "env.noGit":
      return t("diagnose.envNoGit.title", issue.vars);
    case "env.hostsHijacked":
      return t("diagnose.hostsHijacked.title", issue.vars);
    case "repo.noGit":
      return t("diagnose.noGit.title", issue.vars);
    case "repo.remoteMissing":
      return t("diagnose.remoteMissing.title", issue.vars);
    case "repo.remoteUnknown":
      return t("diagnose.remoteUnknown.title", issue.vars);
    case "repo.behind":
      return t("diagnose.behind.title", issue.vars);
    case "repo.dirty":
      return t("diagnose.dirty.title", issue.vars);
    case "repo.unpushed":
      return t("diagnose.unpushed.title", issue.vars);
    case "repo.noLaunch":
      return t("diagnose.noLaunch.title", issue.vars);
    case "repo.venvStale":
      return t("diagnose.venvStale.title", issue.vars);
    case "repo.portDown":
      return t("diagnose.portDown.title", issue.vars);
    case "repo.depsInstall":
      return t("diagnose.depsInstall.title", issue.vars);
    case "repo.toolMissing":
      return t("diagnose.toolMissing.title", issue.vars);
    case "repo.cacheLarge":
      return t("diagnose.cacheLarge.title", issue.vars);
  }
}

/** 跳转按钮的文案：三处入口各一句（前两句复用卡片菜单已有的词条）。 */
export function diagAction(t: TFunc, jump: DiagJump): string {
  switch (jump.kind) {
    case "panel":
      return t("menu.panel");
    case "repoSettings":
      return t("menu.settings");
    case "appSettings":
      return t("diagnose.jump.settings");
  }
}

/** 严重度的显示词。 */
export function severityLabel(t: TFunc, severity: DiagSeverity): string {
  switch (severity) {
    case "error":
      return t("diagnose.sev.error");
    case "warn":
      return t("diagnose.sev.warn");
    case "info":
      return t("diagnose.sev.info");
  }
}
