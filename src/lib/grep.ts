/**
 * 「在项目中搜索」（`repo_grep`）的纯逻辑层（r21-N1）。
 *
 * ## 定位（来自 R1 的 bakeoff 结论，不是本文件的发明）
 *
 * R1 的 bakeoff 结论：`repo_grep` **只做单仓库的行级内容检索**，不参与跨仓库排序
 * （跨仓库标识形态召回 0、成本比 BM25 高两个数量级、且返回自身不排序）。所以这一层
 * 从类型到参数都钉在「一个 root + 一个 pattern」上：没有 slug 列表，没有打分，输出
 * 只有「哪个文件哪一行」。
 *
 * ## 为什么这些决策住在 `.ts` 而不是对话框里
 *
 * Node 的类型剥离拒绝 `.tsx`（`tests/lib-import-graph.test.ts` 头部），所以任何
 * 「给它这些输入它返回什么」的判断——分组、截断、后端错误与空结果的分界——放不进
 * `.tsx` 就等于没有测试。本模块因此只依赖两件可注入的东西：命令通道 `invoke` 与
 *（N1-2 起的）计时器；测试用 fake 驱动，生产里就是 `@tauri-apps/api/core` 的 invoke。
 *
 * ## 能力边界（与 docs/repo-grep.md 一致）
 *
 * 单仓库、行级；后端忽略 `.git`/`node_modules`/`target`/… 与白名单外的扩展名，
 * 扫描深度上限 8；命中数到达 `limit` 即截断——截断是**可见的**（`truncated`），不是
 * 静默的。
 */
import { messageOf } from "./report-error";

/**
 * 前端显式传的命中上限 = 后端默认值（`searchgrep.rs` 的 `limit.unwrap_or(500)`）。
 *
 * 为什么显式传而不是省略：截断提示要拿 `hits.length >= limit` 判断，靠后端默认值
 * 意味着提示的正确性悬在另一份代码的默认值上——它一改，界面就会对着 500 条命中说
 * 「没有截断」。500 也是「一个对话框列表渲染得动、IPC 载荷不至于撑爆」的量级。
 */
export const GREP_LIMIT = 500;

/**
 * 输入停顿多久才把一次改动发出去（r21-N1-2）。
 *
 * 取 700 而不是别的数：这就是本仓搜索输入的默认停顿——设置页「搜索输入停顿」的
 * 默认值与添加页搜索都读 `searchDebounceMs ?? 700`。同一种「打字即搜」的交互在
 * 这里用同一个手感，不另立一个数。
 */
export const GREP_DEBOUNCE_MS = 700;

/**
 * pattern 的字符上限（r21-N1-2）。
 *
 * 依据分两半：
 *   - **回溯爆炸（ReDoS）这一轴不归前端管**：本仓的正则是 `searchgrep.rs` 用
 *     `regex` crate 编译的，它按自动机匹配、线性时间，`.*` 类嵌套写法不会指数回溯，
 *     所以「恶意正则卡死后端」不是这个上限要挡的东西。
 *   - **要挡的是输入规模 × 扫描量**：pattern 每长一分，正则编译更贵，且每一次
 *     逐行匹配都要花这笔钱——成本按「pattern 长度 × 被扫描的行数」乘算，而扫描是
 *     整个仓库。200 字符足够写下任何现实的检索式（含 `TODO|FIXME` 这类交替与
 *     `{1,3}` 量词），再长的基本是误粘贴，前端直接判死比让后端跑一遍更诚实。
 */
export const PATTERN_MAX = 200;

/** 一条结果行的完整形状，与 `GrepResult`/`GrepHit`（searchgrep.rs）一一对应。 */
export type GrepHit = { file: string; line: number; content: string };

export type GrepResult = {
  pattern: string;
  root: string;
  files_scanned: number;
  /** Files refused by the backend's size/binary policy; absent on old builds. */
  files_skipped?: number;
  hits: GrepHit[];
  elapsed_ms: number;
  /** 后端原话（正则编译失败 / 目录不存在），原样呈现，不当作「没找到」。 */
  error: string | null;
};

/** 按文件分好组的一段命中，顺序 = 第一次出现的文件顺序。 */
export type GrepGroup = { file: string; hits: GrepHit[] };

/** 前端侧就能判定、还没发请求的两种「这次不能问」。 */
export type GrepIssue = "empty" | "tooLong";

/** 一次查询的全部输入：单仓库（root）+ pattern，没有第二个仓库的位置。 */
export type GrepQuery = { root: string; pattern: string; caseInsensitive: boolean };

/**
 * 屏幕上的五种状态 + 两种「问不了」。
 *
 * `error` 与 `empty` 是**互斥的两态**，这是本方向最要紧的一条：后端 `error` 字段
 * 说的是「这次搜索没跑成」（正则非法、目录不存在），而 `empty` 说的是「跑成了、
 * 没有行匹配」。把前者画成后者就是把故障说成结论。
 */
export type GrepView =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "invalid"; issue: GrepIssue }
  | { kind: "error"; message: string }
  | { kind: "empty"; filesScanned: number; filesSkipped: number; elapsedMs: number }
  | {
      kind: "hits";
      groups: GrepGroup[];
      total: number;
      filesScanned: number;
      filesSkipped: number;
      elapsedMs: number;
      /** 命中数碰到 limit：界面必须说出「后面还有」。 */
      truncated: boolean;
    };

/**
 * 命令通道。生产里就是 `invoke`（对话框包一层以固定返回类型）；测试注入 fake，
 * 这也是「组件测试（fake invoke）」落地的地方——判定点全在本模块，不在 JSX 里。
 */
export type GrepInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<GrepResult>;

/**
 * 调 `repo_grep`。参数名是 camelCase：Tauri 2 把 JS 侧的驼峰按键转成 Rust 的
 * snake_case 形参（同仓先例 `create_new` ← `createNew`、`max_parallel` ← `maxParallel`）。
 */
export async function runGrep(
  invoke: GrepInvoke,
  query: GrepQuery,
  limit: number = GREP_LIMIT,
): Promise<GrepResult> {
  return await invoke("repo_grep", {
    root: query.root,
    pattern: query.pattern,
    caseInsensitive: query.caseInsensitive,
    limit,
  });
}

/**
 * 按文件分组，保持两类顺序：文件按**第一次命中**的顺序，行按返回顺序。
 *
 * 后端是逐文件逐行推进的，同一文件的命中通常连着；即便不连着（将来换了实现），
 * 这里也会把它们收拢到一个文件段下——渲染按文件分节，靠的就是这个不变量。
 */
export function groupHits(hits: readonly GrepHit[]): GrepGroup[] {
  const order: string[] = [];
  const byFile = new Map<string, GrepHit[]>();
  for (const hit of hits) {
    let bucket = byFile.get(hit.file);
    if (!bucket) {
      bucket = [];
      byFile.set(hit.file, bucket);
      order.push(hit.file);
    }
    bucket.push(hit);
  }
  return order.map((file) => ({ file, hits: byFile.get(file) ?? [] }));
}

/**
 * 一份后端回答 → 屏幕状态。三态三张脸，判据只有一处：
 *
 *   1. `error` 非空 → 原样呈现（正则编译失败的后端原话就在里面）；
 *   2. 零命中 → 空结果，带上扫描量与耗时，说明「查过才知道没有」；
 *   3. 有命中 → 按文件分组，命中数碰到 limit 就标记截断。
 */
export function classify(result: GrepResult, limit: number = GREP_LIMIT): GrepView {
  if (result.error != null) {
    return { kind: "error", message: result.error };
  }
  const filesScanned = result.files_scanned;
  const filesSkipped = result.files_skipped ?? 0;
  const elapsedMs = result.elapsed_ms;
  if (result.hits.length === 0) {
    return { kind: "empty", filesScanned, filesSkipped, elapsedMs };
  }
  return {
    kind: "hits",
    groups: groupHits(result.hits),
    total: result.hits.length,
    filesScanned,
    filesSkipped,
    elapsedMs,
    truncated: result.hits.length >= limit,
  };
}

export type GrepSessionDeps = {
  invoke: GrepInvoke;
  /** 状态出口：对话框把它接给 `setState`，测试把它接给一个数组。 */
  emit: (view: GrepView) => void;
  limit?: number;
  /** 打字到查询之间的停顿；默认 `GREP_DEBOUNCE_MS`。 */
  debounceMs?: number;
  /** 计时器注入点：生产是 `setTimeout`/`clearTimeout`，测试喂假时钟（同 `lib/poll-loop.ts` 的做法）。 */
  schedule?: (fn: () => void, ms: number) => number;
  unschedule?: (handle: number) => void;
};

export type GrepSession = {
  /** 立即查一次（搜索按钮 / Enter / 切换忽略大小写）。 */
  run(query: GrepQuery): void;
  /** 打字走的路：停顿 `debounceMs` 才查，期间再改一次就作废上一次计划。 */
  type(query: GrepQuery): void;
  /** 关闭对话框时调：取消计时，在途回答从此落地无门。 */
  dispose(): void;
};

/**
 * 发请求之前前端就能判死的两件事：空 pattern 与超长 pattern。
 *
 * 只判「trim 之后是否为空」，发出去的仍是**用户原样的** pattern——首尾空格在正则里
 * 可以是有意的（`" foo "` 匹配带空格的行），替用户吞掉就是改了他输入的东西。
 * 超长的依据写在 `PATTERN_MAX` 上。
 */
export function checkPattern(pattern: string): GrepIssue | null {
  if (pattern.trim() === "") return "empty";
  if (pattern.length > PATTERN_MAX) return "tooLong";
  return null;
}

/**
 * 命中行的绝对路径：后端给的 `file` 是相对 root 的（`strip_prefix`），reveal 需要全路径。
 *
 * 分隔符统一成 `\`：Windows 后端返回的多半本来就是反斜杠，而含 `/` 的（拼接而来、
 * 或后端哪天换实现）也归一——同一个动作在不同文件上给出两种路径形状，排查时就是
 * 两种说法。尾部分隔符先去掉，避免拼出 `D:\p\\src`。
 */
export function hitAbsolutePath(root: string, file: string): string {
  const base = root.replace(/[\\/]+$/, "").replace(/\//g, "\\");
  return `${base}\\${file.replace(/\//g, "\\")}`;
}

/** 复制结果的行格式：`file:line:content`——和 grep 命令行的输出一个形状，可直接粘回编辑器。 */
export function grepCopyLines(groups: readonly GrepGroup[]): string[] {
  const out: string[] = [];
  for (const group of groups) {
    for (const hit of group.hits) out.push(`${group.file}:${hit.line}:${hit.content}`);
  }
  return out;
}

/**
 * ↑/↓ 落到哪一格。抽出来是因为它是键盘浏览的全部规则，而 `.tsx` 里写死的规则测不到。
 *
 * 焦点模型照 `ContextMenu` 的 `aria-activedescendant` 先例：容器保持焦点，行只被
 * 播报、本身不进 Tab 序。移动规则这里是**钳位**（列表走到头就停），不是菜单的循环
 * ——结果列表最多 500 行，绕回头的成本比停在两端高。`-1` = 还没选中，两个方向都
 * 从第一行起步。
 */
export function nextActive(current: number, key: "ArrowUp" | "ArrowDown", total: number): number {
  if (total <= 0) return -1;
  if (key === "ArrowDown") return Math.min(current + 1, total - 1);
  if (current < 0) return 0;
  return Math.max(current - 1, 0);
}

/**
 * 一次只认最新答案的查询会话。
 *
 * 两次快速搜索之间没有先后保证：慢的那次可能后到。`seq` 是会话自己的戳——每次
 * `run`/`type` 递增，回答落地时对不上就丢弃（`App.tsx` 的 `reposSeq` /
 * `StarImportPanel` 的 `seq` 同款纪律，本仓到处都有先例）。错误分支同样对戳：
 * 一个已被取代的请求迟到的失败不许覆盖新结果的状态。
 *
 * 防抖与竞态是同一个问题的两半：停顿期内的第 n 次输入要作废前 n-1 次**计划**
 *（`cancelTimer`），而在路上的请求要作废**回答**（`seq`）——只做前者，一个旧
 * 请求就能在新输入敲定前把旧答案盖回来。
 */
export function createGrepSession(deps: GrepSessionDeps): GrepSession {
  const limit = deps.limit ?? GREP_LIMIT;
  const debounceMs = deps.debounceMs ?? GREP_DEBOUNCE_MS;
  const schedule = deps.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const unschedule = deps.unschedule ?? ((handle: number) => clearTimeout(handle));
  let seq = 0;
  let timer: number | null = null;

  const cancelTimer = () => {
    if (timer !== null) {
      unschedule(timer);
      timer = null;
    }
  };

  const fire = (query: GrepQuery) => {
    cancelTimer();
    const issue = checkPattern(query.pattern);
    if (issue) {
      // 问不了（按了搜索但输入是空的/超长）：作废在途请求并直接给脸。
      seq += 1;
      deps.emit({ kind: "invalid", issue });
      return;
    }
    const mine = ++seq;
    deps.emit({ kind: "loading" });
    void (async () => {
      try {
        const result = await runGrep(deps.invoke, query, limit);
        if (mine !== seq) return;
        deps.emit(classify(result, limit));
      } catch (e) {
        if (mine !== seq) return;
        deps.emit({ kind: "error", message: messageOf(e) });
      }
    })();
  };

  return {
    run: fire,
    type(query) {
      cancelTimer();
      const issue = checkPattern(query.pattern);
      if (issue) {
        // 清空输入 → 回到 idle（没有要问的东西，不报警）；超长 → invalid 给脸。
        // 两种都作废在途：输入已经和屏幕上的结果对不上了。
        seq += 1;
        deps.emit(issue === "empty" ? { kind: "idle" } : { kind: "invalid", issue });
        return;
      }
      // 一动键盘就作废在途回答，但**不**改屏幕状态：停顿期间保留上一次的结果，
      // 不闪 loading——真正发问时 `fire` 自己会亮。
      seq += 1;
      timer = schedule(() => {
        timer = null;
        fire(query);
      }, debounceMs);
    },
    dispose() {
      cancelTimer();
      // 递增而不是布尔开关：下一次 `run` 自然拿到更大的戳，不需要清理字段。
      seq += 1;
    },
  };
}
