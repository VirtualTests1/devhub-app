import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Container, Package, RefreshCw, Terminal, TriangleAlert } from "lucide-react";

import { ActionRow, SettingRow, SettingsGroup } from "../../components/SettingsRows";
import { messageOf } from "../../lib/report-error";
import { useI18n } from "../../lib/useI18n";
import { dockerFacts, type DockerFact, type DockerFactId } from "../../lib/docker-status";
import type { DockerStatus } from "../../types";

/**
 * 设置 → 故障与诊断 → Docker 环境（r21-N2-1）。
 *
 * 这是 `docker_status` 的第一个前端调用者：在此之前那条命令只在
 * `scripts/check-commands.mjs` 的 allowlist 里挂着「设置页 Docker 诊断面板待实现」。
 *
 * ## 为什么在 故障与诊断，不在 网络
 *
 * `network` 段装的是**访问 GitHub 的路**（IP 钉死、镜像、代理、DNS，见
 * `SettingsView.tsx` 的 network 段），Docker 与那条路毫无关系；而 `docker status`
 * 报的是这台机器的健康事实——命令在不在 PATH、守护进程跑没跑、compose 插件答不
 * 答话——与它并排的失败历史、缓存用量同属「机器现在怎么样」。allowlist 里那条理由
 * 写的也是「设置页 Docker 诊断面板」，即从一开始就是诊断面，不是网络面。
 *
 * ## 措辞纪律
 *
 * 三种坏消息各有各的脸，谁也不许顶替谁（`lib/docker-status.ts` 的四个状态值）：
 *
 *   - 没装 docker → 引导文案，不是错误红：没装不是故障，是还没轮到用它；
 *   - 装了但 daemon / compose 没答话 → 显示后端原话，让人自己判断原因；
 *   - 探针本身抛错 → 「没能问到」，绝不因为拿不到数据就写「正常」。
 *
 * 计数（容器 / 镜像）只在守护进程真的在跑时才画：后端在 daemon 不可用时把它们
 * 置 0，那 0 是「没查」，显示成「0 个容器」就是把未知说成了事实。
 */
type Translate = ReturnType<typeof useI18n>["t"];

type Probe =
  | { kind: "loading" }
  | { kind: "ready"; status: DockerStatus }
  | { kind: "failed"; note: string };

function factIcon(id: DockerFactId) {
  if (id === "cli") return <Terminal className="h-4 w-4" />;
  if (id === "daemon") return <Container className="h-4 w-4" />;
  return <Package className="h-4 w-4" />;
}

/** 事实行的标题。三分支写全而不是 `t(\`…${f.id}\`)`：i18n 测试靠字面量调用点
 *  找键，模板键会被判成「登记了却没人读」。 */
function factTitle(t: Translate, f: DockerFact): string {
  if (f.id === "cli") {
    return f.state === "absent" ? t("settings.page.dockerCliMissing") : t("settings.page.dockerCliOk");
  }
  if (f.id === "daemon") {
    return f.state === "ok" ? t("settings.page.dockerDaemonUp") : t("settings.page.dockerDaemonDown");
  }
  return f.state === "ok" ? t("settings.page.dockerComposeOk") : t("settings.page.dockerComposeMissing");
}

function factHint(t: Translate, f: DockerFact): string {
  if (f.id === "cli") {
    // absent 的提示是引导（去哪装、装完做什么），与「查到了什么」不是一类话。
    if (f.state === "absent") return t("settings.page.dockerCliMissingHint");
    return f.detail ?? t("settings.page.dockerNoReason");
  }
  if (f.id === "daemon") {
    if (f.state === "ok") {
      return t("settings.page.dockerCounts", { n: f.containers ?? 0, m: f.images ?? 0 });
    }
    return f.detail ?? t("settings.page.dockerNoReason");
  }
  return f.detail ?? t("settings.page.dockerNoReason");
}

export function DockerDiagnosticsSection() {
  const { t } = useI18n();
  const [probe, setProbe] = useState<Probe>({ kind: "loading" });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    setProbe({ kind: "loading" });
    invoke<DockerStatus>("docker_status")
      .then((status) => {
        if (alive) setProbe({ kind: "ready", status });
      })
      .catch((err) => {
        // 探针失败与「docker 没装」是两件事：前者连机器有没有 docker 都不知道，
        // 所以它有自己的状态和自己的句子，不复用 absent 的引导文案。
        if (alive) setProbe({ kind: "failed", note: messageOf(err) });
      });
    return () => {
      alive = false;
    };
  }, [nonce]);

  return (
    <SettingsGroup
      title={t("settings.page.dockerGroupTitle")}
      regId="settings-group-docker"
      footnote={t("settings.page.dockerFootnote")}
    >
      {probe.kind === "loading" && (
        <SettingRow
          icon={<RefreshCw className="h-4 w-4" />}
          title={t("settings.page.dockerChecking")}
        />
      )}

      {probe.kind === "failed" && (
        <SettingRow
          icon={<TriangleAlert className="h-4 w-4" />}
          title={t("settings.page.dockerProbeFailed", { note: probe.note })}
        />
      )}

      {probe.kind === "ready" &&
        dockerFacts(probe.status).map((f) => (
          <SettingRow
            key={f.id}
            icon={factIcon(f.id)}
            title={factTitle(t, f)}
            hint={factHint(t, f)}
          />
        ))}

      <ActionRow
        icon={<RefreshCw className="h-4 w-4" />}
        title={t("settings.page.dockerRefresh")}
        hint={t("settings.page.dockerRefreshHint")}
        actionLabel={t("settings.page.dockerRefresh")}
        onAction={() => setNonce((n) => n + 1)}
        disabled={probe.kind === "loading"}
        secondary
      />
    </SettingsGroup>
  );
}
