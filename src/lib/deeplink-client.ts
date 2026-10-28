/**
 * Deep Link 处理链的前端半段（r21 N3-2）：`deeplink://clone` 的**处理器**与它的
 * payload 校验。纯模块，Node 可测——`tests/deeplink-chain.test.ts` 直接构造处理器、
 * 把假事件喂进去，钉住「收到事件 → 校验 → toast → startDownload」这条链。
 *
 * ## 为什么 `listen(...)` 那一行留在 App.tsx，只有处理器搬出来
 *
 * 两半都要钉，但能钉的方式不同：
 *
 *   - **处理器**（收到什么、拒绝什么、先 toast 还是先入队）是行为，搬进纯模块就能
 *     真的执行断言——在 App.tsx 里它既 import 不进来，也没有接缝可注入假事件。
 *   - **监听注册**留在原地是有意的：`scripts/check-events.mjs` 只认
 *     `listen("字面量", …)` 且所在文件 import 了 `@tauri-apps/api/event` 才把一个
 *     事件名算作「有人在听」（见该文件的 `listenRe` / `eventModuleImportRe` 与
 *     「a `listen` moved behind a helper … drops the whole file」那条注释）。把调用
 *     挪进助手函数会让 `deeplink://clone` 从配对表里消失、门禁直接变红。
 *     所以注册行照原样留在 App.tsx，测试用**结构断言**钉它，并断言这里的
 *     `DEEPLINK_CLONE_EVENT` 与 App 源码里的字面量逐字节相同——两处写错任何一处
 *     都会红。
 *
 * ## 校验为什么放在**事件这一层**，而不是 preflight 或后端
 *
 * 后端本来就已经校验过（`src-tauri/src/lib.rs` 两处 `emit`：setup 走
 * `extract_clone_target`，second-instance 走 `parse` 后的非空检查，emit 的都是
 * `{owner}/{repo}`）——但事件到达前端时类型只有 `string`，没有任何形状保证；而它
 * 一旦骗过守卫，两条下游路都不好：
 *
 *   - **一段式**（`"torvalds"`）：`parse_ref` 判 `InvalidRef`
 *     （`src-tauri/src/downloader.rs` 的 `parts.len()` 分支），`preflight` 在 catch
 *     里 `reportError(err, "无法开始下载")` —— 一次没人发起的动作在界面上留下一条
 *     失败记录和一条故障历史，看着像应用自己出了错。
 *   - **三段及以上**（`"a/b/c"`）：`parse_ref` 反而**接受**——它取后三段当
 *     host/owner/repo，于是 `https://a/b/c` 会被排进下载队列，几十秒后才在任务里
 *     失败。添加页必须这样（`host/owner/repo` 是合法输入），所以那一层不能收紧。
 *
 * 深链自己的契约只有两段：`devhub://owner/repo` 与 `devhub://clone/owner/repo`
 * （`src-tauri/src/deeplink.rs` 模块头与 `parse`）。契约在哪一层定义，就在哪一层
 * 收口——这层因此只认两段，且每段都得是 GitHub 的合法组成（字母数字与 `._-`，
 * 拒绝 `.` / `..`：`D:/x`、`../x` 这类会被 `parse_ref` 当成本地路径的形状过不了）。
 *
 * 这是**纵深防御**而不是修 bug：Rust 侧两处 emit 的校验一行没动，本文件只保证
 * 事件这一侧也说同一句话。
 */

/** 事件名。与 App.tsx 里 `listen("…")` 的字面量、以及 Rust 侧两处 `emit` 必须一致
 * （`tests/deeplink-chain.test.ts` 把三处互钉；这里刻意不导出常量——check-events
 * 只认调用点上的字面量，导出一个没人调用的常量等于制造第二个真相）。 */
export type DeepLinkEvent = { payload: unknown };

/** 注入给处理器的三条去向：提示、入队、以及被拦下时的那句提示。 */
export type DeepLinkTarget = {
  /** 与 `App.startDownload(ref, source)` 同签名；深链两侧都传 `owner/repo`。 */
  startDownload: (ref: string, source: string) => void;
  onCloning: (repo: string) => void;
  /** 被拦下的 payload 已经转成可显示的文本。 */
  onIgnored: (payload: string) => void;
};

/** GitHub 组成字符之外一律不收：冒号/反斜杠/百分号/空白都会让下游产生别的解释。 */
const SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * `owner/repo`，或 `null`（这个 payload 不是深链契约里的两段式）。
 *
 * 长这样才收：**恰好一个** `/`、两段都非空、都过 `SEGMENT`、且都不是 `.`/`..`。
 * 接受时返回归一化后的 `owner/repo`（trim 过、两段重组）——Rust 侧 emit 的本来
 * 就是 `format!("{owner}/{repo}")`，所以对合法 payload 这一步不改变任何字节。
 */
export function cloneTargetOf(payload: unknown): string | null {
  if (typeof payload !== "string") return null;
  const parts = payload.trim().split("/");
  if (parts.length !== 2) return null;
  for (const part of parts) {
    if (part === "" || part === "." || part === "..") return null;
    if (!SEGMENT.test(part)) return null;
  }
  return `${parts[0]}/${parts[1]}`;
}

/** 给被拒的 payload 一句能看的话：字符串照抄，其余走 JSON（失败再退回 typeof）。 */
function asText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (payload === null || payload === undefined) return String(payload);
  try {
    return JSON.stringify(payload) ?? typeof payload;
  } catch {
    return typeof payload;
  }
}

/**
 * 造一个 `deeplink://clone` 处理器。
 *
 * 顺序是契约：先 `onCloning`（toast）再 `startDownload` —— 原来那两行的顺序就是
 * 这样，先提示再入队，反过来会看到「提示还没出、队列已经动了」。
 */
export function makeDeepLinkCloneHandler(target: DeepLinkTarget) {
  return (event: DeepLinkEvent): void => {
    const repo = cloneTargetOf(event.payload);
    if (repo === null) {
      target.onIgnored(asText(event.payload));
      return;
    }
    // ref 和 source 都用 "owner/repo"——preflight 和 download_repo 都支持这种格式。
    target.onCloning(repo);
    target.startDownload(repo, repo);
  };
}

/**
 * 造一个 `deeplink://open` 处理器（r25-N3）。
 *
 * payload 与 clone 同形，复用同一道校验；区别只在动作：只打开本地已有项目，
 * 绝不因为一条链接开始下载。
 */
export function makeDeepLinkOpenHandler(target: DeepLinkOpenTarget) {
  return (event: DeepLinkEvent): void => {
    const repo = cloneTargetOf(event.payload);
    if (repo === null) {
      target.onIgnored(asText(event.payload));
      return;
    }
    target.open(repo);
  };
}

/** 打开动作需要注入的最小面。 */
export type DeepLinkOpenTarget = {
  open: (repo: string) => void;
  onIgnored: (payload: string) => void;
};
