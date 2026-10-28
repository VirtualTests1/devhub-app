/**
 * 网络诊断（r18 方向 N2）——把 `environment` 探针里**已经算好**的网络事实
 * 归约成分级结论，给「网络诊断」对话框渲染。
 *
 * ## 与 `diagnose.ts` 的分工
 *
 * `diagnose.ts` 是仓库健康诊断（输入里带 repos），环境级只出两条
 * （noGit / hostsHijacked）。本模块是**网络系统**的诊断：hosts、代理、
 * DNS、IP 钉死、镜像、权限各自判一条，输入只需要一个 `EnvironmentReport`。
 * 两者共享同一条纪律（纯函数、`t` 参数化、码稳定），但不共享输入形状——
 * 把仓库塞进本模块会再造一个 diagnose.ts，那不是这次要做的事。
 *
 * ## 判定纪律（沿用 diagnose.ts 的「不许说谎」）
 *
 *   - `env === null`（探针失败）→ 空清单。对话框据此显示「取不到网络状态」，
 *     「问不出来」与「没问题」是两个状态，合并就是骗人。
 *   - 「没发现」不是错误：本地代理未发现（hosts 加速模式下的常态）、
 *     权限标准，都按平静的 info 或干脆不报，绝不升级成 warn。
 *   - 只有两条是 warn：DNS 多解析器未达成一致、IP 钉死拿不到公网地址——
 *     它们会实际改变下载/搜索走得通哪条路。
 *
 * ## 句子的语言
 *
 * `netDiagText` 只认调用方传入的翻译器（同 `diagnose.diagText`），句子上屏
 * 的语言永远跟随界面的语言行。注意 `linkAdvice` / `linkLabel` 是**后端**生成
 * 的中文短句（`link.rs`），它们只作为事实展示，不在本模块翻译——这条边界
 * 在对话框的注释里也写明了。
 */
import type { TFunc } from "./i18n";
import type { EnvironmentReport } from "../types";
import type { DiagSeverity } from "./diagnose";

/**
 * 网络规则的稳定码。
 *
 * 界面不直接把码印给用户——`netDiagText` 把码翻译成词条。码稳定，是为了
 * 单测按码断言而不是按文案断言（文案会改，码不该改）。
 */
export type NetCode =
  | "net.hostsHijacked"
  | "net.pinUnviable"
  | "net.unresolvedDns"
  | "net.proxyNotFound"
  | "net.mirrorOn"
  | "net.elevated";

export type NetIssue = {
  code: NetCode;
  severity: DiagSeverity;
  /** `netDiagText` 需要的槽位；无槽位时为空对象。 */
  vars: Record<string, string | number>;
};

const SEVERITY_RANK: Record<DiagSeverity, number> = { error: 0, warn: 1, info: 2 };

/**
 * 把一份环境报告归约成结论清单。
 *
 * 排序与 `diagnose.ts` 的 `sortDiagnostics` 同一手法：全键比较
 * （严重度 → 码），不依赖 `sort` 稳定性——同一份输入两次跑出的顺序必须
 * 逐条相同（`tests/netdiag.test.ts` 钉住这一点）。
 */
export function diagnoseNetwork(env: EnvironmentReport | null): NetIssue[] {
  if (!env) return [];
  const out: NetIssue[] = [];

  if (env.hostsHijacked) {
    out.push({
      code: "net.hostsHijacked",
      severity: "info",
      vars: { n: env.hostsRedirectCount, by: env.hostsBy ?? "" },
    });
  }

  // 解析与钉死合成一条：P（钉死开着拿不到地址）解释的是「绕过路径不可用」，
  // 其余「没拿到一致解析」解释的是解析本身。两条同时报会把同一件事说两遍。
  if (env.resolvedIp === null) {
    if (env.ipPinEnabled) {
      out.push({ code: "net.pinUnviable", severity: "warn", vars: {} });
    } else {
      out.push({ code: "net.unresolvedDns", severity: "warn", vars: {} });
    }
  }

  // 「未发现」是事实不是问题：Watt 默认的 hosts 加速模式下代理本来就该缺席，
  // 这正是 strip.proxyHint 那句话存在的理由。
  if (!env.localProxy) {
    out.push({ code: "net.proxyNotFound", severity: "info", vars: {} });
  }

  if (env.mirrorEnabled) {
    out.push({ code: "net.mirrorOn", severity: "info", vars: {} });
  }

  if (env.elevated) {
    out.push({ code: "net.elevated", severity: "info", vars: {} });
  }

  return out.sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.code.localeCompare(b.code),
  );
}

/**
 * 把一条结论翻译成句子。
 *
 * `t` 是参数而非模块内的全局单例（同 `diagnose.diagText`）：界面用
 * `useI18n()` 的 `t`（订阅语言），单测可以传任意翻译器。参数名保持 `t`，
 * 与键集守卫「`t` + 字面量键」的扫描约定一致。
 */
export function netDiagText(t: TFunc, issue: NetIssue): string {
  switch (issue.code) {
    case "net.hostsHijacked":
      return issue.vars.by
        ? t("netdiag.hostsHijackedBy.title", issue.vars)
        : t("netdiag.hostsHijacked.title", issue.vars);
    case "net.pinUnviable":
      return t("netdiag.pinUnviable.title", issue.vars);
    case "net.unresolvedDns":
      return t("netdiag.unresolvedDns.title", issue.vars);
    case "net.proxyNotFound":
      return t("netdiag.proxyNotFound.title", issue.vars);
    case "net.mirrorOn":
      return t("netdiag.mirrorOn.title", issue.vars);
    case "net.elevated":
      return t("netdiag.elevated.title", issue.vars);
  }
}
