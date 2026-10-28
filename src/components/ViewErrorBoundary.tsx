import { Component, type ErrorInfo, type ReactNode } from "react";
import { t } from "../lib/i18n";
import { messageOf } from "../lib/report-error";
import { recordFailure } from "../store/failures";

/**
 * 视图级 Error Boundary（O2: 多层错误隔离）。
 *
 * 当前 `main.tsx` 的顶层 ErrorBoundary 会在任何渲染错误时卸载整个 `<App />`
 * 树 —— 这意味着 ProjectsView 里一个空引用就能让设置页、状态栏、甚至 ToastHost
 * 全部消失，用户面对的是一整屏白字红字的栈追踪，没有任何恢复入口。
 *
 * 这个组件在**每个可导航视图**外面再套一层：一个视图崩溃只隔离这个视图的渲染，
 * 其它视图、侧栏、状态条继续工作，错误面板提供一个「重试」按钮（重置 state）
 * 和一个「复制详情」按钮（把栈追踪拷进剪贴板，让报告时能带走证据）。
 *
 * 与顶层边界的关系：顶层边界兜底（boot 阶段或 Error Boundary 自身出错），
 * 本组件处理「应用正在运行中、某个视图渲染时崩了」这个更常见的场景。
 */

type Props = {
  children: ReactNode;
  /** 崩溃时显示的标题，比如「项目页」。经 i18n t() 调用方传入中文。 */
  label: string;
  /** 可选：崩溃时调用，把错误写进 activity 或其它持久化日志。 */
  onError?: (error: Error, info: ErrorInfo) => void;
};

type State = { error: Error | null };

export class ViewErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 保持在 console 里，devtools 还能看到完整组件栈。
    console.error("[devhub] ViewErrorBoundary caught", error, info);
    this.props.onError?.(error, info);
    // 同时写进失败历史——这样就算用户忘了复制详情，记录页也有一条。
    recordFailure("runtime", this.props.label, messageOf(error));
  }

  /** 重置 state，让「重试」按钮可以重新渲染子树。 */
  private handleRetry = () => this.setState({ error: null });

  /** 把错误详情拷进剪贴板，方便报告。 */
  private handleCopy = async () => {
    if (!this.state.error) return;
    const detail = `${this.props.label}\n\n${this.state.error.message}\n\n${this.state.error.stack ?? ""}`;
    try {
      await navigator.clipboard.writeText(detail);
    } catch {
      // 剪贴板不可用时静默——主要发生在非安全上下文，但 Tauri 的 webview 是安全的。
    }
  };

  render() {
    if (!this.state.error) return this.props.children;

    const err = this.state.error;
    return (
      <div
        role="alert"
        className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center"
      >
        <div className="rounded-full border border-danger/40 bg-danger/10 px-3 py-1 text-caption font-medium text-danger">
          {this.props.label}
        </div>
        <p className="max-w-md text-body text-muted-foreground">
          {t("errorboundary.hint")}
        </p>
        <pre
          className="max-h-48 w-full max-w-lg overflow-auto rounded-lg border border-border-weak bg-black/30 p-3 text-left text-[11px] leading-relaxed text-danger/80"
          style={{ whiteSpace: "pre-wrap" }}
        >
          {err.message}
          {"\n\n"}
          {err.stack ?? t("errorboundary.noStack")}
        </pre>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={this.handleRetry}
            className="skin-ctl bg-primary px-3 py-1.5 text-caption font-medium text-primary-foreground t-state hover:brightness-95 active:scale-[0.98]"
          >
            {t("errorboundary.retry")}
          </button>
          <button
            type="button"
            onClick={this.handleCopy}
            className="skin-ctl border border-border-weak bg-card px-3 py-1.5 text-caption font-medium text-muted-foreground t-state hover:bg-muted/30"
          >
            {t("errorboundary.copyDetail")}
          </button>
        </div>
      </div>
    );
  }
}
