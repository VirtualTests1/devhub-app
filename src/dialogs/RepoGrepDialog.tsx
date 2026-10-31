import { useEffect, useId, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CircleCheckBig, Copy, FileSearch, LoaderCircle, TriangleAlert } from "lucide-react";
import { DialogShell } from "../components/DialogShell";
import { toast } from "../components/Toast";
import { useI18n } from "../lib/useI18n";
import { reportError } from "../lib/report-error";
import { cn } from "../lib/utils";
import {
  GREP_DEADLINE_SECONDS,
  GREP_LIMIT,
  PATTERN_MAX,
  checkPattern,
  createGrepSession,
  grepCopyLines,
  hitAbsolutePath,
  nextActive,
  type GrepHit,
  type GrepInvoke,
  type GrepResult,
  type GrepSession,
  type GrepView,
} from "../lib/grep";
import type { RepoRef } from "../types";

/**
 * 「在项目中搜索」对话框（r21-N1-1 骨架 / r21-N1-2 交互）。
 *
 * ## 定位：单仓库的行级内容检索，不是跨仓库搜索
 *
 * 选型结论（历史记录）：`repo_grep` 返回「哪个文件哪一行」、
 * 自身不排序、跨仓库形态召回为 0，所以这个界面从入口到参数都**钉在一个仓库上**——
 * 从卡片右键菜单打开，`slug` 是这张卡片的身份，`root` 只用于「在资源管理器打开」
 * 与结果路径拼接；命令本身按 slug 在索引用解析，页面不能把任意路径交给扫描。没有仓库选择器，也没有相关性
 * 排序。要「哪个项目跟我相关」那一层，是命令面板 / 项目墙的事，不是这里。
 *
 * ## 入口为什么在卡片右键菜单
 *
 * 与「诊断…」「查看 README…」同一条路：这两个也都是**对某一个仓库**的只读查看，
 * 都由 `ProjectsView` 的 `buildMenu` 打开、都以 `card` 为唯一输入。搜索一个仓库的
 * 内容这件事，用户的第一问是「搜哪个」——卡片菜单把这个答案（我右键的这张卡）
 * 顺手给了，不需要对话框再问一遍。放在命令面板则要先选仓库，等于把一步拆成两步。
 *
 * ## 状态的诚实性
 *
 * 屏幕状态全部来自 `lib/grep.ts` 的 `classify`：后端 `error`（正则编译失败、目录
 * 不存在）原样呈现，**不**画成「没有命中」；空结果单独一张脸，并带上扫描了多少个
 * 文件、花了多少毫秒——「查过才知道没有」和「没查成」不能长一个样。命中碰到
 * `GREP_LIMIT` 时明说已截断，不静默吞掉后面的行。pattern 超过 `PATTERN_MAX` 是
 * 第三种脸（前端判死，请求根本不发）。
 *
 * ## 交互（r21-N1-2），规则住在 `lib/grep.ts`，这里只接线
 *
 * 打字防抖 `GREP_DEBOUNCE_MS`、旧请求晚到被丢弃、↑/↓ 钳位移动、复制行格式、
 * reveal 的路径拼接——判定点全在可测的 `.ts` 里（`tests/grep-session.test.ts` 驱动
 * fake invoke 与假时钟），本文件只把它们接到 DOM：listbox 保持焦点、行靠
 * `aria-activedescendant` 播报（`ContextMenu` 先例），点击或 Enter 在资源管理器
 * 打开该行文件（`reveal_path`，与卡片菜单同一条命令、同一句失败文案）。
 *
 * ## 验证边界
 *
 * 本对话框在类型 / 构建 / 单测层验证，未在真机 WebView2 里驱动过——不声称视觉上
 * 已验证。
 */
type Card = RepoRef & { slug: string };

/**
 * 模块级常量：会话 effect 只建一次，`invoke` 的身份不能每次渲染都变
 * （`react-hooks/exhaustive-deps` 是 error 级棘轮）。
 */
const grepInvoke: GrepInvoke = (cmd, args) => invoke<GrepResult>(cmd, args);

export function RepoGrepDialog({ card, onClose }: { card: Card | null; onClose: () => void }) {
  const { t } = useI18n();
  const root = (card?.path ?? "").trim();
  const slug = (card?.slug ?? "").trim();
  const listId = useId();

  const [pattern, setPattern] = useState("");
  const [ci, setCi] = useState(false);
  const [view, setView] = useState<GrepView>({ kind: "idle" });
  /** listbox 的当前项，`-1` = 未选中（`aria-activedescendant` 此时指向 nothing）。 */
  const [active, setActive] = useState(-1);
  const sessionRef = useRef<GrepSession | null>(null);

  useEffect(() => {
    const session = createGrepSession({
      invoke: grepInvoke,
      emit: (next) => {
        // 一轮新查询（含 loading/invalid/idle）落地时选择归位：否则 ↑↓ 会指着
        // 上一批结果里的同一格，而那一格在新结果里已经是别的行。
        setActive(-1);
        setView(next);
      },
    });
    sessionRef.current = session;
    return () => {
      session.dispose();
      sessionRef.current = null;
    };
  }, []);

  const query = (mode: "run" | "type") => {
    if (!slug) return;
    const q = { slug, pattern, caseInsensitive: ci };
    if (mode === "run") sessionRef.current?.run(q);
    else sessionRef.current?.type(q);
  };

  const toggleCi = () => {
    const next = !ci;
    setCi(next);
    // 显式点击 → 立即重查（不是打字，没有防抖的理由）；输入还不能问就不问，
    // 不借这次点击弹一张「先输入」的脸。
    if (slug && checkPattern(pattern) === null) {
      sessionRef.current?.run({ slug, pattern, caseInsensitive: next });
    }
  };

  const reveal = (path: string) => {
    // 与卡片菜单「在资源管理器打开」同一条命令、同一句失败文案（wall.revealFail）。
    void invoke("reveal_path", { path }).catch((e) => reportError(e, t("wall.revealFail")));
  };

  const copyResults = async () => {
    if (view.kind !== "hits") return;
    const lines = grepCopyLines(view.groups);
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      toast.success(t("grep.copied", { n: lines.length }));
    } catch {
      toast.error(t("settings.page.failuresClipboardDenied"));
    }
  };

  if (!card) return null;

  const total = view.kind === "hits" ? view.total : 0;
  const activeIndex = active >= 0 && active < total ? active : -1;

  /** 平铺序号 → 该行（顺序与渲染一致：文件组顺序 × 组内行序）。 */
  const hitAt = (index: number): { file: string; hit: GrepHit } | null => {
    if (view.kind !== "hits" || index < 0) return null;
    let i = index;
    for (const group of view.groups) {
      for (const hit of group.hits) {
        if (i === 0) return { file: group.file, hit };
        i -= 1;
      }
    }
    return null;
  };

  const onListKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive(nextActive(activeIndex, e.key, total));
      return;
    }
    if (e.key === "Enter") {
      const at = hitAt(activeIndex);
      if (at) {
        e.preventDefault();
        reveal(hitAbsolutePath(root, at.file));
      }
    }
  };

  return (
    <DialogShell
      title={t("grep.dialogTitle")}
      initialFocus="content"
      subtitle={root || `${card.owner}/${card.repo}`}
      onClose={onClose}
      width="lg"
      regId="grep-dialog"
      footer={
        view.kind === "hits" || view.kind === "empty" ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-caption text-muted-foreground">
              {t("grep.stats", {
                files: view.filesScanned,
                hits: view.kind === "hits" ? view.total : 0,
                ms: view.elapsedMs,
              })}
            </span>
            {view.filesSkipped > 0 && (
              <span className="text-caption text-muted-foreground">
                {t("grep.skipped", { n: view.filesSkipped })}
              </span>
            )}
            {view.kind === "hits" && view.truncated && (
              <span className="text-caption text-warning">{t("grep.truncated", { limit: GREP_LIMIT })}</span>
            )}
            {view.kind === "hits" && view.timedOut && (
              <span className="text-caption text-warning">
                {t("grep.timedOut", { seconds: GREP_DEADLINE_SECONDS })}
              </span>
            )}
          </div>
        ) : null
      }
    >
      {!root ? (
        <p className="py-2 text-caption text-muted-foreground">{t("grep.noPath")}</p>
      ) : (
        <>
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              query("run");
            }}
          >
            <input
              value={pattern}
              onChange={(e) => {
                setPattern(e.target.value);
                // 打字走防抖：会话自己作废上一次计划与在途回答。
                if (!slug) return;
                sessionRef.current?.type({
                  slug,
                  pattern: e.target.value,
                  caseInsensitive: ci,
                });
              }}
              aria-label={t("grep.patternAria")}
              placeholder={t("grep.placeholder")}
              spellCheck={false}
              autoComplete="off"
              className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2.5 py-1.5 font-mono text-body text-foreground outline-none transition-colors focus:border-primary/60"
            />
            <button
              type="submit"
              className="skin-ctl inline-flex shrink-0 items-center gap-1.5 border border-border px-2.5 py-1.5 text-caption text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <FileSearch className="h-3.5 w-3.5" />
              {t("grep.search")}
            </button>
          </form>

          <div className="mb-3 mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
            <label className="flex cursor-pointer items-center gap-1.5 text-caption text-muted-foreground">
              <input type="checkbox" checked={ci} onChange={() => toggleCi()} className="accent-primary" />
              {t("grep.caseInsensitive")}
            </label>
            <span className="text-caption text-muted-foreground">{t("grep.keyboardHint")}</span>
            <button
              type="button"
              onClick={() => void copyResults()}
              disabled={view.kind !== "hits"}
              title={t("grep.copy")}
              className="skin-ctl inline-flex items-center gap-1.5 border border-border px-2.5 py-1 text-caption text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
            >
              <Copy className="h-3.5 w-3.5" />
              {t("grep.copy")}
            </button>
          </div>

          {view.kind === "idle" && <p className="py-2 text-caption text-muted-foreground">{t("grep.idle")}</p>}

          {view.kind === "loading" && (
            <p className="flex items-center gap-1.5 py-2 text-caption text-muted-foreground">
              <LoaderCircle className="h-3 w-3 animate-spin" />
              {t("grep.loading")}
            </p>
          )}

          {view.kind === "error" && (
            // 后端原话走 {msg} 槽原样呈现：正则编译失败的细节只在那一句里，
            // 翻译成「没找到」会把「没查成」说成结论。
            <p
              role="alert"
              className="rounded-lg border border-danger/30 bg-danger/5 px-2.5 py-2 text-caption text-danger"
            >
              {t("grep.failed", { msg: view.message })}
            </p>
          )}

          {view.kind === "empty" && (
            <div className="flex items-start gap-2 py-3">
              {view.timedOut ? (
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              ) : (
                <CircleCheckBig className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              )}
              <div>
                <p className="text-body font-medium text-foreground">{t("grep.emptyTitle")}</p>
                <p className="mt-0.5 text-caption leading-snug text-muted-foreground">
                  {t("grep.emptyHint", { files: view.filesScanned, ms: view.elapsedMs })}
                </p>
                {view.timedOut && (
                  <p className="mt-0.5 text-caption leading-snug text-warning">
                    {t("grep.timedOut", { seconds: GREP_DEADLINE_SECONDS })}
                  </p>
                )}
                {view.filesSkipped > 0 && (
                  <p className="mt-0.5 text-caption leading-snug text-muted-foreground">
                    {t("grep.skipped", { n: view.filesSkipped })}
                  </p>
                )}
              </div>
            </div>
          )}

          {view.kind === "invalid" && (
            <p role="alert" className="py-2 text-caption text-danger">
              {view.issue === "empty" ? t("grep.needPattern") : t("grep.patternTooLong", { max: PATTERN_MAX })}
            </p>
          )}

          {view.kind === "hits" && (
            <div
              role="listbox"
              aria-label={t("grep.listAria", { n: total })}
              aria-activedescendant={activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
              tabIndex={0}
              onKeyDown={onListKey}
              className="flex flex-col gap-2 rounded-lg outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
            >
              {view.groups.map((group, gi) => {
                // 组的平铺起点：listbox 的 id 序号必须和 hitAt 的平铺顺序一致。
                const offset = view.groups.slice(0, gi).reduce((n, g) => n + g.hits.length, 0);
                return (
                  <section
                    key={group.file}
                    className="overflow-hidden rounded-lg border border-border-weak bg-background"
                  >
                    <header className="flex items-center justify-between gap-2 border-b border-border-weak px-2.5 py-1.5">
                      <span className="min-w-0 truncate font-mono text-caption text-foreground" title={group.file}>
                        {group.file}
                      </span>
                      <span className="shrink-0 text-caption text-muted-foreground">
                        {t("grep.hitCount", { n: group.hits.length })}
                      </span>
                    </header>
                    <ul>
                      {group.hits.map((hit, i) => {
                        const index = offset + i;
                        const path = hitAbsolutePath(root, group.file);
                        return (
                          <li
                            key={`${group.file}:${hit.line}:${i}`}
                            id={`${listId}-${index}`}
                            role="option"
                            aria-selected={index === activeIndex}
                            title={t("grep.revealTitle", { path })}
                            onMouseEnter={() => setActive(index)}
                            onClick={() => reveal(path)}
                            className={cn(
                              "flex cursor-pointer gap-2 border-b border-border-weak/50 px-2.5 py-1 last:border-b-0",
                              index === activeIndex ? "bg-accent" : "hover:bg-accent/60",
                            )}
                          >
                            <span className="w-12 shrink-0 select-none text-right font-mono text-caption text-muted-foreground">
                              {hit.line}
                            </span>
                            <code className="min-w-0 flex-1 whitespace-pre-wrap break-all font-mono text-caption text-foreground">
                              {hit.content}
                            </code>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                );
              })}
            </div>
          )}
        </>
      )}
    </DialogShell>
  );
}
