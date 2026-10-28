// mcp-devhub.mjs — 把 DevHub 的项目容器暴露成一个 MCP (Model Context Protocol) 服务器。
//
// 传输：stdio。协议修订：2025-06-18（本文件能引用到的最新一版，逐页核对过，出处见下）。
//
// 零依赖是刻意的，不是偷懒：本仓库的 `node_modules` 在 linked worktree 里是指向根 checkout
// 的 junction，任何 `pnpm add` 都会重写别人正在用的 `.bin` shim（DEVELOPMENT.md 验证矩阵、
// eslint.config.js 头部注释都记着这条代价）。一个只说 JSON-RPC 的服务器不需要 SDK。
//
// ── 规范出处（2026-10-18 抓取，原文逐句核对）────────────────────────────────────────
//
// `basic/transports` §stdio（https://modelcontextprotocol.io/specification/2025-06-18/basic/transports）：
//   - "Messages are delimited by newlines, and MUST NOT contain embedded newlines."
//   - "The server MAY write UTF-8 strings to its standard error (`stderr`) for logging
//     purposes. Clients MAY capture, forward, or ignore this logging."
//   - "The server MUST NOT write anything to its `stdout` that is not a valid MCP message."
//     这一条决定了本文件里所有诊断信息只能进 stderr：连「参数写错了」的 usage 也不能 println。
//   - §Shutdown/stdio：客户端「先关闭子进程的输入流」，等不到再 SIGTERM。所以本服务器的退出
//     条件是 stdin 结束，而不是某个 `shutdown` 方法（规范明确 "No specific shutdown messages
//     are defined"）。
//
// `basic/index` §Messages（https://modelcontextprotocol.io/specification/2025-06-18/basic/index）：
//   - "All messages between MCP clients and servers MUST follow the JSON-RPC 2.0 specification."
//   - Requests："Requests MUST include a string or integer ID."、"Unlike base JSON-RPC, the ID
//     MUST NOT be null."、"The request ID MUST NOT have been previously used by the requestor
//     within the same session."
//   - Responses："Either a `result` or an `error` MUST be set. A response MUST NOT set both."、
//     "Error codes MUST be integers."
//   - Notifications："The receiver MUST NOT send a response."
//   注意：2025-06-18 的 `basic/index` 页面里**没有**错误码表（实测：该页标题只有
//   Overview / Messages / Auth / Schema）。错误码因此引用两个权威：JSON-RPC 2.0 原规范的
//   预定义码表（-32700/-32600/-32601/-32602/-32603，-32000..-32099 留给自定义），以及
//   `server/tools` §Error Handling 给出的 MCP 侧实例（未知工具用 -32602）。
//
// `basic/lifecycle`（https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle）：
//   - initialize 请求字段：`protocolVersion` / `capabilities` / `clientInfo`；
//     响应字段：`protocolVersion` / `capabilities` / `serverInfo` / `instructions`。
//   - §Version Negotiation："If the server supports the requested protocol version, it MUST
//     respond with the same version. Otherwise, the server MUST respond with another protocol
//     version it supports. This SHOULD be the latest version supported by the server."
//     客户端不支持就自行断开，服务器不许报错。
//   - 握手后客户端 MUST 发 `notifications/initialized`。
//
// `server/tools`（https://modelcontextprotocol.io/specification/2025-06-18/server/tools）：
//   - Tool 字段：`name` / `title`(可选) / `description` / `inputSchema` / `outputSchema`(可选) /
//     `annotations`(可选)；`tools/list` 结果是 `{ tools: [...], nextCursor? }`。
//   - `tools/call` 参数 `{ name, arguments }`，结果 `{ content, _meta?, structuredContent?, isError? }`。
//   - §Error Handling 把错误分两类：协议错误（未知工具、参数不合法）走 JSON-RPC error，
//     并给出 `{"code": -32602, "message": "Unknown tool: invalid_tool_name"}` 这个实例；
//     执行期错误走 `result` 里的 `isError: true`。
//   - ToolAnnotations（schema/2025-06-18/schema.ts）默认值：`readOnlyHint` false、
//     `destructiveHint` true、`idempotentHint` false、`openWorldHint` true。
//     本服务器的读工具显式写全 `readOnlyHint: true, destructiveHint: false, openWorldHint: false`，
//     不靠默认——默认值恰好是「危险」的那一侧。
//
// ── 安全边界：为什么 devhub_launch_plan / devhub_stop_plan 默认不注册 ──────────────
//
// 这个服务器读的是别人的项目容器：端口块、venv、已确认的启动命令都在 `.devhub.json` 里，
// 而那条命令一旦执行就是在用户机器上跑任意代码。所以：
//
//   1. 两个「写语义形状」的工具（`devhub_launch_plan` / `devhub_stop_plan`）只有在显式传
//      `--allow-mutations` 时才进 TOOLS 注册表。默认的 `tools/list` 里连名字都没有——一个没有被列出的工具，
//      客户端的自动批准策略就不会「顺手」批准它；反过来，先注册再用 annotations 说「我其实
//      不写」是把判断推给模型。名字里的 `_plan` 不是修饰：它声明返回物是一张计划，调用方
//      读到的每个键都要自己去执行，本服务器永远不代劳。
//   2. 即便注册了，它们也只返回计划（JSON），不 spawn 进程、不分配端口、不写文件、不发
//      SIGTERM。真正的启动/停止在应用自己的命令里（`src-tauri/src/lib.rs:2679` 的
//      `launch_repo`、`:702` 的 `stop_process`），那些命令带 job object、进程树终止、
//      端口健康检查与活动日志；一个外部 stdio 进程复刻不了，也不该复刻。
//   3. 因此这两个工具的真实语义是「把应用会怎么做讲清楚」，annotations 按真实行为写
//      （readOnlyHint 确实是 true），而 `--allow-mutations` 这道闸管的是**可发现性**，
//      不是能力。这是刻意的区分，规范自己也说客户端 MUST 把不可信服务器给的 annotations
//      当作不可信（`server/tools` §Tool 后面的 Warning）。
//   4. 未知工具与被闸门挡掉的工具回答同一个 -32602（`Unknown tool: <name>`），服务器不会
//      去告诉调用方「这个工具存在，只是你没开权限」。
//
// 副作用面（默认模式下）：只有读。写 stdout/stderr、读容器根一层目录与 marker 文件、
// 读 devhub-config.json 的 `projectRoot` 字段。token 字段永不输出——`config_path()` 指向的
// 那个文件里存着 GitHub token（`src-tauri/src/path_guard.rs:105` 的守卫就是为了不让
// webview 用 `read_text_file` 把它读出来），所以本脚本读它时只取 projectRoot 一个键。
//
// ── 容器根的解析，必须和应用一致 ────────────────────────────────────────────────────
//
// 优先级：`--root` > 环境变量 `DEVHUB_PROJECT_ROOT` > 应用配置文件里的 `projectRoot` > 推导默认值。
// 前两级照抄 `src-tauri/src/lib.rs:163` 的 `project_root()`（它就是 env 先于存档配置）；
// 配置文件真名 `devhub-config.json` 来自 `src-tauri/src/lib.rs:4703` 的 `config_path()`，
// 开发态落在 `src-tauri/`（`.gitignore` 已忽略），打包态落在 exe 同级目录 —— 候选列表与
// `vite.config.ts:55` 的 `configuredContainers()` 用的是同一组相对路径，不是新发明。
// `--root` 排在最前，是为了让测试能指向一个夹具根而不必改任何机器状态。

import { createInterface } from "node:readline";
import { existsSync, lstatSync, readFileSync, readdirSync, statSync, unwatchFile, watchFile } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * The checkout this script lives in. Never `process.cwd()`: an MCP client launches the
 * server with whatever working directory it feels like, and every checker in this repo
 * already anchors on its own file for the reason round 15 (d7) recorded.
 */
const REPO_ROOT = resolve(HERE, "..");

/** The only revision this server claims; see the header citations. */
const PROTOCOL_REVISION = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS = [PROTOCOL_REVISION];

/** JSON-RPC 2.0 predefined codes (the MCP `basic/index` page carries no table — see header). */
const ERR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
};

const SERVER_INFO = {
  name: "devhub-container",
  title: "DevHub 项目容器",
  version: appVersion(),
};

/**
 * Reserved container directories, mirrored from `is_reserved_dir()` in
 * `src-tauri/src/downloader.rs:891`. Re-implemented rather than imported because the
 * real one is Rust; if the two drift, this server starts listing DevHub's own
 * bookkeeping folders as if they were projects.
 */
const RESERVED_ROOT_DIRS = ["cache", "venvs", "runtime", "_worktrees", "_bootstrap"];

const state = {
  initialized: false,
  protocolVersion: null,
  clientInfo: null,
  root: null,
  rootSource: "unset",
};

function appVersion() {
  try {
    return JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version ?? "0.0.0";
  } catch {
    // A missing package.json is not a reason to refuse a handshake; the version field
    // is informational (`serverInfo`) and the spec does not require it to be real.
    return "0.0.0";
  }
}

/** Transport rule: stdout carries MCP messages only, so every diagnostic goes here. */
function log(text) {
  process.stderr.write(`[mcp-devhub] ${text}\n`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * `--root <dir>` / `--root=<dir>`, `--allow-mutations`, `-h`.
 *
 * An unrecognised argument is fatal, matching `check-docs.mjs`'s documented rule that a
 * checker which ignores a flag it does not understand is a checker that quietly stopped
 * enforcing the thing the flag was for. The usage text goes to stderr: printing it on
 * stdout would be a non-MCP byte on the message channel.
 */
function parseArgv(argv) {
  const out = { root: null, help: false, allowMutations: false, unknown: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        out.unknown.push("--root (missing value)");
      } else {
        out.root = resolve(next);
        i += 1;
      }
    } else if (arg.startsWith("--root=")) {
      out.root = resolve(arg.slice("--root=".length));
    } else if (arg === "--allow-mutations") {
      out.allowMutations = true;
    } else if (arg === "-h" || arg === "--help") {
      out.help = true;
    } else {
      out.unknown.push(arg);
    }
  }
  return out;
}

const USAGE = [
  "usage: node scripts/mcp-devhub.mjs [--root <dir>] [--allow-mutations]",
  "",
  "  --root            项目容器根目录，覆盖一切推导（测试与多容器场景用）",
  "  --allow-mutations 注册 devhub_launch_plan / devhub_stop_plan（只返回计划，不执行）",
  "",
  "传输是 stdio：stdout 只走 MCP 消息，所有诊断走 stderr。",
].join("\n");

// ---------------------------------------------------------------------------
// Container root + repository discovery
// ---------------------------------------------------------------------------

/**
 * Where the app keeps `devhub-config.json`.
 *
 * `config_path()` (`src-tauri/src/lib.rs:4703`) resolves it beside the runtime dir, i.e.
 * next to the executable; a development run therefore lands it in `src-tauri/`, which is
 * exactly why `.gitignore` carries `src-tauri/devhub-config.json`. A Node script has no
 * executable directory to start from, so the two candidate paths `vite.config.ts` already
 * uses are the honest approximation of "the app's own config file".
 */
function configFileCandidates() {
  return ["src-tauri/devhub-config.json", "devhub-config.json"].map((rel) => join(REPO_ROOT, rel));
}

/** The `projectRoot` string saved by the app, or null. A corrupt config is null, not a crash. */
function readSavedProjectRoot() {
  for (const file of configFileCandidates()) {
    if (!existsSync(file)) continue;
    try {
      const cfg = JSON.parse(readFileSync(file, "utf8"));
      const saved = typeof cfg.projectRoot === "string" ? cfg.projectRoot.trim() : "";
      if (saved) return { root: resolve(saved), file };
    } catch (error) {
      log(`config ${file} unreadable (${error.message}) — falling back to the env override`);
    }
    // Same `break` semantics as configuredContainers(): the first file that exists wins,
    // so a stale `devhub-config.json` at the repo root cannot shadow the real one.
    return null;
  }
  return null;
}

/**
 * `default_project_root()`'s development branch (`src-tauri/src/lib.rs:120`): when the
 * exe lives in `target\debug` the container is `CARGO_MANIFEST_DIR\项目`, i.e.
 * `<checkout>/src-tauri/项目`. The packaged branches (install dir, then
 * `%LOCALAPPDATA%\DevHub\项目`) are deliberately not reproduced: this script is not the
 * app and has no executable directory of its own, so guessing "the install dir" would
 * invent a container. If that default is wrong for a real setup, `--root`/env is the
 * documented answer, and `rootSource: "default"` in the stderr banner says so out loud.
 */
function defaultProjectRoot() {
  return join(REPO_ROOT, "src-tauri", "项目");
}

function resolveContainerRoot(cliRoot) {
  if (cliRoot) return { root: cliRoot, source: "--root" };
  const env = process.env.DEVHUB_PROJECT_ROOT;
  if (env && env.trim()) return { root: resolve(env.trim()), source: "env DEVHUB_PROJECT_ROOT" };
  const saved = readSavedProjectRoot();
  if (saved) return { root: saved.root, source: `config ${saved.file}` };
  return { root: defaultProjectRoot(), source: "default <checkout>/src-tauri/项目" };
}

function isReservedDirName(name) {
  return name.startsWith(".") || RESERVED_ROOT_DIRS.some((r) => r.toLowerCase() === name.toLowerCase());
}

/**
 * The marker file's four real states, named because collapsing them is a bug the app
 * already paid for once (`src-tauri/src/downloader.rs`, the `MarkerFile` enum: an
 * unreadable marker and an absent marker both came back as `None`, and the writer then
 * rebuilt a marker from defaults — resetting the port block that must never drift).
 * A read-only server must not repeat that by printing "no marker" for a locked file.
 */
function readMarker(repoDir) {
  const path = join(repoDir, ".devhub.json");
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { state: "absent", marker: null, path };
    return { state: "unreadable", marker: null, path, detail: error.message };
  }
  try {
    return { state: "valid", marker: JSON.parse(text), path };
  } catch (error) {
    return { state: "corrupt", marker: null, path, detail: error.message };
  }
}

/** `normalize_slug()` (`src-tauri/src/downloader.rs`): trim, trim slashes, backslash to slash. */
function normalizeSlug(value) {
  return String(value ?? "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

/**
 * `split_slug()` (`src-tauri/src/downloader.rs:1043`): `owner/repo` gains the implicit
 * host, anything longer takes the last three components.
 */
function splitSlug(slug) {
  const parts = normalizeSlug(slug).split("/").filter((p) => p !== "");
  if (parts.length === 2) return { host: "github.com", owner: parts[0], repo: parts[1] };
  if (parts.length >= 3) {
    return { host: parts[parts.length - 3], owner: parts[parts.length - 2], repo: parts[parts.length - 1] };
  }
  return null;
}

/**
 * Identity for one directory, in the app's precedence:
 * marker slug → current `<repo>_<owner>` name (`repo_ref_of_marker()`,
 * `src-tauri/src/downloader.rs:1076`).
 *
 * The legacy `code/<host>/<owner>/<repo>` branch is reachable only through the legacy
 * layout, which is deeper than the one level this walk covers — recorded as a known gap
 * rather than silently dropped, and reported in `devhub_list_repos`'s `warnings`.
 */
function identify(dirName, marker) {
  const fromMarker = marker ? splitSlug(marker.slug) : null;
  if (fromMarker) return { ...fromMarker, source: "marker" };
  const at = dirName.lastIndexOf("_");
  if (at > 0 && at < dirName.length - 1) {
    return {
      host: "github.com",
      owner: dirName.slice(at + 1),
      repo: dirName.slice(0, at),
      source: "dir-name",
    };
  }
  return null;
}

/**
 * One level under the container root, keeping only directories that carry
 * `.devhub.json`.
 *
 * Deliberately shallower than the app's own walk (`collect_repos()` descends to depth 5
 * and reports anything with `.git`): the marker is the claim of ownership, one level is
 * the current layout, and a read-only server that starts crawling a container which may
 * also hold a build tree is the 86-second walk the app already measured and pruned.
 */
function discoverRepositories(containerRoot) {
  if (!existsSync(containerRoot)) {
    return { repos: [], warnings: [`容器根目录不存在：${containerRoot}`] };
  }
  let entries;
  try {
    entries = readdirSync(containerRoot, { withFileTypes: true });
  } catch (error) {
    return { repos: [], warnings: [`容器根目录读不了：${error.message}`] };
  }
  const repos = [];
  const warnings = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (isReservedDirName(entry.name)) continue;
    const dir = join(containerRoot, entry.name);
    if (!existsSync(join(dir, ".devhub.json"))) continue;
    const marker = readMarker(dir);
    if (marker.state === "unreadable" || marker.state === "corrupt") {
      warnings.push(`${entry.name}: .devhub.json ${marker.state}（${marker.detail}）— 未解析，不当作空标记`);
    }
    const identity = identify(entry.name, marker.state === "valid" ? marker.marker : null);
    repos.push({
      dirName: entry.name,
      relPath: entry.name,
      absPath: dir,
      markerPath: marker.path,
      markerState: marker.state,
      hasGit: existsSync(join(dir, ".git")),
      identity,
      marker: marker.state === "valid" ? marker.marker : null,
    });
  }
  repos.sort((a, b) => a.dirName.localeCompare(b.dirName, "en"));
  return { repos, warnings };
}

// ---------------------------------------------------------------------------
// 只读工具
// ---------------------------------------------------------------------------

/**
 * Thrown by a tool for a *params* problem, which the spec routes as a JSON-RPC error
 * (`-32602 Invalid params`), as opposed to an execution failure, which it routes as a
 * result with `isError: true` so the model can read the reason.
 */
class ProtocolError extends Error {}

/**
 * The shape `server/tools` prescribes for a call result: text content for the model plus
 * `structuredContent` for programmatic clients. `JSON.stringify(_, null, 2)` inserts real
 * newlines *inside a JSON string value*, which the serialiser escapes as `\n`; the framed
 * message on stdout still contains none.
 */
function jsonResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: false,
  };
}

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
  idempotentHint: true,
};

/**
 * Re-walk the container on every call rather than serving the startup snapshot.
 *
 * A one-level `readdir` plus one marker read per directory is what the walk costs, and
 * the alternative is an agent being told a repository that was cloned two seconds ago is
 * not there. The app pays the opposite trade (`repo_index` caches, because its walk is
 * depth-5 over a container that may hold a build tree); at this depth the cache would buy
 * nothing and would go stale the moment the wall cloned something.
 */
function scanFresh() {
  const { repos, warnings } = discoverRepositories(state.root);
  return { repos, warnings };
}

/** `Vec<(String, u16)>` serialises as `[["http",20000]]`; keep the pairs but name the halves. */
function markerServices(marker) {
  const raw = Array.isArray(marker.services) ? marker.services : [];
  return raw
    .map((pair) => (Array.isArray(pair) ? { name: pair[0], port: pair[1] } : { name: pair?.name, port: pair?.port }))
    .filter((s) => typeof s.name === "string" && s.name !== "");
}

/** The marker fields the wall and 项目设置 read, flattened off `Marker` (`src-tauri/src/downloader.rs:740`). */
function markerFields(marker) {
  return {
    url: marker.url ?? "",
    clonedAt: marker.clonedAt ?? "",
    portBase: typeof marker.portBase === "number" ? marker.portBase : null,
    services: markerServices(marker),
    pythonVersion: marker.pythonVersion ?? null,
    venvPath: marker.venvPath ?? null,
    pythonChoice: marker.pythonChoice ?? null,
    stepwise: marker.stepwise ?? null,
    terminalChoice: marker.terminalChoice ?? null,
    ideChoice: marker.ideChoice ?? null,
    lastPull: marker.lastPull ?? null,
    launch: marker.launch ?? null,
  };
}

const ENVIRONMENT_MARKERS = {
  // `detect_environments()` (`src-tauri/src/lib.rs:2227`) decides what a repository needs
  // from exactly these filenames; the lists are copied, not invented, so the answer this
  // server gives and the answer the 启动面板 gives cannot diverge.
  python: ["requirements.txt", "pyproject.toml", "manage.py", "app.py", "uv.lock", "Pipfile", "poetry.lock"],
  node: ["package.json"],
  docker: ["docker-compose.yml", "compose.yaml", "Dockerfile"],
};

function environmentHints(repoDir) {
  const out = {};
  for (const [kind, names] of Object.entries(ENVIRONMENT_MARKERS)) {
    out[kind] = names.filter((n) => existsSync(join(repoDir, n)));
  }
  return out;
}

/**
 * `<项目根>\_worktrees` is `WORKTREES_DIR` (`src-tauri/src/gitwt.rs:51`), one level deep,
 * named after the slug. Re-deriving that naming is `gitwt.rs`'s job, so this only reports
 * the container's state plus whatever names happen to contain the repository or owner —
 * labelled a hint so a client cannot read it as the authoritative worktree list.
 */
function worktreeHint(containerRoot, record) {
  const container = join(containerRoot, "_worktrees");
  if (!existsSync(container)) return { container, exists: false, candidates: [] };
  let names = [];
  try {
    names = readdirSync(container);
  } catch {
    return { container, exists: true, candidates: [], unreadable: true };
  }
  const keys = [record.repo, record.owner].filter((k) => typeof k === "string" && k.length > 2);
  return {
    container,
    exists: true,
    candidates: names.filter((n) => keys.some((k) => n.toLowerCase().includes(k.toLowerCase()))),
  };
}

function toRecord(entry, options) {
  const detail = options?.detail === true;
  const identity = entry.identity;
  const marker = entry.marker ?? {};
  const record = {
    name: entry.dirName,
    slug: identity ? `${identity.host}/${identity.owner}/${identity.repo}` : null,
    host: identity?.host ?? null,
    owner: identity?.owner ?? null,
    repo: identity?.repo ?? null,
    identitySource: identity?.source ?? "unidentified",
    path: entry.absPath,
    markerState: entry.markerState,
    hasGit: entry.hasGit,
  };
  if (entry.markerState === "valid") {
    Object.assign(record, markerFields(marker));
  }
  if (detail) {
    record.environments = environmentHints(entry.absPath);
    record.worktrees = worktreeHint(state.root, record);
    record.venvPathExists = typeof record.venvPath === "string" && record.venvPath !== ""
      ? existsSync(record.venvPath)
      : null;
    record.markerPath = entry.markerPath;
    record.rawSlug = marker.slug ?? null;
  }
  return record;
}

/**
 * `slug_score()` (`src-tauri/src/downloader.rs`): 0 exact, 1 suffix (`owner/repo` against
 * `host/owner/repo`), 2 bare repository name, null no match. Same precedence, so a name
 * that resolves in the wall resolves here and vice versa.
 */
function slugScore(want, record) {
  const norm = normalizeSlug(want).toLowerCase();
  if (norm === "") return null;
  const names = [record.slug, record.rawSlug, record.name, `${record.owner}/${record.repo}`];
  const lowered = names.filter((n) => typeof n === "string" && n !== "").map((n) => normalizeSlug(n).toLowerCase());
  // `record.repo` is deliberately NOT in the score-0 set: in the app's table a bare
  // repository name is score 2, not an exact match, and keeping that distinction is what
  // makes "two repositories both called utils" report as ambiguous here too.
  if (lowered.includes(norm)) return 0;
  if (lowered.some((n) => n.endsWith(`/${norm}`))) return 1;
  if (!norm.includes("/") && record.repo && record.repo.toLowerCase() === norm) return 2;
  return null;
}

/** Best match, or every candidate when the spelling is ambiguous — never a coin toss. */
function resolveOne(query) {
  const records = scanFresh().repos.map((entry) => toRecord(entry, { detail: true }));
  const scored = [];
  for (const record of records) {
    const score = slugScore(query, record);
    if (score !== null) scored.push({ score, record });
  }
  scored.sort((a, b) => a.score - b.score || a.record.name.localeCompare(b.record.name, "en"));
  return scored;
}

/** Shared by the two tools that need exactly one repository. */
function requireOne(query, toolName) {
  if (typeof query !== "string" || query.trim() === "") {
    throw new ProtocolError(`${toolName}: 参数 ${JSON.stringify(query)} 不是可用的仓库标识`);
  }
  const scored = resolveOne(query);
  if (scored.length === 0) {
    throw new ProtocolError(`未找到仓库：${query}（容器根 ${state.root}）`);
  }
  const best = scored[0];
  const tied = scored.filter((s) => s.score === best.score).map((s) => s.record.name);
  return { record: best.record, ambiguous: tied.length > 1 ? tied : null };
}

// ── README 探测：候选名单与字节上限都镜像应用侧，不新发明 ─────────────────────────
//
// 候选名单与顺序抄 `README_CANDIDATES`（src/lib/readme.ts:30）——那是 GitHub 自己的拼写
// 顺序，本地预览对话框与语料层的 README 探测用的是同一份；这里出现第五种拼写就是第三个
// 真相源。上限抄 `README_MAX_BYTES`（src/lib/readme.ts:38）的 256 KB：对话框渲染多少、
// 索引吃多少、这个服务器回多少，三者对「README 在哪结束」的答案必须一致。
const README_CANDIDATES = ["README.md", "readme.md", "README.markdown", "README"];
const README_MAX_BYTES = 256 * 1024;

/**
 * The first README candidate that exists in `repoDir`, read as bytes and cut at
 * the cap. Four states, named after `readMarker`'s precedent: a README that is a
 * directory (or otherwise locked) is `unreadable`, never collapsed into
 * `absent` — the same mistake `MarkerFile` paid for once.
 *
 * The cut mirrors `capUtf8` (`src/lib/readme.ts:48`): back off to the last
 * complete UTF-8 sequence so a multi-byte character straddling the limit is
 * dropped whole instead of decoded as U+FFFD. Reading as a Buffer (not a
 * decoded string) is what makes "a hostile 4 MB file never fully decoded" true
 * here, where the app gets it for free from `read_text_file`'s size check.
 *
 * On a case-insensitive volume (every Windows checkout) the first spelling the
 * filesystem can case-fold to wins — `README.md` matches a lone `readme.md`.
 * That is not a divergence from the app: its dialog probes the same list through
 * the same OS, so both sides miss the fallback for the same reason.
 */
function readRepoReadme(repoDir) {
  for (const name of README_CANDIDATES) {
    const path = join(repoDir, name);
    if (!existsSync(path)) continue;
    let raw;
    try {
      raw = readFileSync(path);
    } catch (error) {
      return { state: "unreadable", path, detail: error.message };
    }
    const totalBytes = raw.length;
    let end = Math.min(totalBytes, README_MAX_BYTES);
    while (end > 0 && ((raw[end] ?? 0) & 0xc0) === 0x80) end -= 1;
    const text = new TextDecoder().decode(raw.subarray(0, end));
    return {
      state: "valid",
      path,
      name,
      totalBytes,
      truncated: totalBytes > README_MAX_BYTES,
      empty: text === "",
      text,
    };
  }
  return { state: "absent", path: null };
}

// ── README 标题大纲：行扫描版，不引入第二个 Markdown 实现 ─────────────────────────
//
// 应用侧的 `readmeHeadingsOf`（src/lib/corpus.ts:117）走完整 Markdown 解析器把标题灌进
// 本地索引；本服务器零依赖（不能 import TS 模块，理由见文件头），所以这里用行扫描近似：
// ATX 标题（`#`..`######`）+ 围栏代码块跳过 + 收尾井号剥除。与解析器版的已知差异写在
// `readmeHeadingsScan` 的注释里——差异是记录下来的，不是暗的。
// 上限抄 `LOCAL_README_HEADING_LIMIT`（src/lib/local-index.ts:108）的 40：索引吃多少条、
// 这个服务器回多少条，必须是同一个数，否则「大纲在哪儿变短」有两个答案。
const README_HEADING_LIMIT = 40;

/**
 * ATX headings of `text`, in document order, capped — a line scan, not a parse.
 *
 * Deliberate differences from the app's parser-based `readmeHeadingsOf`:
 * setext headings (`Title\n=====`) are not recognised, and a heading inside a
 * blockquote (`> ## like this`) is not descended into — both are rare in real
 * READMEs, and a second full Markdown implementation inside a stdio server is a
 * second thing to keep in sync. Inline markup (`**bold**`, links) is kept as
 * written rather than flattened to plain words. Fenced code blocks (``` or ~~~)
 * are skipped so a shell comment that starts with `#` never becomes a heading.
 * `truncated` is true only when a further heading existed past the cap — a file
 * with exactly 40 headings is not "truncated".
 */
function readmeHeadingsScan(text) {
  const headings = [];
  let inFence = false;
  let truncated = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (!m) continue;
    const body = m[2].replace(/\s+#+\s*$/, "").trim();
    if (body === "") continue;
    if (headings.length >= README_HEADING_LIMIT) {
      truncated = true;
      break;
    }
    headings.push({ level: m[1].length, text: body });
  }
  return { headings, truncated };
}

const SLUG_PARAM = {
  type: "string",
  description: "仓库标识：host/owner/repo、owner/repo、裸仓库名或目录名（<repo>_<owner>）都可以。",
};

/**
 * Directory names the bounded tree walk never descends into or returns. Mirrors
 * `IGNORE_DIRS` in `src-tauri/src/searchgrep.rs` (the app's own content search) and adds
 * the container bookkeeping names; kept as a set so a name encountered at any depth is
 * skipped and reported once.
 */
const REPO_WALK_IGNORED = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "__pycache__",
  ".idea",
  ".vscode",
  ".worktrees",
]);

/**
 * A bounded, read-only tree walk. Returns files and directories with repository-relative
 * POSIX paths, never follows symlinks (a junction pointing outside the repository would
 * otherwise leak a listing of another tree), and stops at `maxEntries`. Unreadable
 * directories are reported rather than thrown: one locked folder must not turn a
 * repository overview into a failed tool call.
 */
function walkRepoFiles(root, maxDepth, maxEntries) {
  const entries = [];
  const unreadable = [];
  const ignored = new Set();
  let truncated = false;
  let depthLimitReached = false;

  const walk = (dir, rel, depth) => {
    if (truncated) return;
    let names;
    try {
      names = readdirSync(dir, { withFileTypes: true })
        .map((d) => d.name)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    } catch (error) {
      unreadable.push({ path: rel === "" ? "." : rel, detail: error.message });
      return;
    }
    for (const name of names) {
      if (entries.length >= maxEntries) {
        truncated = true;
        return;
      }
      const relPath = rel === "" ? name : `${rel}/${name}`;
      const abs = join(dir, name);
      let st;
      try {
        st = lstatSync(abs);
      } catch (error) {
        unreadable.push({ path: relPath, detail: error.message });
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (REPO_WALK_IGNORED.has(name)) {
          ignored.add(name);
          continue;
        }
        entries.push({ path: relPath, kind: "dir", size: null, depth });
        if (depth < maxDepth) walk(abs, relPath, depth + 1);
        else depthLimitReached = true;
      } else if (st.isFile()) {
        entries.push({ path: relPath, kind: "file", size: st.size, depth });
      }
    }
  };

  walk(root, "", 1);
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    entries,
    truncated,
    depthLimitReached,
    unreadable,
    ignored: [...ignored].sort(),
  };
}

/**
 * One repository's health, from facts this server can see without spawning the app:
 * marker readability, git presence, README readability, recorded-vs-actual venv, and
 * whether a launch plan was ever confirmed. `issues` are stable codes; `detail` is prose
 * for a human. `readReadme` is false in the aggregate tool so a 40-repo summary does not
 * read 40 × 256 KB bodies just to answer "is there a README".
 */
function repoHealthOf(record, options = {}) {
  const issues = [];
  const readmeState = options.readReadme === false
    ? (README_CANDIDATES.some((name) => existsSync(join(record.path, name))) ? "present" : "absent")
    : readRepoReadme(record.path).state;
  if (record.markerState !== "valid") {
    issues.push({ code: "marker_invalid", detail: `.devhub.json 状态为 ${record.markerState}` });
  }
  if (!record.hasGit) issues.push({ code: "no_git", detail: "目录里没有 .git（压缩包下载或手工复制）" });
  if (record.venvPathExists === false) {
    issues.push({ code: "venv_missing", detail: `记录的 venv 路径不存在：${record.venvPath}` });
  }
  if (!record.launch) issues.push({ code: "no_launch", detail: "marker 里没有已确认的启动配置" });
  if (readmeState === "absent") issues.push({ code: "no_readme", detail: "没有找到 README" });
  if (readmeState === "unreadable") issues.push({ code: "readme_unreadable", detail: "README 存在但读不出" });

  const verdict =
    record.markerState !== "valid" ? "unusable" : issues.length ? "attention" : "ok";
  return {
    repository: record.name,
    slug: record.slug,
    path: record.path,
    verdict,
    issues,
    readmeState,
    facts: {
      hasGit: record.hasGit,
      hasReadme: readmeState === "present" || readmeState === "valid",
      markerState: record.markerState,
      hasLaunch: Boolean(record.launch),
      venvPathExists: record.venvPathExists ?? null,
      environments: record.environments,
    },
  };
}

const READ_ONLY_TOOLS = [
  {
    name: "devhub_list_repos",
    title: "列出 DevHub 容器中的仓库",
    description:
      "列出项目容器根目录下一层、携带 .devhub.json 标记的目录，每个目录给出 slug、路径、端口块与 venv 位置。只读，不写入、不启动进程。",
    inputSchema: {
      type: "object",
      properties: {
        includeMarkerFields: {
          type: "boolean",
          description: "为 false 时只返回目录身份，省略端口/环境等标记字段。默认 true。",
        },
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
    call: (args) => {
      const lean = args?.includeMarkerFields === false;
      const { repos, warnings } = scanFresh();
      const records = repos.map((entry) => toRecord(entry, { detail: !lean }));
      return jsonResult({
        containerRoot: state.root,
        rootSource: state.rootSource,
        count: records.length,
        scannedAt: new Date().toISOString(),
        repositories: records,
        // The gaps are reported, not hidden: a corrupt marker is a fact about the
        // container, and the legacy `code/<host>/<owner>/<repo>` layout is invisible to a
        // one-level walk.
        warnings: [
          ...warnings,
          "扫描深度为容器根目录一层（应用的 collect_repos 走到 5 层）；遗留 code/<host>/<owner>/<repo> 布局不会被列出。",
        ],
      });
    },
  },
  {
    name: "devhub_repo_detail",
    title: "单个仓库详情",
    description:
      "按名称解析一个仓库，返回身份、端口块、venv、已确认的启动配置、环境线索与 worktree 容器状态。名称有歧义时返回全部候选而不猜。只读。",
    inputSchema: {
      type: "object",
      properties: { slug: SLUG_PARAM },
      required: ["slug"],
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
    call: (args) => {
      const found = requireOne(args?.slug, "devhub_repo_detail");
      return jsonResult({
        containerRoot: state.root,
        matched: found.record,
        ambiguousDirectories: found.ambiguous,
        candidates: resolveOne(args.slug).slice(0, 10).map((s) => ({ score: s.score, name: s.record.name })),
      });
    },
  },
  {
    name: "devhub_repo_marker",
    title: "读取 .devhub.json 原文",
    description:
      "返回一个仓库的 .devhub.json 原文与解析状态（absent/valid/unreadable/corrupt）。端口块与 venv 的唯一权威来源就是这个文件，所以这里给原文而不是摘要。只读，绝不写回。",
    inputSchema: {
      type: "object",
      properties: { slug: SLUG_PARAM },
      required: ["slug"],
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
    call: (args) => {
      const found = requireOne(args?.slug, "devhub_repo_marker");
      const raw = readMarker(found.record.path);
      let text = null;
      if (raw.state === "valid") {
        try {
          text = readFileSync(raw.path, "utf8");
        } catch (error) {
          text = null;
          raw.state = "unreadable";
          raw.detail = error.message;
        }
      }
      return jsonResult({
        repository: found.record.name,
        path: found.record.path,
        markerPath: raw.path,
        markerState: raw.state,
        detail: raw.detail ?? null,
        rawText: text,
        parsed: raw.state === "valid" ? raw.marker : null,
        ambiguousDirectories: found.ambiguous,
      });
    },
  },
  {
    name: "devhub_find_by_name",
    title: "按名称模糊查找仓库",
    description:
      "在容器里按名称查找仓库，按应用的 slug_score 优先级排序（0 精确、1 后缀、2 裸仓库名）。返回命中列表与目录名，不返回完整标记。只读。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "要查找的名字，支持 slug / owner/repo / 裸仓库名 / 目录名。" },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "最多返回多少条，默认 10。" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
    call: (args) => {
      if (typeof args?.query !== "string" || args.query.trim() === "") {
        throw new ProtocolError(`devhub_find_by_name: query 必须是非空字符串，收到 ${JSON.stringify(args?.query)}`);
      }
      const limit = Number.isInteger(args.limit) ? Math.min(Math.max(args.limit, 1), 50) : 10;
      const scored = resolveOne(args.query);
      return jsonResult({
        containerRoot: state.root,
        query: args.query,
        totalMatches: scored.length,
        matches: scored.slice(0, limit).map((s) => ({
          score: s.score,
          name: s.record.name,
          slug: s.record.slug,
          path: s.record.path,
          markerState: s.record.markerState,
        })),
        truncated: scored.length > limit,
      });
    },
  },
  {
    name: "devhub_repo_health",
    title: "仓库健康摘要",
    description:
      "按 slug 解析一个仓库，汇总只读健康事实（marker 状态、git、README、记录的 venv 是否存在、是否确认过启动配置）并给出 verdict ok/attention/unusable 与稳定的 issue code。只读，不启动、不写入、不发网络请求。",
    inputSchema: {
      type: "object",
      properties: { slug: SLUG_PARAM },
      required: ["slug"],
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
    call: (args) => {
      const found = requireOne(args?.slug, "devhub_repo_health");
      return jsonResult({
        ...repoHealthOf(found.record),
        ambiguousDirectories: found.ambiguous,
      });
    },
  },
  {
    name: "devhub_container_health",
    title: "容器健康总览",
    description:
      "扫描容器根一层，按 verdict 汇总所有仓库的只读健康结论；不读取 README 正文，只判断是否存在。用于一次看清哪些仓库缺 git、缺启动配置或 marker 损坏。只读。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READ_ONLY_ANNOTATIONS,
    call: () => {
      const { repos, warnings } = scanFresh();
      const rows = repos.map((entry) => repoHealthOf(toRecord(entry, { detail: true }), { readReadme: false }));
      const byVerdict = { ok: 0, attention: 0, unusable: 0 };
      const issueCounts = {};
      for (const row of rows) {
        byVerdict[row.verdict] += 1;
        for (const issue of row.issues) {
          issueCounts[issue.code] = (issueCounts[issue.code] ?? 0) + 1;
        }
      }
      return jsonResult({
        containerRoot: state.root,
        repoCount: rows.length,
        byVerdict,
        issueCounts,
        repositories: rows,
        warnings,
      });
    },
  },
  {
    name: "devhub_repo_readme",
    title: "读取仓库本地 README",
    description:
      "在仓库根按应用同一份候选名单（README.md / readme.md / README.markdown / README）找 README 并返回文本，256 KB 字节上限、超出截断并标记 truncated。没有 README 不是错误：state 为 absent。只读，不写入、不发网络请求。",
    inputSchema: {
      type: "object",
      properties: { slug: SLUG_PARAM },
      required: ["slug"],
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
    call: (args) => {
      const found = requireOne(args?.slug, "devhub_repo_readme");
      const readme = readRepoReadme(found.record.path);
      return jsonResult({
        repository: found.record.name,
        path: found.record.path,
        // valid / absent / unreadable —— 与 devhub_repo_marker 的状态语义一致：
        // 同名目录或被锁住的文件报 unreadable，绝不并进 absent。
        state: readme.state,
        readmePath: readme.path ?? null,
        candidates: [...README_CANDIDATES],
        totalBytes: readme.totalBytes ?? null,
        truncated: readme.truncated ?? false,
        empty: readme.empty ?? false,
        text: readme.state === "valid" ? readme.text : null,
        detail: readme.detail ?? null,
        ambiguousDirectories: found.ambiguous,
      });
    },
  },
  {
    name: "devhub_repo_headings",
    title: "README 标题大纲",
    description:
      "返回仓库本地 README 的标题大纲（#..######，跳过围栏代码块，最多 40 条，超出 truncated:true），每条给 level 与原文文本。不返回正文——大纲供 agent 定位章节，正文用 devhub_repo_readme。只读。",
    inputSchema: {
      type: "object",
      properties: { slug: SLUG_PARAM },
      required: ["slug"],
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
    call: (args) => {
      const found = requireOne(args?.slug, "devhub_repo_headings");
      const readme = readRepoReadme(found.record.path);
      if (readme.state !== "valid") {
        // absent / unreadable are answers, not failures: an agent asking for an
        // outline of a repository that has no README gets the same three-state
        // verdict the readme tool gives, with an empty outline.
        return jsonResult({
          repository: found.record.name,
          path: found.record.path,
          state: readme.state,
          readmePath: null,
          detail: readme.detail ?? null,
          headingLimit: README_HEADING_LIMIT,
          headings: [],
          count: 0,
          truncated: false,
          byteCapped: false,
          ambiguousDirectories: found.ambiguous,
        });
      }
      const scan = readmeHeadingsScan(readme.text);
      return jsonResult({
        repository: found.record.name,
        path: found.record.path,
        state: "valid",
        readmePath: readme.path,
        totalBytes: readme.totalBytes,
        // byteCapped: the source was cut at 256 KB before scanning, so headings
        // living past that cut are invisible here — stated, not silently dropped.
        byteCapped: readme.truncated,
        headingLimit: README_HEADING_LIMIT,
        headings: scan.headings,
        count: scan.headings.length,
        truncated: scan.truncated,
        ambiguousDirectories: found.ambiguous,
      });
    },
  },
  {
    name: "devhub_repo_files",
    title: "列出仓库文件（有界只读）",
    description:
      "按仓库根返回一个有界的文件/目录清单：默认深度 4、最多 200 项，跳过 .git / node_modules / target / dist 等构建与依赖目录，不跟随符号链接。用于在 README 之外定位文件；不返回文件内容。只读。",
    inputSchema: {
      type: "object",
      properties: {
        slug: SLUG_PARAM,
        maxDepth: {
          type: "integer",
          minimum: 1,
          maximum: 8,
          description: "相对仓库根的最大深度，默认 4。",
        },
        maxEntries: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          description: "最多返回多少条，默认 200；达到上限时 truncated:true。",
        },
      },
      required: ["slug"],
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
    call: (args) => {
      const found = requireOne(args?.slug, "devhub_repo_files");
      const maxDepth = Number.isInteger(args?.maxDepth) ? args.maxDepth : 4;
      const maxEntries = Number.isInteger(args?.maxEntries) ? args.maxEntries : 200;
      const scan = walkRepoFiles(found.record.path, maxDepth, maxEntries);
      return jsonResult({
        repository: found.record.name,
        path: found.record.path,
        state: "ok",
        maxDepth,
        maxEntries,
        entries: scan.entries,
        count: scan.entries.length,
        truncated: scan.truncated,
        depthLimitReached: scan.depthLimitReached,
        unreadableDirectories: scan.unreadable,
        ignoredDirectories: scan.ignored,
        ambiguousDirectories: found.ambiguous,
      });
    },
  },
];

/**
 * The two mutation-shaped tools. Registered only when `--allow-mutations` was passed, and
 * even then they only *describe* a plan (see the 安全边界 block in the header): every value
 * below is computed from files already on disk, and no branch of this code reaches a
 * `child_process`, a socket, a port allocator or a writer.
 */
const MUTATION_TOOLS = [
  {
    name: "devhub_launch_plan",
    title: "给出启动计划（不执行）",
    description:
      "根据仓库的 .devhub.json 返回 DevHub 会怎样启动它：命令/steps、工作目录、venv、端口与环境线索。只返回计划；不 spawn 进程、不分配端口、不写文件。真正执行请用应用里的 启动（launch_repo）。",
    inputSchema: {
      type: "object",
      properties: { slug: SLUG_PARAM },
      required: ["slug"],
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
    call: (args) => {
      const found = requireOne(args?.slug, "devhub_launch_plan");
      const record = found.record;
      const launch = record.launch ?? null;
      const steps = Array.isArray(launch?.steps) && launch.steps.length > 0
        ? launch.steps
        : launch?.command
          ? [{ name: "单步", command: launch.command, cwd: launch.cwd ?? "", parallel: false }]
          : [];
      return jsonResult({
        containerRoot: state.root,
        repository: record.name,
        path: record.path,
        plan: {
          steps: steps.map((step) => ({
            name: step.name ?? "",
            command: step.command ?? "",
            // `LaunchStep.cwd` is documented as relative to the repository root, but the
            // marker is a hand-editable JSON file: `join(root, "D:\\other")` would produce
            // a path no OS resolves, so an absolute value is taken at face value.
            workingDirectory:
              typeof step.cwd === "string" && isAbsolute(step.cwd) ? step.cwd : join(record.path, step.cwd ?? ""),
            parallel: step.parallel === true,
          })),
          userConfirmed: launch?.userConfirmed === true,
          venv: { recorded: record.venvPath ?? null, exists: record.venvPathExists === true },
          pythonPin: record.pythonChoice ?? null,
          ports: (record.services ?? []).map((s) => ({ service: s.name, port: s.port })),
          stepwise: record.stepwise ?? null,
          terminalChoice: record.terminalChoice ?? null,
          worktrees: record.worktrees,
        },
        // The three facts a plan is useless without: whether the command was ever
        // confirmed, whether a marker exists at all, and whether this server ran anything.
        markerState: record.markerState,
        executed: false,
        ambiguousDirectories: found.ambiguous,
        note:
          launch?.userConfirmed === true
            ? "命令来自标记文件，但本服务器不会执行它；执行是应用侧 launch_repo 的职责。"
            : "标记里没有用户确认过的启动命令，steps 只是把已记录内容原样转述，不构成可直接执行的授权。",
      });
    },
  },
  {
    name: "devhub_stop_plan",
    title: "给出停止提示（不执行）",
    description:
      "返回一个仓库相关的端口与服务，以及应用停止进程时实际会做的事（先走 job object 的 KILL_ON_JOB_CLOSE，没有则回退 taskkill /PID <pid> /T /F）。只返回提示；本服务器不 kill 任何进程，也拿不到 pid。",
    inputSchema: {
      type: "object",
      properties: { slug: SLUG_PARAM },
      required: ["slug"],
      additionalProperties: false,
    },
    annotations: READ_ONLY_ANNOTATIONS,
    call: (args) => {
      const found = requireOne(args?.slug, "devhub_stop_plan");
      const record = found.record;
      return jsonResult({
        repository: record.name,
        path: record.path,
        ports: (record.services ?? []).map((s) => ({ service: s.name, port: s.port })),
        portBase: record.portBase ?? null,
        hint: {
          whyNotPid: "本服务器没有监控表，也不知道哪个进程属于这个仓库：pid 来自应用自己的进程表（stop_process 的入参）。",
          appBehaviour:
            "应用的停止走 taskkill /T /F 或 job object 的 KILL_ON_JOB_CLOSE，且在 child.kill() 之前走，因为只杀 pid 会留下还在监听的 dev server。",
          windowsCommands: [
            "netstat -ano | findstr :<port>   # 先看端口被谁占着",
            "tasklist /FI \"PID eq <pid>\" /T   # 再看它的进程树",
            "taskkill /PID <pid> /T /F        # 终止整棵树（本服务器不会替你执行）",
          ],
        },
        executed: false,
        markerState: record.markerState,
        ambiguousDirectories: found.ambiguous,
      });
    },
  },
];

// ---------------------------------------------------------------------------
// JSON-RPC over stdio
// ---------------------------------------------------------------------------

function send(message) {
  // Embedded newlines are forbidden on the wire, and JSON.stringify only emits them when
  // a payload string carries one — escaped as \n by the serialiser, never a raw byte.
  // The trailing "\n" is the frame delimiter.
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  // `id: null` for a message that never yielded a request ID (a parse failure). MCP
  // forbids null IDs on *requests*, and requires a response to carry the request's ID;
  // when there is no request ID to carry, the base JSON-RPC 2.0 rule this falls back to
  // is "an id member with a value of null". Answering with anything else would invent an
  // ID the client never sent.
  send({ jsonrpc: "2.0", id, error });
}

/**
 * The registry: empty at declaration and filled by `main()`. The mutation-shaped tools go
 * in only when `--allow-mutations` was passed — that is the whole safety boundary, and it
 * is a registration decision rather than a per-call permission check, so a gated tool is
 * invisible to `tools/list` as well as to `tools/call`.
 */
const TOOLS = [];

/**
 * Validate `arguments` against the tool's declared `inputSchema` before any tool code
 * runs. A server that advertises a schema it never checks is advertising a lie: the
 * client's typing, the LLM's tool-use decision and this implementation would otherwise
 * disagree about what `{"limit": "3"}` means. Enforced subset: unknown key, missing
 * required key, and the three types this server actually declares.
 */
function validateArguments(schema, args, toolName) {
  const value = args === undefined || args === null ? {} : args;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError(`${toolName}: arguments 必须是对象，收到 ${JSON.stringify(value)}`);
  }
  const properties = schema?.properties ?? {};
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(properties, key)) {
      throw new ProtocolError(`${toolName}: 未在 inputSchema 声明的参数 "${key}"`);
    }
  }
  for (const required of schema?.required ?? []) {
    if (value[required] === undefined) {
      throw new ProtocolError(`${toolName}: 缺少必需参数 "${required}"`);
    }
  }
  for (const [key, spec] of Object.entries(properties)) {
    const given = value[key];
    if (given === undefined) continue;
    if (spec.type === "string" && typeof given !== "string") {
      throw new ProtocolError(`${toolName}: 参数 "${key}" 应为字符串，收到 ${JSON.stringify(given)}`);
    }
    if (spec.type === "boolean" && typeof given !== "boolean") {
      throw new ProtocolError(`${toolName}: 参数 "${key}" 应为布尔，收到 ${JSON.stringify(given)}`);
    }
    if (spec.type === "integer") {
      if (!Number.isInteger(given)) {
        throw new ProtocolError(`${toolName}: 参数 "${key}" 应为整数，收到 ${JSON.stringify(given)}`);
      }
      if (typeof spec.minimum === "number" && given < spec.minimum) {
        throw new ProtocolError(`${toolName}: 参数 "${key}"=${given} 小于 ${spec.minimum}`);
      }
      if (typeof spec.maximum === "number" && given > spec.maximum) {
        throw new ProtocolError(`${toolName}: 参数 "${key}"=${given} 大于 ${spec.maximum}`);
      }
    }
  }
  return value;
}

/** JSON Schema 2020-12 object with a required-key list; extra keys are allowed. */
function obj(properties, required = []) {
  return { type: "object", properties, required, additionalProperties: true };
}

const STR = { type: "string" };
const INT = { type: "integer" };
const BOOL = { type: "boolean" };
const OBJ = { type: "object" };
const STR_ARR = { type: "array", items: STR };
const OBJ_ARR = { type: "array", items: OBJ };

/**
 * `outputSchema` for every registered tool (2025-06-18 `Tool.outputSchema`, the same
 * field set the current revision keeps). The top-level keys are the ones a programmatic
 * client actually reads; nested records stay `type: object` rather than pinning every
 * field, which would turn a hand-edited `.devhub.json` into a schema violation instead
 * of the `markerState` verdict the tool already reports.
 *
 * `tools/list` attaches these by name; the tools themselves stay unchanged.
 */
const OUTPUT_SCHEMAS = {
  devhub_list_repos: obj(
    {
      containerRoot: STR,
      rootSource: STR,
      count: INT,
      scannedAt: STR,
      repositories: OBJ_ARR,
      warnings: STR_ARR,
    },
    ["containerRoot", "count", "repositories", "warnings"],
  ),
  devhub_repo_detail: obj(
    { containerRoot: STR, matched: OBJ, ambiguousDirectories: STR_ARR, candidates: OBJ_ARR },
    ["containerRoot", "matched"],
  ),
  devhub_repo_marker: obj(
    {
      repository: STR,
      path: STR,
      markerPath: STR,
      markerState: STR,
      detail: { type: ["string", "null"] },
      rawText: { type: ["string", "null"] },
      parsed: { type: ["object", "null"] },
      ambiguousDirectories: STR_ARR,
    },
    ["repository", "path", "markerPath", "markerState"],
  ),
  devhub_find_by_name: obj(
    { containerRoot: STR, query: STR, totalMatches: INT, matches: OBJ_ARR, truncated: BOOL },
    ["containerRoot", "query", "totalMatches", "matches", "truncated"],
  ),
  devhub_repo_health: obj(
    {
      repository: STR,
      slug: { type: ["string", "null"] },
      path: STR,
      verdict: STR,
      issues: OBJ_ARR,
      readmeState: STR,
      facts: OBJ,
      ambiguousDirectories: STR_ARR,
    },
    ["repository", "path", "verdict", "issues", "readmeState", "facts"],
  ),
  devhub_container_health: obj(
    {
      containerRoot: STR,
      repoCount: INT,
      byVerdict: OBJ,
      issueCounts: OBJ,
      repositories: OBJ_ARR,
      warnings: STR_ARR,
    },
    ["containerRoot", "repoCount", "byVerdict", "issueCounts", "repositories"],
  ),
  devhub_repo_readme: obj(
    {
      repository: STR,
      path: STR,
      state: STR,
      readmePath: { type: ["string", "null"] },
      candidates: STR_ARR,
      totalBytes: { type: ["integer", "null"] },
      truncated: BOOL,
      empty: BOOL,
      text: { type: ["string", "null"] },
      detail: { type: ["string", "null"] },
      ambiguousDirectories: STR_ARR,
    },
    ["repository", "path", "state", "truncated"],
  ),
  devhub_repo_headings: obj(
    {
      repository: STR,
      path: STR,
      state: STR,
      readmePath: { type: ["string", "null"] },
      detail: { type: ["string", "null"] },
      headingLimit: INT,
      headings: OBJ_ARR,
      count: INT,
      truncated: BOOL,
      byteCapped: BOOL,
      ambiguousDirectories: STR_ARR,
    },
    ["repository", "path", "state", "headings", "count", "truncated"],
  ),
  devhub_repo_files: obj(
    {
      repository: STR,
      path: STR,
      state: STR,
      maxDepth: INT,
      maxEntries: INT,
      entries: OBJ_ARR,
      count: INT,
      truncated: BOOL,
      depthLimitReached: BOOL,
      unreadableDirectories: OBJ_ARR,
      ignoredDirectories: STR_ARR,
      ambiguousDirectories: STR_ARR,
    },
    ["repository", "path", "state", "entries", "count", "truncated"],
  ),
  devhub_launch_plan: obj(
    { containerRoot: STR, repository: STR, path: STR, plan: OBJ, markerState: STR, executed: BOOL },
    ["containerRoot", "repository", "path", "plan", "markerState", "executed"],
  ),
  devhub_stop_plan: obj(
    { repository: STR, path: STR, ports: OBJ_ARR, executed: BOOL, markerState: STR },
    ["repository", "path", "ports", "executed", "markerState"],
  ),
};

function toolNames() {
  return TOOLS.map((t) => t.name);
}

function findTool(name) {
  return TOOLS.find((t) => t.name === name) ?? null;
}

function handleToolsList(id, params) {
  // This server never emits a `nextCursor`, so any cursor that comes back is either bogus
  // or the client resuming past a complete first page. Answering with the full list again
  // would be an infinite pagination loop, which is the kind of bug only a client hits.
  if (typeof params?.cursor === "string" && params.cursor !== "") {
    sendResult(id, { tools: [] });
    return;
  }
  const limit = Number.isInteger(params?.limit) && params.limit > 0 ? params.limit : Infinity;
  const tools = TOOLS.slice(0, Math.min(TOOLS.length, limit)).map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    ...(OUTPUT_SCHEMAS[t.name] ? { outputSchema: OUTPUT_SCHEMAS[t.name] } : {}),
    annotations: t.annotations,
  }));
  // Fewer tools than any client will paginate over, so nextCursor is never emitted —
  // `capabilities.tools.listChanged` is false for the same reason.
  sendResult(id, { tools });
}

/**
 * Resources are the read-only half of MCP that tools cannot express well: a client can
 * list them, cache them and attach them to a prompt without a tool call. The URI is
 * `devhub://repo/<slug>/readme`; the slug is the same canonical `host/owner/repo` the
 * tools use, encoded with `encodeURIComponent` so its slashes and dots survive a URI
 * parser without being mistaken for path structure.
 */
const RESOURCE_PREFIX = "devhub://repo/";

function resourceUriOf(slug) {
  return `${RESOURCE_PREFIX}${encodeURIComponent(slug)}/readme`;
}

function handleResourcesList(id, params) {
  if (typeof params?.cursor === "string" && params.cursor !== "") {
    sendResult(id, { resources: [] });
    return;
  }
  const { repos } = scanFresh();
  const resources = [];
  for (const entry of repos) {
    const record = toRecord(entry, { detail: false });
    if (!record.slug) continue;
    resources.push({
      uri: resourceUriOf(record.slug),
      name: `${record.slug} README`,
      description: `本地 README（${record.name}）；内容由 devhub_repo_readme 同一条读取路径提供`,
      mimeType: "text/markdown",
    });
  }
  sendResult(id, { resources });
}

function handleResourcesRead(id, params) {
  const uri = params?.uri;
  if (typeof uri !== "string" || !uri.startsWith(RESOURCE_PREFIX) || !uri.endsWith("/readme")) {
    return sendError(id, ERR.INVALID_PARAMS, `Resource not found: ${String(uri)}`);
  }
  const encoded = uri.slice(RESOURCE_PREFIX.length, -"/readme".length);
  let slug;
  try {
    slug = decodeURIComponent(encoded);
  } catch {
    return sendError(id, ERR.INVALID_PARAMS, `Resource not found: ${uri}`);
  }
  const found = resolveOne(slug);
  if (!found.length) {
    return sendError(id, ERR.INVALID_PARAMS, `Resource not found: ${uri}`);
  }
  const readme = readRepoReadme(found[0].record.path);
  if (readme.state !== "valid") {
    return sendError(
      id,
      ERR.INVALID_PARAMS,
      `README ${readme.state}: ${readme.detail ?? "没有可读的 README"}`,
    );
  }
  sendResult(id, {
    contents: [
      {
        uri,
        mimeType: "text/markdown",
        text: readme.text,
      },
    ],
  });
}

/**
 * `resources/subscribe` (2025-06-18 `server/resources`): a client can ask to be told
 * when one resource changes, and the server emits
 * `notifications/resources/updated {uri}`. The protocol does not say how to detect
 * change; this server polls the README's stat with `fs.watchFile` (250 ms) because:
 *
 *   - it has no native watcher lifecycle to leak across Windows/stdio restarts;
 *   - a README is small and written by a human, so 250 ms polling is cheaper than a
 *     per-resource ReadDirectoryChangesW handle;
 *   - `persistent:false` lets the process exit when stdin closes even if a client
 *     forgot to unsubscribe.
 *
 * Subscriptions are capped and cleared on shutdown; an unknown URI is -32602, never a
 * silent no-op that leaves a client waiting forever.
 */
const SUBSCRIPTIONS = new Map();
const MAX_SUBSCRIPTIONS = 20;

function resourcePathOf(uri) {
  if (typeof uri !== "string" || !uri.startsWith(RESOURCE_PREFIX) || !uri.endsWith("/readme")) {
    return null;
  }
  const encoded = uri.slice(RESOURCE_PREFIX.length, -"/readme".length);
  let slug;
  try {
    slug = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  const found = resolveOne(slug);
  if (!found.length) return null;
  const readme = readRepoReadme(found[0].record.path);
  if (readme.state !== "valid") return null;
  return { uri, path: readme.path, record: found[0].record };
}

function handleResourcesSubscribe(id, params) {
  const target = resourcePathOf(params?.uri);
  if (!target) return sendError(id, ERR.INVALID_PARAMS, `Resource not found: ${String(params?.uri)}`);
  if (SUBSCRIPTIONS.has(target.uri)) return sendResult(id, {});
  if (SUBSCRIPTIONS.size >= MAX_SUBSCRIPTIONS) {
    return sendError(id, ERR.INVALID_PARAMS, `Too many resource subscriptions (max ${MAX_SUBSCRIPTIONS})`);
  }
  let last = null;
  try {
    last = statSync(target.path);
  } catch {
    return sendError(id, ERR.INVALID_PARAMS, `Resource not found: ${target.uri}`);
  }
  const listener = (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return;
    if (!SUBSCRIPTIONS.has(target.uri)) return;
    send({
      jsonrpc: "2.0",
      method: "notifications/resources/updated",
      params: { uri: target.uri },
    });
  };
  SUBSCRIPTIONS.set(target.uri, { path: target.path, listener, last });
  watchFile(target.path, { interval: 250, persistent: false }, listener);
  log(`subscribed ${target.uri} (${SUBSCRIPTIONS.size}/${MAX_SUBSCRIPTIONS})`);
  sendResult(id, {});
}

function handleResourcesUnsubscribe(id, params) {
  const uri = params?.uri;
  if (typeof uri !== "string") return sendError(id, ERR.INVALID_PARAMS, "Bad params: resources/unsubscribe requires a string `uri`");
  const entry = SUBSCRIPTIONS.get(uri);
  if (entry) {
    unwatchFile(entry.path, entry.listener);
    SUBSCRIPTIONS.delete(uri);
    log(`unsubscribed ${uri}`);
  }
  // Idempotent: the protocol has no "not subscribed" error, and a client retrying a
  // lost unsubscribe must not get a second failure.
  sendResult(id, {});
}

function stopSubscriptions() {
  for (const [uri, entry] of SUBSCRIPTIONS) {
    unwatchFile(entry.path, entry.listener);
    log(`unsubscribed ${uri} on shutdown`);
  }
  SUBSCRIPTIONS.clear();
}

/**
 * Prompts are the third primitive (2025-06-18 `server/prompts`): a client lists
 * named, parameterised message templates and asks the user to pick one; the
 * server returns messages, not actions. Every prompt here is therefore a
 * *reading* instruction. None of them promises that the server ran anything —
 * the server cannot, and a prompt that says "started the app" would be a lie the
 * model would repeat.
 */
const PROMPTS = [
  {
    name: "run_repo",
    title: "帮我把这个仓库跑起来",
    description:
      "用只读工具查清一个仓库的启动计划，并把每一步的证据与不确定性讲清楚；不执行任何命令。",
    arguments: [
      {
        name: "repository",
        description: "仓库标识，host/owner/repo 或 owner/repo（与工具参数相同）",
        required: true,
      },
    ],
    template:
      "请只使用 DevHub MCP 的只读工具，帮我了解 {repository} 应该怎么运行。\n" +
      "1. 先找到它（devhub_list_repos / devhub_repo_detail），确认路径与 marker 状态；\n" +
      "2. 再看 devhub_launch_plan 给出的命令与步骤，以及 devhub_repo_ports 的端口块；\n" +
      "3. 用中文给出运行步骤，每一步注明来自哪个工具/字段；\n" +
      "4. 如果信息缺失或工具报错，直接说明缺什么，不要猜测，也不要声称已经执行。",
  },
  {
    name: "review_repo_health",
    title: "检查这个仓库的健康状况",
    description:
      "汇总一个仓库的工作树、未提交内容、缓存、venv、端口与依赖状态，并按严重度给出下一步。",
    arguments: [
      {
        name: "repository",
        description: "仓库标识，host/owner/repo 或 owner/repo",
        required: true,
      },
    ],
    template:
      "请只读地检查 {repository} 的健康状况：工作树与未提交内容、缓存占用、venv 是否有效、端口是否被占用、依赖是否有更新。\n" +
      "先调用可用的 devhub_* 工具收集事实，再按「严重 → 提醒 → 正常」分组。每条结论都要能指回某个工具字段；" +
      "查不到的项写成「未知」，不要用「应该没问题」代替。不要执行启动、停止、删除或更新。",
  },
  {
    name: "find_repo",
    title: "在这个容器里找仓库",
    description: "按名称、所有者或描述线索找本地仓库，并说明每个候选为什么匹配。",
    arguments: [
      {
        name: "query",
        description: "要找的名称、所有者或描述关键词",
        required: true,
      },
    ],
    template:
      "请用 devhub_list_repos 在 DevHub 容器里查找与「{query}」相关的仓库。列出候选的完整 slug 与本地路径，" +
      "并逐条说明匹配依据（名称/所有者/描述/标签）。如果没有任何匹配，明确说没有，不要编造相近的仓库。",
  },
];

/** List shape per `server/prompts`: drop the internal template. */
function promptSummary(prompt) {
  return {
    name: prompt.name,
    title: prompt.title,
    description: prompt.description,
    arguments: prompt.arguments,
  };
}

function renderPrompt(prompt, args) {
  return prompt.template.replace(/\{([a-z_]+)\}/g, (whole, key) =>
    typeof args[key] === "string" ? args[key] : whole,
  );
}

function handlePromptsList(id, params) {
  if (typeof params?.cursor === "string" && params.cursor !== "") {
    sendResult(id, { prompts: [] });
    return;
  }
  sendResult(id, { prompts: PROMPTS.map(promptSummary) });
}

function handlePromptsGet(id, params) {
  const name = params?.name;
  if (typeof name !== "string" || name === "") {
    return sendError(id, ERR.INVALID_PARAMS, "Bad params: prompts/get requires a string `name`");
  }
  const prompt = PROMPTS.find((p) => p.name === name);
  if (!prompt) {
    return sendError(id, ERR.INVALID_PARAMS, `Unknown prompt: ${name}`);
  }
  const raw = params?.arguments;
  if (raw !== undefined && (raw === null || typeof raw !== "object" || Array.isArray(raw))) {
    return sendError(id, ERR.INVALID_PARAMS, "Bad params: prompts/get `arguments` must be an object of strings");
  }
  const args = raw && typeof raw === "object" ? raw : {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== "string") {
      return sendError(id, ERR.INVALID_PARAMS, `Bad params: argument "${key}" must be a string`);
    }
  }
  for (const arg of prompt.arguments) {
    if (arg.required && !String(args[arg.name] ?? "").trim()) {
      return sendError(id, ERR.INVALID_PARAMS, `Missing required argument: ${arg.name}`);
    }
  }
  sendResult(id, {
    description: prompt.description,
    messages: [
      {
        role: "user",
        content: { type: "text", text: renderPrompt(prompt, args) },
      },
    ],
  });
}

function handleToolsCall(id, params) {
  const name = params?.name;
  if (typeof name !== "string" || name === "") {
    // `tools/call` params are `{name, arguments}`; a missing name is a params problem.
    return sendError(id, ERR.INVALID_PARAMS, "Bad params: tools/call requires a string `name`");
  }
  const tool = findTool(name);
  if (!tool) {
    // Spec example: {"code": -32602, "message": "Unknown tool: invalid_tool_name"}.
    // A tool that exists but was gated off by --allow-mutations answers the same way, so
    // the server does not advertise a capability it refuses to name.
    return sendError(id, ERR.INVALID_PARAMS, `Unknown tool: ${name}`);
  }
  let outcome;
  try {
    const args = validateArguments(tool.inputSchema, params?.arguments, name);
    outcome = tool.call(args);
  } catch (error) {
    if (error instanceof ProtocolError) {
      return sendError(id, ERR.INVALID_PARAMS, `Invalid params: ${error.message}`);
    }
    // Execution failures are results with isError:true, not JSON-RPC errors (spec §Error
    // Handling): the model has to be able to read the reason, and an error object cannot.
    return sendResult(id, {
      content: [{ type: "text", text: `工具执行失败：${error.message}` }],
      isError: true,
    });
  }
  sendResult(id, outcome);
}

function handleInitialize(id, params) {
  const requested = typeof params?.protocolVersion === "string" ? params.protocolVersion : "";
  // Negotiation, verbatim from the spec: echo a supported version, otherwise answer with
  // the latest one we support. Refusing here would be wrong — disconnect is the client's
  // call to make, not ours to enforce with an error.
  const negotiated = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_REVISION;
  state.initialized = true;
  state.protocolVersion = negotiated;
  state.clientInfo = params?.clientInfo ?? null;
  log(`initialize: client ${JSON.stringify(state.clientInfo)} requested "${requested}" -> ${negotiated}`);
  sendResult(id, {
    protocolVersion: negotiated,
    capabilities: {
      tools: { listChanged: false },
      resources: { subscribe: true, listChanged: false },
      prompts: { listChanged: false },
    },
    serverInfo: SERVER_INFO,
    instructions:
      "只读地列出 DevHub 项目容器里的仓库；prompts 提供「运行/体检/查找」三份只读提示词模板。写语义的工具需 --allow-mutations 才注册，且即便注册也只返回计划，不启动进程、不写文件。",
  });
}

function handleMessage(message) {
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    return sendError(null, ERR.INVALID_REQUEST, "Invalid Request: a top-level JSON object is required");
  }
  if (message.jsonrpc !== "2.0") {
    return sendError(
      message.id ?? null,
      ERR.INVALID_REQUEST,
      `Invalid Request: jsonrpc must be "2.0", got ${JSON.stringify(message.jsonrpc)}`,
    );
  }
  // A response-shaped message from the client is dropped, not answered. This server never
  // sends requests, so it has nothing to correlate; answering an answer with an error is
  // how a buggy client turns into an error storm on the pipe (each reply being another
  // "response" it tries to answer). JSON-RPC has no error to send back for a response.
  if (
    message.method === undefined &&
    message.id !== undefined &&
    (message.result !== undefined || message.error !== undefined)
  ) {
    log(`dropped client response id=${String(message.id)} (the server never sends requests)`);
    return undefined;
  }
  if (typeof message.method !== "string") {
    return sendError(message.id ?? null, ERR.INVALID_REQUEST, "Invalid Request: method must be a string");
  }
  const { method, id } = message;
  const isRequest = id !== undefined && id !== null;
  if (id === null) {
    // MCP is stricter than base JSON-RPC here: "the ID MUST NOT be null".
    return sendError(null, ERR.INVALID_REQUEST, "Invalid Request: a request ID MUST NOT be null");
  }
  if (!isRequest && method !== "notifications/initialized" && method !== "notifications/cancelled") {
    log(`notification ${method} ignored (no response is permitted to a notification)`);
  }

  switch (method) {
    case "initialize":
      return handleInitialize(id, message.params);
    case "ping":
      return sendResult(id, {});
    case "tools/list":
      if (!state.initialized) log("tools/list arrived before initialize — answered anyway, see handle* note");
      return handleToolsList(id, message.params);
    case "tools/call":
      return handleToolsCall(id, message.params);
    case "resources/list":
      if (!state.initialized) log("resources/list arrived before initialize — answered anyway, see handle* note");
      return handleResourcesList(id, message.params);
    case "resources/read":
      return handleResourcesRead(id, message.params);
    case "resources/subscribe":
      return handleResourcesSubscribe(id, message.params);
    case "resources/unsubscribe":
      return handleResourcesUnsubscribe(id, message.params);
    case "prompts/list":
      if (!state.initialized) log("prompts/list arrived before initialize — answered anyway, see handle* note");
      return handlePromptsList(id, message.params);
    case "prompts/get":
      return handlePromptsGet(id, message.params);
    case "notifications/initialized":
    case "notifications/cancelled":
      return undefined;
    default:
      if (!isRequest) {
        log(`unknown notification ${method} dropped`);
        return undefined;
      }
      return sendError(id, ERR.METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

function startStdioLoop() {
  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    const text = line.trim();
    if (text === "") return;
    let message;
    try {
      message = JSON.parse(text);
    } catch (error) {
      return sendError(null, ERR.PARSE, `Parse error: ${error.message}`);
    }
    try {
      handleMessage(message);
    } catch (error) {
      log(`handler crashed on ${message?.method}: ${error.stack ?? error.message}`);
      if (message?.id !== undefined && message?.id !== null) {
        sendError(message.id, ERR.INTERNAL, `Internal error: ${error.message}`);
      }
    }
  });
  rl.on("close", () => {
    // stdio shutdown is "the client closed the input stream" — there is no shutdown method.
    log(`stdin closed after ${state.initialized ? "a" : "no"} completed handshake; exiting`);
    stopSubscriptions();
    process.exit(0);
  });
}

function main() {
  const argv = parseArgv(process.argv.slice(2));
  if (argv.unknown.length > 0) {
    process.stderr.write(`${USAGE}\n\nunknown argument(s): ${argv.unknown.join(", ")}\n`);
    process.exit(2);
  }
  if (argv.help) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(0);
  }
  const resolved = resolveContainerRoot(argv.root);
  state.root = resolved.root;
  state.rootSource = resolved.source;
  TOOLS.push(...READ_ONLY_TOOLS);
  if (argv.allowMutations) {
    TOOLS.push(...MUTATION_TOOLS);
    log("--allow-mutations: 已注册 devhub_launch_plan / devhub_stop_plan（仍只返回计划）");
  }
  const found = discoverRepositories(resolved.root);
  log(`container root = ${resolved.root} (source: ${resolved.source})`);
  log(`tools registered: ${toolNames().length ? toolNames().join(", ") : "(none)"}`);
  for (const warning of found.warnings) log(`scan warning: ${warning}`);
  log(`scanned ${found.repos.length} repository directory(ies) carrying .devhub.json`);
  startStdioLoop();
}

main();
