/**
 * Shared types for the DevHub frontend.
 *
 * These mirror the Rust command payloads. They live in one file because every
 * view needs a subset, and duplicating them inline is what let the old
 * single-file App.tsx drift.
 */

export type RepoRef = {
  host: string;
  owner: string;
  repo: string;
  local?: string | null;
  /** Absolute directory on disk, when the repository is already present. */
  path?: string | null;
  /**
   * One-line repository description from the GitHub API (or the .devhub.json
   * `description` override, when present). Empty / absent on the wall until
   * a search or star-import fills it; the card shows nothing when it is empty.
   */
  description?: string | null;
};

/**
 * Locally-derived facts about one repository on disk (round 9, 需求 1).
 *
 * Computed by the Rust `repo_metadata` command from the clone itself - no
 * network call - because a wall of cards labelling itself from the GitHub API
 * would be both slow and rate-limited. All fields are best-effort: `0`/`null`
 * mean "the filesystem would not say", never "empty".
 */
export type RepoMeta = {
  /** Canonical `host/owner/repo`, the key this joins to `RepoRef` on. */
  slug: string;
  /** Directory creation time, unix ms. 0 = unknown. */
  installedAt: number;
  /** Recursive size in bytes; symlinks not followed. */
  sizeBytes: number;
  /** Primary language when a marker file names one, e.g. "Rust". */
  language: string | null;
  /** Project type id: rust/go/python/java/dotnet/ruby/php/dart/node/static/unknown. */
  category: string;
  /** Whether dependency/build artefacts exist (the set 缓存清理 measures). */
  hasCache: boolean;
};

/**
 * One repository's GitHub "heat" row (r18 N4) — star count, language, licence, last push.
 *
 * Unlike `RepoMeta`, which is computed from the clone itself, this comes from
 * `GET /repos/{owner}/{repo}` and may therefore be six hours old, server-confirmed,
 * or a failure that still carries the last known numbers. `source` is the only field
 * that says which, so it is what the tile's wording has to follow
 * (`src/lib/heat.ts:heatBadgeOf`).
 *
 * Keyed by `slug` = `owner/repo`, the identity the wall already carries per card.
 */
export type RepoHeat = {
  slug: string;
  stars: number;
  forks: number;
  language?: string | null;
  license?: string | null;
  /** GitHub's `pushed_at`, verbatim ISO 8601 — a label, not a clock. */
  pushedAt?: string | null;
  source: "fresh" | "revalidated" | "cached" | "failed";
  error?: string | null;
};

/** 类别 id → 中文标签，与后端 MARKERS 表一致。 */
export const CATEGORY_LABEL: Record<string, string> = {
  rust: "Rust 项目",
  go: "Go 项目",
  python: "Python 项目",
  java: "Java 项目",
  dotnet: ".NET 项目",
  ruby: "Ruby 项目",
  php: "PHP 项目",
  dart: "Flutter 项目",
  node: "Node 项目",
  static: "静态站点",
  unknown: "未识别",
};

export type GitLocation = { path: string; version: string; source: string };

export type EnvironmentReport = {
  projectRoot: string;
  git: GitLocation | null;
  rootIsFallback: boolean;
  localProxy: string | null;
  resolvedIp: string | null;
  mirrorEnabled: boolean;
  ipPinEnabled: boolean;
  /** True when the app process itself is elevated. DevHub never requests that. */
  elevated: boolean;
  /**
   * One-sentence diagnosis of the GitHub link path, computed in the backend
   * (`link.rs`) from hosts + system proxy + DNS + accelerator reachability.
   */
  linkAdvice: string;
  /** Short phrase for the status strip, derived from the same facts. */
  linkLabel: string;
  /**
   * Whether `github.com` / `api.github.com` currently resolve to this machine
   * because something rewrote `hosts` — Watt Toolkit's default acceleration
   * mode. Detected from the hosts file itself, not from a port probe: a port
   * probe reports 未发现 on exactly these machines, which is the bug this fixes.
   */
  hostsHijacked: boolean;
  /** How many GitHub-related entries the hosts file redirects to loopback. */
  hostsRedirectCount: number;
  /** Who probably wrote them, matched on the section comment (e.g. "Steam++"). */
  hostsBy: string | null;
  /** `HKCU\...\Internet Settings` proxy, only when `ProxyEnable` is 1. */
  systemProxy: string | null;
  /** What the app decided to do about the hosts rewrite. */
  searchRoute: "bypass" | "useHosts";
  downloadRoute: "bypass" | "useHosts";
};

export type GitBootstrapMarker = {
  tag: string;
  asset: string;
  bytes: number;
  viaMirror: string | null;
  /** GitHub's `sha256:<hex>` digest when the API provided one (r27-R3). */
  digest?: string | null;
  /** False also means "no digest was available", not necessarily "corrupt". */
  digestVerified?: boolean;
  installedAt: string;
};

export type GitBootstrapStatus = {
  bundled: boolean;
  bundledPath: string;
  runtimeDir: string;
  marker: GitBootstrapMarker | null;
};

export type RefPreview = { slug: string; url: string; target: string; exists: boolean };

/** `GET /repos/{owner}/{repo}`, the subset the add page shows (r22-N1). */
export type RepoFacts = {
  fullName: string;
  description: string | null;
  stars: number;
  language: string | null;
  license: string | null;
  defaultBranch: string | null;
  /** GitHub's raw `size` integer; the UI does not convert an unverified unit. */
  size: number | null;
  pushedAt: string | null;
  archived: boolean;
  private: boolean;
  fork: boolean;
};

/** Remote preflight: facts, GitHub's failure sentence, and the landing volume. */
export type RemotePreview = {
  facts: RepoFacts | null;
  error: string | null;
  diskFreeBytes: number | null;
  diskTotalBytes: number | null;
  diskPath: string;
  diskError: string | null;
};

export type DownloadLayer = "direct" | "ipPinned" | "localProxy" | "mirror" | "bundle";

export type AttemptRecord = {
  layer: DownloadLayer;
  label: string;
  ok: boolean;
  detail: string;
  ms: number;
};

export type DownloadOutcome = {
  layer: DownloadLayer;
  path: string;
  attempts: AttemptRecord[];
  degraded: boolean;
  viaThirdParty: boolean;
};

/**
 * What one 更新仓库 (`git pull --ff-only`) did — mirrors `downloader::UpdateOutcome`.
 *
 * `layer` can only ever be `direct` / `ipPinned` / `localProxy`. The mirror layer
 * works by rewriting the **clone URL**, and a pull has no URL to rewrite: its
 * `origin` is whatever the clone recorded. So 更新 has three roads, not the four a
 * download has, and the UI must say that rather than reusing the 四层回退 wording.
 */
export type UpdateOutcome = {
  layer: DownloadLayer;
  path: string;
  /** HEAD before the pull, seven characters. */
  before: string;
  /** HEAD after it. Equal to `before` means the checkout was already current. */
  after: string;
  /**
   * New commits that arrived, or `null` when git could not count them (a shallow
   * or grafted history). `null` is not `0` - printing "0 个新提交" there is a lie.
   */
  commits: number | null;
  viaThirdParty: boolean;
  attempts: AttemptRecord[];
  /**
   * Up to 20 new commits, git log order. Empty when HEAD did not move or git
   * could not read the log — not a claim that nothing changed.
   */
  recent?: CommitSummary[];
};

export type CommitSummary = { hash: string; subject: string };

/**
 * Answer to `repo_freshness` (需求 8.2): local HEAD against the remote's.
 *
 * `state` is one of `fresh` / `behind` / `unknown` / `no-git` / `missing`. An
 * unreachable remote reads `unknown`, never `fresh` - a badge that claims "已是最新"
 * because the network failed is worse than no badge.
 */
export type Freshness = {
  slug: string;
  state: string;
  localHead: string | null;
  remoteHead: string | null;
  /** Unix ms of the check, so a cached answer can be labelled with its own age. */
  checkedAt: number;
  error: string | null;
};

/**
 * One row of `repo_freshness_many` (需求 8.2): the batch's per-slug answer.
 *
 * `freshness` is `null` when the call did not reach the slug — it answers cached
 * hits and a bounded number of fresh misses, and says "no answer" rather than
 * inventing one. A `null` row must never be read as 「无新提交」/「与远程一致」.
 */
export type FreshnessManyRow = {
  slug: string;
  freshness: Freshness | null;
};

/** One outdated dependency from `check_dependencies`. */
export type Dependency = {
  name: string;
  current: string;
  wanted: string;
  latest: string;
};

/** Answer to `check_dependencies`: package manager + outdated list. */
export type DependencyReport = {
  slug: string;
  manager: string;
  outdated: Dependency[];
  error: string | null;
};

/**
 * Answer to `install_plan` (需求 8.4): a proposal with its evidence, never a run.
 *
 * Running it goes through the same confirmed-step path as any launch step, because
 * the user's confirmation is the correctness guarantee (REQUIREMENTS §3.2).
 */
export type InstallPlan = {
  command: string;
  evidence: string;
  inspected: string[];
  ecosystem: string;
  /** The chosen manager is not on this machine - say so before running it. */
  toolPresent: boolean;
  toolName: string;
};

/** One service's port and whether it answered (需求 8.9). */
export type PortHealth = {
  service: string;
  port: number;
  listening: boolean;
};

/**
 * Answer to `repo_worktree_status` (需求 8.3): what a delete or a cache clear would
 * take with it. Every field is optional-by-failure: git refusing to answer must read
 * as "无法确认", never as "干净".
 */
export type WorktreeStatus = {
  hasGit: boolean;
  branch: string | null;
  /** Modified / staged files. */
  dirty: number;
  /** The `??` lines, counted apart because a build produces them constantly. */
  untracked: number;
  /** Commits ahead of the upstream, when there is one — unpushed work. */
  ahead: number | null;
};

/**
 * One Python interpreter this machine offers (`list_pythons`, 需求 8.5).
 *
 * `id` is the executable path and also what gets pinned into `.devhub.json`.
 * REQUIREMENTS §3.6 records that this box carries three real Pythons and that not
 * locking one "必然产生依赖冲突", so the list is shown in full, including the one
 * the launcher marks as default.
 */
export type PythonInstall = {
  id: string;
  version: string;
  /** `py` 启动器 or `PATH` — how the entry was found, and why it may be absent. */
  source: string;
};

/**
 * A progress event from the Rust side.
 *
 * `stage` is a routing key as well as a label. A stage ending in `-progress` is an
 * in-place rewrite (git's `Receiving objects: 45%`), which updates the status line
 * and the progress bar but is deliberately **not** appended to the log - a large
 * clone rewrites that line once per percent, and forwarding all of them is what
 * made the download view hundreds of lines long.
 */
export type ProgressEvent = {
  stage: string;
  message: string;
  /** Which download emitted this. Absent on pre-queue builds. */
  task?: string;
  /** The parallel limit in effect, echoed so the queue and 设置 cannot drift. */
  maxParallel?: number;
};

export type LaunchKind = "run" | "installThenRun" | "serve" | "build";

export type Candidate = {
  command: string;
  evidence: string;
  kind: LaunchKind;
  confidence: number;
};

/** A recognised dangerous shape in a launch command. Codes are stable; the UI
 *  maps them to localized sentences (`launch.risk.*`). */
export type RiskHit = { code: string; severity: "warn" | "danger" };
export type CandidateRisk = { command: string; hits: RiskHit[] };

export type DetectionReport = {
  projectType: string | null;
  candidates: Candidate[];
  inspected: string[];
  notes: string[];
  /** Only commands with at least one hit; a missing command means no hits. */
  risks?: CandidateRisk[];
};

export type LaunchConfig = {
  command: string;
  cwd: string;
  userConfirmed: boolean;
  kind: LaunchKind | null;
  /** Multi-step commands; empty means "single step, use command". */
  steps: LaunchStep[];
};

/** One step of a multi-step launch configuration. */
export type LaunchStep = {
  name: string;
  command: string;
  cwd: string;
  parallel: boolean;
};

export type RepoDetail = {
  slug: string;
  path: string;
  launch: LaunchConfig | null;
  /**
   * What 项目设置 reads and writes. These four live in the repository's own
   * `.devhub.json`, so they follow the clone rather than this machine - which is
   * why `null` (no override, follow the global) has to be distinguishable from
   * "the global happens to be the same value".
   */
  url: string;
  portBase: number;
  venvPath: string | null;
  stepwise: boolean | null;
  terminalChoice: string | null;
  ideChoice: string | null;
  /**
   * The interpreter pinned for this repository (需求 8.5). `null` = follow the venv,
   * then PATH. Lives in `.devhub.json` for the reason §3.6 gives: this machine has
   * several real Pythons and an unlocked version is how dependency conflicts start.
   */
  pythonChoice: string | null;
  /**
   * Whether the recorded path is *actually* an environment, or whether one is
   * sitting unrecorded in `项目\venvs`. `venvPath` alone used to be the whole answer,
   * which is how a moved or half-built environment rendered as healthy while the
   * launch path had already stopped using it. Mirrors `launch::VenvState`.
   */
  venvState: VenvState;
  /** Where `create_repo_venv` would put a new environment, recorded or not. */
  venvDir: string | null;
  /** Branch checked out by the clone; `null` = the remote's default branch. */
  branch: string | null;
};

/**
 * What the disk says about one repository's Python environment.
 *
 * Declared here rather than beside its helpers because `repo_detail` answers with
 * it: the panel needs the union without importing the module that formats sentences.
 * Mirrors `launch::VenvState` (serde camelCase).
 */
export type VenvState =
  | "ready"
  | "missing"
  | "notAVenv"
  | "unrecorded"
  | "staleDir"
  | "nothing";

export type LaunchStarted = { pid: number; command: string; cwd: string };

/** Summary of running the whole step list. */
export type StepsRunReport = { started: string[]; failed: string[] };

/** A detectable terminal or IDE. */
export type ToolInfo = {
  id: string;
  label: string;
  path?: string;
  /** How it was found (卸载记录 / App Paths / 已知安装位置 / PATH / 手动指定). */
  detail?: string;
  /** `data:image/png;base64,...`, extracted from the executable. */
  icon?: string;
};

/** One recorded operation shown in the 记录 view. */
export type ActivityEntry = {
  /** Stable id, so a single row can be deleted. */
  id: string;
  ts: number;
  tag: string;
  action: string;
  detail: string;
  slug: string;
  /** 界面归属: which view issued the operation. Empty on pre-existing rows. */
  source: string;
  /** 受影响路径: the filesystem path the operation touched. */
  path: string;
  /**
   * What was changed, addressed rather than described. Two entries with the
   * same target are the same thing being adjusted repeatedly, which is what
   * lets 记录 fold "启动命令改了五次" into one block.
   */
  target?: string;
  /** The value before / after, for the diff line and for a value 回退. */
  before?: string;
  after?: string;
  undo?: UndoDescriptor;
  /** Unix seconds when this entry's 回退 was applied; 0 / absent = not undone. */
  undoneTs?: number;
};

/** How one record would be reversed, or why it cannot be. */
export type UndoDescriptor = {
  kind: "value" | "redownload" | "delete" | "restore_trash" | "none";
  /** `config` is written back by Rust; `ui` lives in localStorage and the frontend applies it. */
  scope?: string;
  key?: string;
  value?: string;
  args?: string[];
  reason?: string;
};

/** Answer to `undo_plan`. */
export type UndoPlan = {
  id: string;
  action: string;
  undo: UndoDescriptor | null;
  reason: string;
};

/** One process the launcher started and is still tracking. */
export type ProcessState = {
  pid: number;
  label: string;
  slug: string;
  /**
   * `suspended` is a real third state now: 挂起 freezes the process tree rather
   * than killing it, so it can be resumed with its sockets and terminal intact.
   */
  state: "running" | "suspended" | "exited";
  exitCode: number | null;
  /**
   * How long it actually ran. Frozen at exit — the bug this note exists for was
   * `已退出（代码 1）· 运行了 5 分 15 秒` on a command that died instantly, because
   * the number was "time since we launched", not "time it lived".
   */
  elapsedMs: number;
  stoppable: boolean;
  suspendable: boolean;
  /** Kernel+user CPU time; absent when Windows refused the query. */
  cpuMs?: number | null;
  /** Working-set bytes; absent when Windows refused the query, never a fake 0. */
  workingSetBytes?: number | null;
  ioReadBytes?: number | null;
  ioWriteBytes?: number | null;
};

export type Environments = {
  python: string | null;
  node: string | null;
  docker: string | null;
  vscode: string | null;
};

export type CacheItem = { rel: string; bytes: number; label: string };

/** One row of the read-only repository file listing (r22-N2). */
export type RepoFileEntry = {
  path: string;
  kind: "file" | "dir";
  size: number | null;
  depth: number;
};

export type RepoFiles = {
  root: string;
  maxDepth: number;
  maxEntries: number;
  entries: RepoFileEntry[];
  count: number;
  truncated: boolean;
  depthLimitReached: boolean;
  unreadable: string[];
  ignored: string[];
};

export type ClearReport = {
  items: CacheItem[];
  totalBytes: number;
  freedBytes: number;
  removed: string[];
  failed: string[];
};

export type DeleteReport = {
  removedRepo: boolean;
  removedVenv: boolean;
  freedBytes: number;
  failed: string[];
};

export type RootCheck = {
  path: string;
  exists: boolean;
  parentExists: boolean;
  writable: boolean;
  underProgramFiles: boolean;
  ok: boolean;
  message: string;
};

export type SettingsView = {
  projectRoot: string;
  projectRootIsDefault: boolean;
  mirrorEnabled: boolean;
  ipPinEnabled: boolean;
  mirrors: string[];
  effectiveMirrors: string[];
  proxy: string;
  configPath: string;
  /** `file` normal; `backup` recovered from the .bak; `default` neither parsed. */
  configSource: "file" | "backup" | "default";
  configError: string | null;
  configBackupPath: string;
  hasGithubToken: boolean;
  /** A DPAPI blob is present but this Windows user cannot decrypt it. */
  tokenUnreadable: boolean;
  extraRoots: string[];
  terminalChoice: string;
  ideChoice: string;
  /** IDE executables the user named by hand, shown so they can be removed. */
  customIdes: string[];
  activityRetentionDays: number;
  searchRoute: "bypass" | "useHosts";
  downloadRoute: "bypass" | "useHosts";
  searchDebounceMs: number;
  parallelDownloads: number;
  cleanupMode: "manual" | "daily" | "weekly" | "monthly";
  cleanupKeepDays: number;
  /**
   * Which `git clone` arguments the downloader asks for. `""` is a value, not an
   * absence: it is what the backend reads as a complete clone, the default. See
   * `docs/clone-strategy.md` for why a non-default choice reports whether it took
   * effect instead of assuming it did.
   */
  cloneStrategy: string;
  /** Directories that have been the main root before, newest first. */
  recentRoots: string[];
  hostsHijacked: boolean;
  hostsBy: string | null;
};

/** What a settings save returned: the new state plus a plain-language note. */
export type SettingsSave = {
  settings: SettingsView;
  /** e.g. "项目目录：D:\旧 → D:\新", "旧目录已转入附加目录：…". */
  notes: string[];
  /** True when the project root changed, so the wall must be re-pulled. */
  rootChanged: boolean;
};

export type RepoHit = {
  fullName: string;
  description: string;
  stars: number;
  language: string;
  updatedAt: string;
  archived: boolean;
  topics: string[];
};

export type SearchOutcome = {
  items: RepoHit[];
  totalCount: number;
  fromCache: boolean;
  /** GitHub 对条件请求回了 304 并复用了已有结果（与本地 TTL 命中不同：前者是服务器确认「未变更」）。 */
  notModified: boolean;
  remaining: number | null;
  resetIn: number | null;
  throttled: boolean;
  error: string | null;
};

export type SearchStatus = {
  remainingBudget: number;
  cachedQueries: number;
  hasToken: boolean;
  limitPerMinute: number;
};

/**
 * One page of `GET /user/starred` (r18 N3). `items` reuses [`RepoHit`] because
 * GitHub sends the same repo object for starred entries as for search results —
 * the sharing is deliberate and the field mapping exists once, in Rust
 * (`search::parse_repo_item`).
 */
export type StarPage = {
  items: RepoHit[];
  /** The page came back full, i.e. another page may exist (no total is offered). */
  hasMore: boolean;
  page: number;
  /** Requests left in the hourly allowance, from GitHub's own headers. */
  remaining: number | null;
  resetIn: number | null;
};

/**
 * `docker_status` 的快照（r21-N2-1 接线）。字段名对齐 Rust 侧
 * `src-tauri/src/docker.rs` 的 `#[serde(rename_all = "camelCase")]`，那条 rename
 * 是在第一个前端消费者出现的同一个提交里补的，并由 docker.rs 的
 * `docker_status_serializes_the_camel_case_names_types_ts_reads` 单测钉住。
 *
 * 三个「可否用」事实必须分开报：CLI 在不在 PATH、daemon 跑没跑、compose 插件答不
 * 答话，任何一格 `null` 的含义都是**没查到**，不是「正常」——面板的措辞按这个约定写。
 */
export type DockerStatus = {
  /** `docker` 是否在 PATH 上。 */
  cliFound: boolean;
  /** `docker --version` 原文；查不到为 null。 */
  version: string | null;
  /** `docker info` 能否跑通 = 守护进程在运行。 */
  daemonRunning: boolean;
  /** 守护进程不可用时后端给的原因原文。 */
  daemonError: string | null;
  /** `docker compose version` 原文；compose 用不了为 null。 */
  composeVersion: string | null;
  /** compose 没答话时的原因原文。CLI 不在 PATH 上时为 null（连探针都没跑）。 */
  composeError: string | null;
  /** 运行中容器数；守护进程不可用时后端置 0，此时界面上不该拿它当事实显示。 */
  runningContainers: number;
  imageCount: number;
};

export type CoverImage = { path: string | null; cached: boolean; error?: string | null };

export const LAYER_LABEL: Record<DownloadLayer, string> = {
  direct: "直连",
  ipPinned: "IP 钉死",
  localProxy: "本地代理",
  mirror: "第三方镜像",
  bundle: "压缩包兜底",
};

export const KIND_LABEL: Record<LaunchKind, string> = {
  run: "运行",
  installThenRun: "先装依赖再运行",
  serve: "启动服务",
  build: "构建",
};

export const ACTIVITY_TAG_LABEL: Record<string, string> = {
  download: "下载",
  update: "更新",
  delete: "删除",
  clear: "清理",
  launch: "启动",
  terminal: "终端",
  ide: "IDE",
  settings: "设置",
  appearance: "外观",
  interface: "界面",
};

/**
 * Byte formatter lives in `lib/format.ts` as the single source of truth.
 *
 * This re-export is a *transitional* path, not a second home: it exists only for
 * `views/ProjectsView.tsx`, which another work stream owns. Two import paths for
 * one function is how `formatBytes` was read as if they could differ — every other
 * consumer (`RepoTile`, `CleanupSection`, `CacheUsageRow`, the tests) now imports
 * `lib/format` directly. When `ProjectsView` moves, delete this line; the identity
 * pin in `tests/types-format.test.ts` proves it is a pass-through until then.
 */
export { formatBytes } from "./lib/format";

/**
 * git worktree 产品化（第十六轮方向 N1）。
 *
 * Three new payload types, all mirrors of `src-tauri/src/gitwt.rs` (serde
 * `rename_all = "camelCase"` on both sides, so a rename on one side is a type error
 * on the other rather than a silent `undefined`). They are appended here and nothing
 * above is touched, because another work stream is adding fields to `RepoDetail` in
 * the same file.
 */

/** One entry of `git worktree list --porcelain`. Mirrors `gitwt::WorktreeInfo`. */
export type WorktreeInfo = {
  /** Absolute path, backslashes. */
  path: string;
  /** The commit HEAD points at. Empty for an unborn tree — which is why it is a
   *  string rather than `string | null`: git prints the key with no value. */
  head: string;
  /** Branch name, `null` when detached. Then `head` is the row's only identity. */
  branch: string | null;
  detached: boolean;
  /** The record is a bare repository, not a working tree. */
  bare: boolean;
  /** git says the registration points at a directory that is already gone. */
  prunable: boolean;
  /** git has it locked; `git worktree remove` will refuse it. */
  locked: boolean;
  isMain: boolean;
  /** The directory is on disk. */
  exists: boolean;
  /** Inside `<项目根>\_worktrees` one level deep, so this app is allowed to delete
   *  it. `false` for the main checkout and for a tree the user made elsewhere. */
  managed: boolean;
  /** What git says about *this* tree. `null` when the directory is gone.
   *  Same shape the delete confirmation reads (`WorktreeStatus`), same probe. */
  status: WorktreeStatus | null;
};

/** Answer to `list_repo_worktrees`. Mirrors `gitwt::WorktreeList`. */
export type WorktreeList = {
  repo: string;
  /** `false` = this directory has no version control at all, which is a different
   *  sentence from "还没有工作树" and must never render as it. */
  hasGit: boolean;
  /** `<项目根>\_worktrees` — where a new one lands. */
  container: string;
  worktrees: WorktreeInfo[];
  /** git's own words when the listing failed. Distinct from `hasGit: false`. */
  error: string | null;
};

/** What `remove_repo_worktree` did. Mirrors `gitwt::RemoveReport`. */
export type WorktreeRemoveReport = {
  path: string;
  branch: string | null;
  /** A directory was actually deleted (git said so *and* it is gone). */
  removed: boolean;
  /** `--force` was passed, i.e. uncommitted work was destroyed. */
  force: boolean;
  /** Stale registrations `git worktree prune -v` dropped. */
  pruned: number;
  /** Why nothing was deleted although nothing failed: the directory was already gone. */
  note: string | null;
  /** git's refusals, verbatim — including the dirty tree one, which is what tells
   *  the panel to offer 强制 rather than having guessed it from a probe. */
  failed: string[];
};

