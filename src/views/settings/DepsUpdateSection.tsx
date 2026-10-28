import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Circle,
  CircleCheckBig,
  LoaderCircle,
  PackageSearch,
  RefreshCw,
  TriangleAlert,
  X,
} from "lucide-react";

import { ActionRow, SettingRow, SettingsGroup } from "../../components/SettingsRows";
import { useI18n } from "../../lib/useI18n";
import { slugOf } from "../../lib/slug";
import { DEPS_WIDTH, runDepsScan } from "../../lib/deps-scan";
import { aggregateDeps, limitPackages } from "../../lib/deps-aggregate";
import type { DependencyReport } from "../../types";
import type { RepoRef } from "../../types";

/**
 * 设置 → 依赖更新（r21-N1b-2）。
 *
 * 在此之前 `check_dependencies`（`src-tauri/src/deps.rs:42`）只有一个调用者：
 * 单仓库诊断对话框的 `probe()` 间接层。本面板是它的第二个、也是第一个
 * **直接**调用者（`invoke<DependencyReport>("check_dependencies", { slug })`
 * 写在 `start` 里，`scripts/check-commands.mjs` 的扫描正则看得见），也是这条
 * 命令从 allowlist 里撤封面的时机。
 *
 * ## 这块面板回答的问题
 *
 * 单仓库面板回答「这个仓库怎么样」；这里回答的是跨仓库的问题：*哪个包在
 * 我多少个仓库里都旧着、哪个仓库压根没答上话*。合并规则全在
 * `lib/deps-aggregate.ts`（纯模块、有测试），调度在 `lib/deps-scan.ts`
 * （并发封顶、可取消、拒绝即合成错误报告），这个文件只负责把两者接到
 * 词表和 IPC 上。
 *
 * ## 措辞纪律（与 Docker 面板同一条）
 *
 *   - 问不出来 ≠ 没有更新：`error` 行一等公民地画出来，显示后端原话；
 *   - `manager: "none"`（没有清单文件）与 `manager: ""`（没答话）各是各的句子；
 *   - 「全是最新」只在**至少有一个仓库干净答完**时才说；全军覆没时只有错误区。
 *
 * 取消的语义：停止**调度**新的探针，在途的允许答完并保留（字节已经在路上
 * 了，扔掉它们不会让机器更快），然后进入 ready 态并挂一条「已取消」的注脚。
 */
type Translate = ReturnType<typeof useI18n>["t"];

type Phase = "idle" | "scanning" | "ready";

type RepoState = "pending" | "checking" | "done" | "failed";

/** The package list's cap; the rest is counted, not painted (`limitPackages`). */
const PACKAGE_CAP = 50;

function stateIcon(state: RepoState) {
  if (state === "checking") return <LoaderCircle className="h-4 w-4 animate-spin" />;
  if (state === "done") return <CircleCheckBig className="h-4 w-4 text-primary" />;
  if (state === "failed") return <TriangleAlert className="h-4 w-4 text-danger" />;
  return <Circle className="h-4 w-4 text-muted-foreground/50" />;
}

/** 词面分支写全：字典测试靠字面量 `t("…")` 找调用点，模板键会被判成没人读。 */
function stateLabel(t: Translate, state: RepoState): string {
  if (state === "pending") return t("deps.statePending");
  if (state === "checking") return t("deps.stateChecking");
  if (state === "failed") return t("deps.stateFailed");
  return t("deps.stateDone");
}

/** `""`（没答话）与 `"none"`（没有清单）不能共用一个词，其余原样显示。 */
function managerLabel(t: Translate, manager: string): string {
  if (manager === "") return t("deps.managerUnknown");
  if (manager === "none") return t("deps.managerNone");
  return manager;
}

/** 一行仓库的答案怎么写：后端原话 > 有几条可更新 > 没有可更新的。 */
function answerHint(t: Translate, manager: string, outdated: number, error: string | null): string {
  if (error !== null) return error;
  if (outdated > 0) {
    return t("deps.repoOutdated", { manager: managerLabel(t, manager), n: outdated });
  }
  return t("deps.stateCurrent");
}

export function DepsUpdateSection({ repos }: { repos: RepoRef[] }) {
  const { t } = useI18n();
  const entries = useMemo(
    () => repos.map((r) => ({ slug: slugOf(r), name: `${r.owner}/${r.repo}` })),
    [repos],
  );

  // null = 全选（含之后加入的新仓库）；Set = 明确点过的选择。
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [states, setStates] = useState<Record<string, RepoState>>({});
  const [answers, setAnswers] = useState<DependencyReport[]>([]);
  const [cancelled, setCancelled] = useState(false);
  const seqRef = useRef(0);
  const cancelRef = useRef(false);

  // 卸载后作废在途回调：seq 比对就是竞态闸门，卸载等于把闸门永久关上。
  useEffect(() => {
    return () => {
      seqRef.current += 1;
    };
  }, []);

  const selectedSlugs = useMemo(() => {
    if (entries.length === 0) return [] as string[];
    if (selected === null) return entries.map((e) => e.slug);
    return entries.filter((e) => selected.has(e.slug)).map((e) => e.slug);
  }, [entries, selected]);

  const toggle = useCallback(
    (slug: string) => {
      setSelected((prev) => {
        const base = new Set(prev ?? entries.map((e) => e.slug));
        if (base.has(slug)) base.delete(slug);
        else base.add(slug);
        return base;
      });
    },
    [entries],
  );

  const start = useCallback(() => {
    const seq = ++seqRef.current;
    cancelRef.current = false;
    setCancelled(false);
    setAnswers([]);
    const init: Record<string, RepoState> = {};
    for (const slug of selectedSlugs) init[slug] = "pending";
    setStates(init);
    setPhase("scanning");
    void runDepsScan(
      selectedSlugs,
      (slug) => invoke<DependencyReport>("check_dependencies", { slug }),
      {
        isCancelled: () => cancelRef.current || seqRef.current !== seq,
        onStart: (slug) => {
          if (seqRef.current !== seq) return;
          setStates((prev) => ({ ...prev, [slug]: "checking" }));
        },
        onAnswer: (slug, report) => {
          if (seqRef.current !== seq) return;
          setStates((prev) => ({ ...prev, [slug]: report.error ? "failed" : "done" }));
          setAnswers((prev) => [...prev, report]);
        },
      },
    ).then(() => {
      if (seqRef.current !== seq) return;
      setPhase("ready");
      if (cancelRef.current) setCancelled(true);
    });
  }, [selectedSlugs]);

  const cancel = useCallback(() => {
    cancelRef.current = true;
  }, []);

  const agg = useMemo(() => aggregateDeps(answers), [answers]);
  const table = useMemo(() => limitPackages(agg.packages, PACKAGE_CAP), [agg]);
  const scanningDone = answers.length;

  return (
    <SettingsGroup
      title={t("settings.section.deps")}
      regId="settings-group-deps"
      sectionId="deps"
      footnote={t("deps.footnote", { n: DEPS_WIDTH })}
    >
      {entries.length === 0 && (
        <SettingRow
          icon={<PackageSearch className="h-4 w-4" />}
          title={t("deps.emptyTitle")}
          hint={t("deps.emptyHint")}
        />
      )}

      {entries.length > 0 && (
        <>
          <div className="px-2.5 py-2 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-dashed [&:not(:last-child)]:border-border-weak">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-caption font-medium text-foreground">{t("deps.reposTitle")}</span>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="skin-ctl shrink-0 border border-border px-2 py-0.5 text-caption text-muted-foreground t-state hover:bg-accent hover:text-foreground"
              >
                {t("deps.selectAll")}
              </button>
            </div>
            <p className="app-desc mt-0.5 text-caption text-muted-foreground">
              {t("deps.selectionCount", { n: selectedSlugs.length })}
            </p>
            <ul
              aria-label={t("deps.reposTitle")}
              className="mt-1.5 flex list-none flex-wrap gap-1 p-0"
            >
              {entries.map((e) => {
                const on = selectedSlugs.includes(e.slug);
                return (
                  <li key={e.slug}>
                    <button
                      type="button"
                      aria-pressed={on}
                      title={t("deps.selectRepo", { name: e.name })}
                      onClick={() => toggle(e.slug)}
                      className={
                        on
                          ? "skin-ctl border border-primary/60 bg-primary/15 px-2 py-0.5 font-mono text-caption text-foreground t-state"
                          : "skin-ctl border border-border px-2 py-0.5 font-mono text-caption text-muted-foreground t-state hover:bg-accent hover:text-foreground"
                      }
                    >
                      {e.name}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          {phase !== "scanning" ? (
            <ActionRow
              icon={<RefreshCw className="h-4 w-4" />}
              title={phase === "ready" ? t("deps.rescan") : t("deps.scan")}
              hint={t("deps.scanHint", { n: DEPS_WIDTH })}
              actionLabel={phase === "ready" ? t("deps.rescan") : t("deps.scan")}
              onAction={start}
              disabled={selectedSlugs.length === 0}
            />
          ) : (
            <ActionRow
              icon={<X className="h-4 w-4" />}
              title={t("deps.cancel")}
              hint={t("deps.scanning", { done: scanningDone, total: selectedSlugs.length })}
              actionLabel={t("deps.cancel")}
              onAction={cancel}
              secondary
              danger
            />
          )}

          {phase === "idle" && (
            <SettingRow
              icon={<PackageSearch className="h-4 w-4" />}
              title={t("deps.idleTitle")}
              hint={t("deps.idleHint")}
            />
          )}

          {phase === "scanning" &&
            selectedSlugs.map((slug) => {
              const st = states[slug] ?? "pending";
              const ans = answers.find((a) => a.slug === slug);
              const base = stateLabel(t, st);
              const hint =
                st === "pending" || st === "checking"
                  ? base
                  : `${base} · ${answerHint(t, ans?.manager ?? "", ans?.outdated.length ?? 0, ans?.error ?? null)}`;
              return (
                <SettingRow
                  key={slug}
                  icon={stateIcon(st)}
                  title={<span className="font-mono">{slug}</span>}
                  hint={hint}
                />
              );
            })}

          {phase === "ready" && (
            <>
              <SettingRow
                icon={<CircleCheckBig className="h-4 w-4" />}
                title={t("deps.summary", {
                  repos: agg.totals.repos,
                  packages: agg.totals.packages,
                  outdated: agg.totals.outdated,
                  errors: agg.totals.errors,
                })}
                hint={cancelled ? t("deps.cancelled") : undefined}
              />

              {agg.totals.errors > 0 && (
                <>
                  <div className="px-2.5 pt-2 text-caption font-medium text-foreground">
                    {t("deps.errorsTitle")}
                  </div>
                  {agg.repos
                    .filter((r) => r.error !== null)
                    .map((r) => (
                      <SettingRow
                        key={r.slug}
                        danger
                        icon={<TriangleAlert className="h-4 w-4" />}
                        title={<span className="font-mono">{r.slug}</span>}
                        hint={r.error ?? undefined}
                      />
                    ))}
                </>
              )}

              {agg.managers.length > 0 && (
                <>
                  <div className="px-2.5 pt-2 text-caption font-medium text-foreground">
                    {t("deps.managersTitle")}
                  </div>
                  {agg.managers.map((m) => (
                    <SettingRow
                      key={m.manager}
                      icon={<PackageSearch className="h-4 w-4" />}
                      title={managerLabel(t, m.manager)}
                      hint={t("deps.managerLine", { repos: m.repos, outdated: m.outdated })}
                    />
                  ))}
                </>
              )}

              <div className="px-2.5 pt-2 text-caption font-medium text-foreground">
                {t("deps.packagesTitle")}
              </div>
              {agg.packages.length === 0 ? (
                agg.totals.repos > 0 && agg.totals.errors < agg.totals.repos ? (
                  <SettingRow
                    icon={<CircleCheckBig className="h-4 w-4" />}
                    title={t("deps.allCurrent")}
                  />
                ) : null
              ) : (
                <>
                  <ul
                    aria-label={t("deps.listAria", { n: table.shown.length })}
                    className="m-0 flex list-none flex-col gap-1 p-0 px-2.5 py-2"
                  >
                    {table.shown.map((p) => (
                      <li
                        key={p.name}
                        className="border border-border/60 bg-background/40 px-2 py-1.5"
                      >
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="min-w-0 truncate font-mono text-caption text-foreground">
                            {p.name}
                          </span>
                          <span className="shrink-0 font-mono text-caption text-warning">
                            {p.latest}
                          </span>
                        </div>
                        <p className="app-desc m-0 mt-0.5 break-words text-caption text-muted-foreground">
                          {p.repos
                            .map(
                              (e) =>
                                `${e.slug.replace(/^github\.com\//, "")} ${e.current}→${e.wanted}`,
                            )
                            .join(" · ")}
                        </p>
                      </li>
                    ))}
                  </ul>
                  {table.hidden > 0 && (
                    <p className="app-desc px-2.5 pb-1 text-caption text-muted-foreground">
                      {t("deps.truncatedNote", { limit: PACKAGE_CAP, hidden: table.hidden })}
                    </p>
                  )}
                </>
              )}

              <div className="px-2.5 pt-2 text-caption font-medium text-foreground">
                {t("deps.readingsTitle")}
              </div>
              {agg.repos.map((r) => (
                <SettingRow
                  key={r.slug}
                  icon={
                    r.error !== null ? (
                      <TriangleAlert className="h-4 w-4" />
                    ) : r.outdated > 0 ? (
                      <PackageSearch className="h-4 w-4" />
                    ) : (
                      <CircleCheckBig className="h-4 w-4" />
                    )
                  }
                  title={<span className="font-mono">{r.slug}</span>}
                  rowHint={managerLabel(t, r.manager)}
                  hint={answerHint(t, r.manager, r.outdated, r.error)}
                />
              ))}
            </>
          )}
        </>
      )}
    </SettingsGroup>
  );
}
