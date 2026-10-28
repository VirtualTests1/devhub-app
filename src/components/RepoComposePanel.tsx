import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Copy, FileCode2, Hash, Layers, Network, Play, TriangleAlert } from "lucide-react";

import { SettingRow, FieldRow } from "./SettingsRows";
import { toast } from "./Toast";
import { messageOf } from "../lib/report-error";
import { useI18n } from "../lib/useI18n";
import { reg } from "../store/customize";
import {
  composeDeclarations,
  composeNetworkName,
  composeProjectName,
  composeVolumeName,
  isolatedComposeCommand,
  isolatedOverride,
} from "../lib/compose";

/**
 * 项目设置 → Docker 隔离（r21-N2-2）。
 *
 * `REQUIREMENTS.md` §3.6 的隔离模型有五行，第五行「服务/数据库：Docker 每项目独立
 * 网络 + 命名卷」是唯一一行从没进过界面的。这个面板把它变成**可核对的产物**：
 * 项目名、网络名、每个命名卷的完整名字、`devhub-isolation.yml` 的全文预览、以及
 * 两条 `-f` 拼起来的运行命令——每一项都是从仓库自己的 compose 文本推出来的，可以
 * 拿去和 `docker network ls` / `docker volume ls` 的输出逐字对照。
 *
 * ## 面板只读不写
 *
 * 不写文件，也不需要新的写文件能力（`write_text_file` 在仓里，但用它把
 * `devhub-isolation.yml` 落进**用户的仓库**就是 `REQUIREMENTS.md` §5.2 的
 * 「不污染用户环境」：那会在别人的 `git status` 里多出一个未跟踪文件）。所以这里是
 * 「预览 + 一键复制」，落盘由本人决定——`compose.saveHint` 把步骤说清楚。这与
 * `src/lib/compose.ts` 的模块约定一致：应用不改写仓库自己的 compose 文件。
 *
 * ## 三处「不知道」各有各的脸
 *
 *   - `project_has_compose` 探针失败 → 面板照常出现，只报一句没查成（`failed`）；
 *   - 文件读不出来 → 名单与预览按「没认出」处理，并说清是读失败（`readFailed`）；
 *   - 文本读到了但结构不在识别范围内 → `composeDeclarations` 返回 `null`，
 *     对应 `volumesUnknown` / `servicesUnknown` 两句话。`null` 永远不会被画成「没有」。
 *
 * 没有 compose 文件的仓库整个面板不出现（`none`），因为那对它无话可说。
 */
type Probe =
  | { kind: "checking" }
  | { kind: "failed"; note: string }
  | { kind: "none" }
  | { kind: "ready"; file: string; text: string | null; readNote: string | null };

export function RepoComposePanel({ slug, path }: { slug: string; path: string | null }) {
  const { t } = useI18n();
  const [probe, setProbe] = useState<Probe>({ kind: "checking" });

  useEffect(() => {
    if (!path) return;
    let alive = true;
    setProbe({ kind: "checking" });
    (async () => {
      try {
        const file = await invoke<string | null>("project_has_compose", { path });
        if (!alive) return;
        if (!file) {
          setProbe({ kind: "none" });
          return;
        }
        try {
          const text = await invoke<string>("read_text_file", { path: `${path}/${file}` });
          if (alive) setProbe({ kind: "ready", file, text, readNote: null });
        } catch (err) {
          // 找到了文件但读不出来 —— 这与「没有这个文件」不是一回事，面板照常出现，
          // 只把清单降级成「没认出」并点名是读失败。
          if (alive) setProbe({ kind: "ready", file, text: null, readNote: messageOf(err) });
        }
      } catch (err) {
        if (alive) setProbe({ kind: "failed", note: messageOf(err) });
      }
    })();
    return () => {
      alive = false;
    };
  }, [path]);

  if (probe.kind === "checking" || probe.kind === "none") return null;

  /** 读不到文件时清单一律按「没认出」显示；读到了才谈结构认没认出来。 */
  const declarations =
    probe.kind === "ready" && probe.text !== null
      ? composeDeclarations(probe.text)
      : { services: null, volumes: null };
  const structureKnown = probe.kind === "ready" && probe.text !== null;

  const projectName = composeProjectName(slug);
  const networkName = composeNetworkName(slug);
  const override =
    probe.kind === "ready"
      ? isolatedOverride(slug, declarations.services ?? [], declarations.volumes ?? [])
      : "";
  const command = probe.kind === "ready" ? isolatedComposeCommand(slug, probe.file) : "";

  /** 与全仓其它复制动作同一条契约：成功与失败都给一句 toast，失败说的是怎么办。 */
  const copy = (text: string) => {
    void navigator.clipboard.writeText(text)
      .then(() => toast.success(t("compose.copied")))
      .catch(() => toast.error(t("settings.page.failuresClipboardDenied")));
  };

  const copyButton = (label: string, text: string) => (
    <button
      type="button"
      onClick={() => copy(text)}
      className="skin-ctl flex items-center gap-1 border px-2 py-1 text-caption hover:bg-accent"
    >
      <Copy className="h-3 w-3" />
      {label}
    </button>
  );

  return (
    <section className="mt-4">
      <h3 className="skin-label mb-1 text-caption text-muted-foreground">{t("compose.sectionTitle")}</h3>

      <div
        {...reg("project-row-compose")}
        className="skin-panel divide-dashed divide-border-weak border border-border-weak bg-card"
      >
        {probe.kind === "failed" ? (
          <SettingRow
            icon={<TriangleAlert className="h-3.5 w-3.5" />}
            title={t("compose.probeFailed", { note: probe.note })}
          />
        ) : (
          <>
            <SettingRow
              icon={<FileCode2 className="h-3.5 w-3.5" />}
              title={t("compose.fileTitle")}
              rowHint={probe.file}
            />

            {probe.readNote && (
              <SettingRow
                icon={<TriangleAlert className="h-3.5 w-3.5" />}
                title={t("compose.readFailed", { file: probe.file, note: probe.readNote })}
              />
            )}

            <SettingRow
              icon={<Hash className="h-3.5 w-3.5" />}
              title={t("compose.projectName")}
              hint={t("compose.projectNameHint")}
              control={
                <code className="rounded bg-muted/40 px-1.5 py-0.5 font-mono text-caption text-foreground">
                  {projectName}
                </code>
              }
            />
            <SettingRow
              icon={<Network className="h-3.5 w-3.5" />}
              title={t("compose.networkName")}
              hint={t("compose.networkNameHint")}
              control={
                <code className="rounded bg-muted/40 px-1.5 py-0.5 font-mono text-caption text-foreground">
                  {networkName}
                </code>
              }
            />

            <FieldRow
              icon={<Layers className="h-3.5 w-3.5" />}
              align="stack"
              title={t("compose.volumesTitle")}
              hint={t("compose.volumesHint")}
            >
              {declarations.volumes === null ? (
                <p className="m-0 text-caption leading-snug text-warning">
                  {t("compose.volumesUnknown")}
                </p>
              ) : declarations.volumes.length === 0 ? (
                <p className="m-0 text-caption leading-snug text-muted-foreground">
                  {t("compose.noVolumes")}
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {declarations.volumes.map((v) => (
                    <code
                      key={v}
                      className="rounded bg-muted/40 px-1.5 py-0.5 font-mono text-caption text-foreground"
                    >
                      {composeVolumeName(slug, v)}
                    </code>
                  ))}
                </div>
              )}
            </FieldRow>

            <FieldRow
              icon={<FileCode2 className="h-3.5 w-3.5" />}
              align="stack"
              title={t("compose.overrideTitle")}
              hint={t("compose.overrideHint")}
            >
              <div className="flex flex-col items-start gap-1.5">
                {structureKnown && declarations.services === null && (
                  <p className="m-0 text-caption leading-snug text-warning">
                    {t("compose.servicesUnknown")}
                  </p>
                )}
                <pre className="m-0 max-h-44 w-full overflow-auto rounded border border-border/60 bg-background/60 px-2 py-1.5 font-mono text-caption leading-relaxed text-foreground">
                  {override}
                </pre>
                {copyButton(t("compose.copyOverride"), override)}
              </div>
            </FieldRow>

            <FieldRow
              icon={<Play className="h-3.5 w-3.5" />}
              align="stack"
              title={t("compose.commandTitle")}
              hint={t("compose.commandHint")}
            >
              <div className="flex flex-col items-start gap-1.5">
                <code className="w-full break-all rounded bg-muted/40 px-1.5 py-0.5 font-mono text-caption text-foreground">
                  {command}
                </code>
                {copyButton(t("compose.copyCommand"), command)}
              </div>
            </FieldRow>
          </>
        )}
      </div>

      <p className="app-desc mt-1 px-0.5 text-caption leading-snug text-muted-foreground">
        {t("compose.saveHint")}
      </p>
    </section>
  );
}
