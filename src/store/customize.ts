import { create } from "zustand";
import { scheduleStorageWrite } from "../lib/storage";

/**
 * The element registry — the foundation the rest of round 3 hangs off.
 *
 * ## The problem this solves
 *
 * Before this file, "customise the interface" meant one boolean per block wired
 * by hand: `showBrand` gated the sidebar brand, `showStatusStrip` gated the
 * strip, `showSearchBlock` gated the search panel, and every other block on
 * every screen had no switch at all. Adding a switch meant touching the view,
 * the appearance store, `applyAppearance`, and the 外观 view — four places for
 * one checkbox, which is why only five of ~70 blocks ever got one.
 *
 * ## How it works
 *
 * One registry of element descriptors (`ELEMENTS`), one store of per-element
 * overrides, and **one generated stylesheet**. A component opts in by carrying
 * `data-reg-id`, which `reg("id")` returns as spreadable props:
 *
 *     <section {...reg("add-composer-panel")}> … </section>
 *
 * Customisation is then applied by *selector*, not by inline style:
 *
 *     [data-reg-id="add-composer-panel"] { display: none !important; }
 *
 * That choice is load-bearing in three ways. Inline styles would have to be
 * threaded through every component (prop drilling across 12 files) and would
 * lose to any `!important` in the skins. A generated sheet keeps the views
 * untouched apart from the attribute, survives re-renders, and — the reason it
 * matters for 开发者模式 — the sheet *is* the state: exporting it reproduces a
 * machine's entire interface layout, and the developer panel can show the user
 * the exact CSS they are writing.
 *
 * ## Two layers, one switch
 *
 * Layer 1 (always available): 显示/隐藏, 顺序, 尺寸档位, 钉到常用. Everything an
 * element declares it supports.
 * Layer 2 (behind `devMode`): pixel 位移/宽高 and a raw CSS declaration block
 * per element. Layer 2 is stored in the same record, so turning developer mode
 * off does not discard someone's layout — it just stops them editing it.
 *
 * ## Where this lives, and why not in the backend
 *
 * `localStorage`, like 外观 before it. These are display facts about *this*
 * device — the same reasoning that kept `showBrand` out of `AppConfig`. The
 * backend schema would otherwise grow a field for every block on every screen.
 * The cost is that it does not travel with `settings.json`, so 设置 exports it
 * separately (`exportLayout` / `importLayout`) rather than pretending the two
 * stores are one.
 */

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

/** Which bucket an element lands in inside 设置 → 界面 and the developer panel. */
export type ElementGroup =
  | "外壳"
  | "侧边栏"
  | "项目页"
  | "添加页"
  | "记录页"
  | "设置页"
  | "启动面板"
  | "状态栏"
  | "外观页"
  | "常用页";

export const GROUP_ORDER: ElementGroup[] = [
  "外壳",
  "侧边栏",
  "状态栏",
  "项目页",
  "常用页",
  "添加页",
  "记录页",
  "设置页",
  "外观页",
  "启动面板",
];

/** 「外壳」组：装的是不跳转、只属于外壳自己的区块（命令面板按这个常量排掉它）。 */
export const SHELL_GROUP: ElementGroup = "外壳";

/** 设置 → 界面进页时默认展开的两组：常驻的导航与状态条。 */
export const DEFAULT_OPEN_GROUPS: readonly ElementGroup[] = ["侧边栏", "状态栏"];

// ---------------------------------------------------------------------------
// Descriptors
// ---------------------------------------------------------------------------

/**
 * A size 档位. `vars` are custom properties set on the element, which is how a
 * tier changes geometry without knowing the element's markup: the sidebar reads
 * `--reg-width`, the wall reads `--skin-grid-min`, and neither has to mention
 * the word "档位" anywhere.
 */
export type SizeTier = {
  id: string;
  label: string;
  vars?: Record<string, string>;
  /** Extra raw declarations, for tiers that cannot be expressed as one variable. */
  css?: string;
};

const WIDTH_TIERS: SizeTier[] = [
  { id: "sm", label: "窄", vars: { "--reg-width": "10.5rem" } },
  { id: "md", label: "标准", vars: { "--reg-width": "12.5rem" } },
  { id: "lg", label: "宽", vars: { "--reg-width": "15.5rem" } },
  { id: "xl", label: "特宽", vars: { "--reg-width": "18.75rem" } },
];

const PANEL_TIERS: SizeTier[] = [
  { id: "sm", label: "紧凑", css: "padding: 0.5rem 0.625rem;" },
  { id: "md", label: "标准" },
  { id: "lg", label: "宽松", css: "padding: 1.25rem 1.375rem;" },
];

const ROW_TIERS: SizeTier[] = [
  { id: "sm", label: "矮", css: "padding-top: 0.375rem; padding-bottom: 0.375rem;" },
  { id: "md", label: "标准" },
  { id: "lg", label: "高", css: "padding-top: 0.875rem; padding-bottom: 0.875rem;" },
];

export type ElementDef = {
  id: string;
  /** Shown to the user, so it must read like a menu item, not a variable name. */
  label: string;
  group: ElementGroup;
  /** One line of what this block actually is, for the inspector and 设置 → 界面. */
  hint?: string;
  sizes?: SizeTier[];
  /** Can be pinned to 常用. False for things that are already always visible. */
  pinnable?: boolean;
  /**
   * Free layout is offered. Not every element is a good candidate: a `<span>`
   * inside a text row can be resized but the result is unreadable, so the
   * registry only offers it for blocks that own their box.
   */
  layoutable?: boolean;
  /**
   * Hiding this removes information the app promises to always show. The
   * switch still works — this only decides whether the inspector warns.
   */
  critical?: boolean;
};

export const ELEMENTS: ElementDef[] = [
  // --- 外壳 ---------------------------------------------------------------
  {
    id: "titlebar",
    label: "标题栏",
    group: "外壳",
    hint: "无边框窗口的自绘标题栏：拖动、最小化、最大化、关闭。",
    critical: true,
    layoutable: true,
  },
  {
    id: "view-panel",
    label: "内容面板",
    group: "外壳",
    hint: "承载所有页面的那块圆角面板，含底部状态栏。",
    layoutable: true,
  },
  {
    id: "view-container",
    label: "内容区宽度上限",
    group: "外壳",
    hint: "页面内容的最大宽度。窗口更宽时内容居中留白。",
    sizes: [
      { id: "narrow", label: "窄", vars: { "--reg-max-w": "57.5rem" } },
      { id: "md", label: "标准", vars: { "--reg-max-w": "75rem" } },
      { id: "wide", label: "宽", vars: { "--reg-max-w": "95rem" } },
      { id: "full", label: "铺满", vars: { "--reg-max-w": "9999rem" } },
    ],
    layoutable: true,
  },
  { id: "git-missing-gate", label: "缺少 Git 的提示条", group: "外壳", hint: "未找到 Git 时置顶的引导条。" },
  { id: "toast-host", label: "气泡提示", group: "外壳", hint: "右下角的成功/失败提示。" },

  // --- 侧边栏 -------------------------------------------------------------
  {
    id: "sidebar-rail",
    label: "侧边栏",
    group: "侧边栏",
    hint: "整条导航栏。收纳成图标栏在「侧边栏 → 收纳」里设置。",
    sizes: WIDTH_TIERS,
    layoutable: true,
  },
  { id: "sidebar-brand", label: "软件名称区块", group: "侧边栏", hint: "图标、DevHub 与副标题。" },
  { id: "sidebar-brand-icon", label: "软件图标", group: "侧边栏" },
  { id: "sidebar-brand-tagline", label: "副标题", group: "侧边栏", hint: "「GitHub 项目容器与启动器」。" },
  { id: "sidebar-nav", label: "导航列表", group: "侧边栏", critical: true },
  { id: "nav-item-projects", label: "导航项：项目", group: "侧边栏", critical: true },
  { id: "nav-item-add", label: "导航项：添加", group: "侧边栏", critical: true },
  { id: "nav-item-records", label: "导航项：记录", group: "侧边栏", critical: true },
  { id: "nav-item-frequent", label: "导航项：常用", group: "侧边栏", critical: true },
  // Round 9 (需求 10): 设置 is no longer a peer of the content views, so its
  // entry is a placeable, hideable control rather than a nav item. The element
  // moved to 外壳 because the entry renders in the sidebar footer or the title
  // bar depending on `settingsEntry`, and hiding it hides it wherever it is.
  { id: "nav-item-settings", label: "设置入口", group: "外壳", critical: true },
  { id: "sidebar-nav-badge", label: "导航项的项目数角标", group: "侧边栏" },
  { id: "sidebar-footer", label: "侧边栏底部区块", group: "侧边栏", sizes: PANEL_TIERS },
  { id: "sidebar-refresh", label: "刷新按钮", group: "侧边栏" },
  { id: "sidebar-version", label: "版本号", group: "侧边栏" },
  { id: "sidebar-collapse", label: "侧边栏收纳", group: "侧边栏", hint: "把侧边栏收成图标栏的开关本体。" },

  // --- 状态栏 -------------------------------------------------------------
  {
    id: "status-strip",
    label: "底部状态栏",
    group: "状态栏",
    hint: "常驻的一行链路、git 与项目目录读数。",
    critical: true,
    sizes: [
      { id: "sm", label: "矮", vars: { "--reg-strip-h": "1.625rem" } },
      { id: "md", label: "标准", vars: { "--reg-strip-h": "2rem" } },
      { id: "lg", label: "高", vars: { "--reg-strip-h": "2.5rem" } },
    ],
    layoutable: true,
  },
  { id: "status-seg-link", label: "状态栏：链路读数", group: "状态栏", hint: "直连 / IP 钉死 / 本地代理 / hosts 劫持。", critical: true },
  { id: "status-seg-net", label: "状态栏：网络连通", group: "状态栏", hint: "GitHub 实时可达性：在线 / 迟缓 / 离线，点击重新探测。" },
  { id: "status-seg-git", label: "状态栏：git 版本", group: "状态栏" },
  { id: "status-seg-root", label: "状态栏：项目目录", group: "状态栏" },
  { id: "status-seg-active", label: "状态栏：运行中的进程数", group: "状态栏", hint: "有几个进程正在跑，点击跳到该项目。" },
  { id: "status-card-project-root", label: "展开卡片：项目目录", group: "状态栏" },
  { id: "status-card-git", label: "展开卡片：git", group: "状态栏" },
  { id: "status-card-proxy", label: "展开卡片：本地代理", group: "状态栏" },
  { id: "status-card-resolved-ip", label: "展开卡片：github.com 解析", group: "状态栏" },
  { id: "status-card-hosts", label: "展开卡片：hosts 劫持", group: "状态栏", hint: "检测到本地加速工具改写 hosts 时出现。" },

  // --- 项目页 -------------------------------------------------------------
  { id: "projects-header", label: "项目页：页头", group: "项目页", sizes: ROW_TIERS },
  { id: "projects-toolbar", label: "项目页：筛选与搜索条", group: "项目页", pinnable: true },
  { id: "projects-repo-grid", label: "项目墙", group: "项目页", pinnable: true, critical: true, layoutable: true },
  { id: "projects-empty-state", label: "项目页：空状态", group: "项目页" },
  { id: "repo-tile-path", label: "卡片：磁盘路径", group: "项目页" },
  { id: "repo-tile-owner", label: "卡片：拥有者", group: "项目页" },
  { id: "repo-tile-badge", label: "卡片：悬浮「打开」角标", group: "项目页" },
  { id: "repo-tile-tags", label: "卡片：标签行", group: "项目页", hint: "卡片底部的用户标签徽标。" },
  { id: "projects-tag-chips", label: "项目页：标签筛选行", group: "项目页", hint: "按标签收窄项目墙的一排 chip，只在墙上至少有一个标签时出现。" },
  { id: "repo-tags-dialog", label: "标签编辑弹层", group: "项目页", hint: "卡片菜单「标签…」打开的那一面。" },
  { id: "wall-view-dialog", label: "项目墙视图命名弹层", group: "项目页", hint: "保存或重命名项目墙视图时打开的那一面。" },
  { id: "grep-dialog", label: "在项目中搜索弹层", group: "项目页", hint: "卡片菜单「在项目中搜索…」打开的那一面。" },

  // --- 添加页 -------------------------------------------------------------
  { id: "add-header", label: "添加页：页头", group: "添加页", sizes: ROW_TIERS },
  { id: "add-composer-panel", label: "下载输入区", group: "添加页", pinnable: true, sizes: PANEL_TIERS, layoutable: true },
  { id: "add-bulk-panel", label: "批量导入", group: "添加页", pinnable: true, sizes: PANEL_TIERS, layoutable: true },
  { id: "add-preview-lines", label: "落位预览", group: "添加页", hint: "输入时显示 slug 与目标目录。" },
  { id: "add-advanced-block", label: "高级选项", group: "添加页", sizes: PANEL_TIERS },
  { id: "add-toggle-ip-pin", label: "高级选项：钉死 IP", group: "添加页" },
  { id: "add-toggle-mirror", label: "高级选项：第三方镜像", group: "添加页" },
  { id: "add-search-panel", label: "搜索 GitHub 仓库", group: "添加页", pinnable: true, sizes: PANEL_TIERS, layoutable: true },
  { id: "add-stars-panel", label: "从星标导入", group: "添加页", pinnable: true, sizes: PANEL_TIERS, layoutable: true },
  { id: "add-search-sort", label: "搜索：排序选择", group: "添加页" },
  { id: "add-search-budget", label: "搜索：额度读数", group: "添加页" },
  { id: "add-search-results", label: "搜索：结果列表", group: "添加页" },
  { id: "add-search-pager", label: "搜索：翻页", group: "添加页" },
  { id: "download-queue", label: "下载队列", group: "添加页", pinnable: true, layoutable: true },
  { id: "download-phase-indicator", label: "下载：阶段指示", group: "添加页" },
  { id: "download-log", label: "下载：详细日志", group: "添加页" },
  { id: "download-attempts", label: "下载：实际路径与尝试", group: "添加页" },

  // --- 记录页 -------------------------------------------------------------
  { id: "records-header", label: "记录页：页头", group: "记录页", sizes: ROW_TIERS },
  { id: "records-tag-chip-row", label: "记录：类型筛选", group: "记录页" },
  { id: "records-time-range-row", label: "记录：时间范围", group: "记录页" },
  { id: "records-list", label: "记录列表", group: "记录页", pinnable: true, layoutable: true },

  // --- 设置页 -------------------------------------------------------------
  { id: "settings-group-roots", label: "设置：项目目录", group: "设置页", sizes: PANEL_TIERS },
  { id: "settings-group-network", label: "设置：网络", group: "设置页", sizes: PANEL_TIERS },
  { id: "settings-group-editors", label: "设置：编辑器与 IDE", group: "设置页", sizes: PANEL_TIERS },
  { id: "settings-group-records", label: "设置：记录", group: "设置页", sizes: PANEL_TIERS },
  { id: "settings-group-diagnostics", label: "设置：故障与诊断", group: "设置页", sizes: PANEL_TIERS },
  { id: "settings-group-docker", label: "设置：Docker 环境", group: "设置页", sizes: PANEL_TIERS },
  { id: "settings-group-deps", label: "设置：依赖更新", group: "设置页", sizes: PANEL_TIERS },
  { id: "settings-group-token", label: "设置：GitHub Token", group: "设置页", sizes: PANEL_TIERS },
  { id: "settings-group-projects", label: "设置：项目页", group: "设置页", sizes: PANEL_TIERS },
  { id: "settings-group-deeplink", label: "设置：浏览器协议（devhub://）", group: "设置页", sizes: PANEL_TIERS },
  { id: "settings-row-wall-sort", label: "设置行：默认排序", group: "设置页", sizes: ROW_TIERS },
  { id: "settings-row-wall-filter", label: "设置行：默认筛选", group: "设置页", sizes: ROW_TIERS },
  { id: "settings-row-wall-density", label: "设置行：卡片密度", group: "设置页", sizes: ROW_TIERS },
  { id: "settings-row-wall-grouped", label: "设置行：按拥有者分段", group: "设置页", sizes: ROW_TIERS },
  { id: "settings-group-interface", label: "设置：界面区块", group: "设置页", sizes: PANEL_TIERS },

  // --- 启动面板 -----------------------------------------------------------
  { id: "project-settings-dialog", label: "项目设置面板", group: "启动面板", sizes: PANEL_TIERS },
  { id: "shell-shortcut-help", label: "快捷键面板", group: "外壳", hint: "F1 打开；列出每个动作的当前和弦并可改绑。" },
  { id: "launch-title", label: "项目面板：标题", group: "启动面板", hint: "点击标题可在浏览器打开仓库页面。", critical: true },
  { id: "launch-action-bar", label: "项目面板：动作条", group: "启动面板", pinnable: true, layoutable: true },
  { id: "launch-action-primary", label: "项目面板：一键启动", group: "启动面板", critical: true },
  { id: "launch-action-terminal", label: "项目面板：打开终端", group: "启动面板" },
  { id: "launch-action-ide", label: "项目面板：打开 IDE", group: "启动面板" },
  { id: "launch-action-copy-path", label: "项目面板：复制路径", group: "启动面板" },
  { id: "launch-run-status", label: "项目面板：运行状态", group: "启动面板", hint: "运行中 / 已挂起 / 已退出的每一行。", critical: true, layoutable: true },
  { id: "launch-command-panel", label: "项目面板：启动命令", group: "启动面板", pinnable: true, sizes: PANEL_TIERS, layoutable: true },
  { id: "launch-output-details", label: "项目面板：运行输出", group: "启动面板", sizes: PANEL_TIERS, layoutable: true },
  { id: "launch-cleanup-section", label: "项目面板：清理与删除", group: "启动面板", sizes: PANEL_TIERS },

  // --- 登记补齐（审计 G3/G16）：以下 id 在 DOM 里真实使用，但此前未登记，
  // 导致 devMode 高亮后点不中、设置→界面不显示。现全部入表。 ---
  { id: "status-seg-download", label: "状态栏：下载段", group: "状态栏" },
  { id: "launch-dialog", label: "项目面板：整个对话框", group: "启动面板" },
  { id: "records-filter", label: "记录：筛选条", group: "记录页" },
  { id: "records-retention-panel", label: "记录：保留时长面板", group: "记录页" },
  { id: "records-stats-panel", label: "记录：统计洞察面板", group: "记录页" },
  { id: "records-storage-overview", label: "记录：存储概览", group: "记录页" },
  { id: "records-license-overview", label: "记录：许可证概览", group: "记录页" },
  { id: "settings-row-search-route", label: "设置：搜索链路", group: "设置页" },
  { id: "settings-row-download-route", label: "设置：下载链路", group: "设置页" },
  { id: "settings-row-clone-strategy", label: "设置：克隆深度策略", group: "设置页" },
  { id: "settings-row-debounce", label: "设置：搜索停顿", group: "设置页" },
  { id: "settings-row-parallel", label: "设置：并行下载数", group: "设置页" },
  { id: "settings-group-interface-list", label: "设置→界面：区块列表", group: "设置页" },
  { id: "settings-group-interface-io", label: "设置→界面：导入导出", group: "设置页" },
  { id: "settings-row-dev-mode", label: "设置→界面：开发者模式开关", group: "设置页" },
  { id: "settings-row-attention", label: "设置→界面：后台完成提示", group: "设置页" },
  { id: "frequent-header", label: "常用页：页头", group: "常用页" },
  { id: "frequent-repos", label: "常用页：固定项", group: "常用页" },
  { id: "frequent-recent", label: "常用页：最近使用", group: "常用页" },
  { id: "frequent-pinned", label: "常用页：跳转卡片", group: "常用页" },
  { id: "frequent-settings", label: "常用页：设置入口", group: "常用页" },
  { id: "appearance-group-size", label: "外观：大小分组", group: "外观页" },
  { id: "appearance-row-font-scale", label: "外观：字号档位", group: "外观页" },
  { id: "appearance-row-font-px", label: "外观：精确字号", group: "外观页" },
  { id: "titlebar-back", label: "标题栏：后退", group: "外壳", hint: "回到上一个界面（Alt+←）。" },
  { id: "titlebar-forward", label: "标题栏：前进", group: "外壳", hint: "重做刚才的后退（Alt+→）。" },
  { id: "titlebar-search", label: "标题栏：全局搜索", group: "外壳", hint: "打开命令面板（Ctrl+K）。" },
  { id: "command-palette", label: "命令面板", group: "外壳", hint: "项目、动作、设置项与记录的统一入口。" },
  { id: "project-row-cover-fit", label: "项目设置：封面取景", group: "启动面板" },
  { id: "project-row-cover-ratio", label: "项目设置：封面比例", group: "启动面板" },
  { id: "project-row-cover-look", label: "项目设置：封面处理", group: "启动面板" },
  { id: "project-row-worktrees", label: "项目设置：工作树面板", group: "启动面板" },
  { id: "project-row-compose", label: "项目设置：Docker 隔离", group: "启动面板" },
  { id: "project-row-worktrees-add", label: "项目设置：新建工作树", group: "启动面板" },
  { id: "appearance-row-ambience", label: "外观：氛围层", group: "外观页", hint: "页面底的纹理与动效档位。" },
  { id: "appearance-row-scale", label: "外观：界面尺度", group: "外观页" },
  { id: "appearance-row-settings-entry", label: "外观：设置入口位置", group: "外观页", hint: "侧边栏底部或标题栏右侧，同一时刻只渲染一个。" },
  { id: "appearance-row-template", label: "外观：模版行", group: "外观页", hint: "已保存的外观模版，每行可应用或重命名。" },
  { id: "appearance-row-density", label: "外观：布局密度", group: "外观页" },
  { id: "appearance-row-grid-columns", label: "外观：项目墙列数", group: "外观页" },
  { id: "appearance-group-theme", label: "外观：主题分组", group: "外观页" },
  { id: "appearance-row-theme", label: "外观：深浅色", group: "外观页" },
  { id: "appearance-row-skin", label: "外观：外观风格", group: "外观页" },
  { id: "appearance-row-font", label: "外观：字体选择", group: "外观页" },
  { id: "appearance-row-font-weight", label: "外观：界面字重", group: "外观页" },
  { id: "appearance-group-content", label: "外观：内容显示分组", group: "外观页" },
  { id: "appearance-row-covers", label: "外观：项目封面图", group: "外观页" },
  { id: "appearance-row-repo-path", label: "外观：卡片完整路径", group: "外观页" },
  { id: "appearance-row-reduce-motion", label: "外观：减弱动画", group: "外观页" },
  { id: "appearance-row-auto-scroll", label: "外观：输出自动滚动", group: "外观页" },
  { id: "appearance-row-hide-desc", label: "外观：描述性文字", group: "外观页" },
  { id: "appearance-row-scrollbar", label: "外观：显示滚动条", group: "外观页" },
  { id: "appearance-group-chrome", label: "外观：界面区块分组", group: "外观页" },
  { id: "appearance-row-show-brand", label: "外观：软件名称开关", group: "外观页" },
  { id: "appearance-row-show-refresh", label: "外观：刷新按钮开关", group: "外观页" },
  { id: "appearance-row-show-status-strip", label: "外观：状态栏开关", group: "外观页" },
  { id: "appearance-row-show-version", label: "外观：版本号开关", group: "外观页" },
  { id: "appearance-row-show-search-block", label: "外观：搜索区块开关", group: "外观页" },
  { id: "appearance-group-templates", label: "外观：模版分组", group: "外观页" },
  { id: "appearance-action-save-template", label: "外观：保存模版", group: "外观页" },
  { id: "appearance-action-import-template", label: "外观：导入模版", group: "外观页" },
  { id: "appearance-action-reset", label: "外观：恢复默认", group: "外观页" },
  { id: "appearance-group-footer", label: "外观：页脚分组", group: "外观页" },
];

/** Fast lookup used everywhere; built once at module load. */
export const ELEMENT_BY_ID: Record<string, ElementDef> = Object.fromEntries(
  ELEMENTS.map((e) => [e.id, e]),
);

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------

export type LayoutRect = { x: number; y: number; w: number; h: number };

// ---------------------------------------------------------------------------
// Free-layout rect contract (审计 G11)
// ---------------------------------------------------------------------------
// Two failure modes used to coexist: the number inputs could store a
// negative w/h that the stylesheet builder then silently dropped (`w > 0`
// gate), and x/y had no bounds at all, so a typo could translate a block
// off the screen with no way back except 清除. Every writer — inputs, drag
// handles, an imported file — now goes through this one clamp. The floors
// match the gesture's (40×20); the ceilings exist so a fat-fingered
// exponent cannot persist a block no viewport can show.
export const LAYOUT_MIN_W = 40;
export const LAYOUT_MIN_H = 20;
const LAYOUT_MAX_W = 8192;
const LAYOUT_MAX_H = 8192;
const LAYOUT_MAX_XY = 4096;

const clampNum = (v: unknown, lo: number, hi: number): number => {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0;
  return Math.min(hi, Math.max(lo, n));
};

/** Coerce any shape into a full, valid rect. Partial input is completed, not preserved. */
export function clampLayout(l: LayoutRect): LayoutRect {
  return {
    x: clampNum(l.x, -LAYOUT_MAX_XY, LAYOUT_MAX_XY),
    y: clampNum(l.y, -LAYOUT_MAX_XY, LAYOUT_MAX_XY),
    w: clampNum(l.w, LAYOUT_MIN_W, LAYOUT_MAX_W),
    h: clampNum(l.h, LAYOUT_MIN_H, LAYOUT_MAX_H),
  };
}

/** What a user (or developer mode) has changed about one element. */
export type ElementOverride = {
  hidden?: boolean;
  /** Only written when the element sits in a flex/grid container. */
  order?: number;
  /** Id from `ElementDef.sizes`. */
  size?: string;
  pinned?: boolean;
  /** Layer 2. */
  layout?: LayoutRect;
  /** Layer 2: raw declarations appended to the element's own rule. */
  css?: string;
};

export function isOverrideEmpty(o: ElementOverride | undefined): boolean {
  if (!o) return true;
  return (
    !o.hidden &&
    o.order === undefined &&
    !o.size &&
    !o.pinned &&
    !o.layout &&
    !(o.css && o.css.trim())
  );
}

// ---------------------------------------------------------------------------
// The trust boundary for every field of an override (r15-correct-8)
// ---------------------------------------------------------------------------

/**
 * `normalise()` already clamped `layout`, and nothing else.
 *
 * That single clamp was chosen because a bad rect shows up on screen. The other
 * fields fail *differently*, which is why they went unnoticed:
 *
 *   - `order` is interpolated straight into the generated stylesheet
 *     (`buildStyleSheet`: `order: ${o.order};`). A hand-edited or foreign file
 *     holding `order: "1; position: fixed; inset: 0"` therefore wrote real CSS
 *     into the app's own stylesheet — the one place in the app that takes a
 *     string from disk and puts it in front of the CSS parser. `css` itself is
 *     already filtered, declaration by declaration, by `sanitizeUserCss`; `order`
 *     was the unfiltered one.
 *   - `usage` was taken as-is, so a `count` that is not a number turns
 *     `prev.count + 1` into NaN forever and a `last` that is not a number breaks
 *     the trimming sort (`b[1] - a[1]` → NaN → an arbitrary 200 keys survive).
 *   - `hidden` / `pinned` were kept as whatever truthy value the file held, so a
 *     `"false"` string hides the block.
 *   - `size` is an id; an unknown one silently produces no tier, and re-checking
 *     it against the registry is what `wall.ts` does for its own stored ids for
 *     exactly that reason.
 *
 * Same shape as `settings-xfer`'s typed table and `wall-xfer`'s re-validation:
 * known fields are coerced to their declared type or dropped, and the dropped
 * count is returned so a caller can say what the file could not carry.
 */
const ORDER_MIN = -1000;
const ORDER_MAX = 1000;

/** A finite integer, or `undefined`. Never a string that the sheet would interpolate. */
export function coerceOrder(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  return Math.max(ORDER_MIN, Math.min(ORDER_MAX, Math.round(v)));
}

function coerceFlag(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

/** One override, rebuilt from whatever the file held. Junk fields are dropped. */
export function coerceOverride(id: string, v: unknown): ElementOverride {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const r = v as Record<string, unknown>;
  const out: ElementOverride = {};
  const hidden = coerceFlag(r.hidden);
  if (hidden !== undefined) out.hidden = hidden;
  const pinned = coerceFlag(r.pinned);
  if (pinned !== undefined) out.pinned = pinned;
  const order = coerceOrder(r.order);
  if (order !== undefined) out.order = order;
  if (typeof r.size === "string" && r.size) {
    const tiers = ELEMENT_BY_ID[id]?.sizes;
    // An element the registry does not know cannot be validated, and dropping
    // its size would lose a preference on the one path where 常用/界面 blocks are
    // added faster than files are re-exported. A *known* element is checked.
    if (!tiers || tiers.some((t) => t.id === r.size)) out.size = r.size;
  }
  if (r.layout && typeof r.layout === "object") out.layout = clampLayout(r.layout as LayoutRect);
  if (typeof r.css === "string" && r.css.trim()) out.css = r.css;
  return out;
}

/** An override map with every entry coerced; entries that became empty are dropped. */
export function coerceOverrides(raw: unknown): Record<string, ElementOverride> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, ElementOverride> = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    const o = coerceOverride(id, v);
    if (!isOverrideEmpty(o)) out[id] = o;
  }
  return out;
}

/**
 * A usage table that arithmetic can be trusted on.
 *
 * `count` must be a non-negative integer and `last` a finite non-negative number,
 * because `recordUsage` adds to the first and the trim sorts on the second.
 * Entries that cannot be coerced are dropped rather than repaired: a statistic
 * whose shape is wrong is not a statistic.
 */
export function coerceUsage(raw: unknown): Record<string, Usage> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, Usage> = {};
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const r = v as Record<string, unknown>;
    const count =
      typeof r.count === "number" && Number.isFinite(r.count) && r.count >= 0
        ? Math.floor(r.count)
        : undefined;
    const last =
      typeof r.last === "number" && Number.isFinite(r.last) && r.last >= 0 ? r.last : undefined;
    if (count === undefined || last === undefined) continue;
    out[key] = { count, last };
  }
  return trimUsage(out);
}

/** Keep the most recently touched keys, newest-first — shared by record and import. */
function trimUsage(usage: Record<string, Usage>): Record<string, Usage> {
  const keys = Object.keys(usage);
  if (keys.length <= MAX_USAGE_KEYS) return usage;
  const byLast = keys
    .map((k) => [k, usage[k]?.last ?? 0] as const)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_USAGE_KEYS);
  const trimmed: Record<string, Usage> = {};
  for (const [k] of byLast) {
    // noUncheckedIndexedAccess：key 与值来自同一份 keys 清单，上面已把
    // 缺席当作 last=0 处理；这里再兜一层，保证写入的永远是完整 Usage。
    const entry = usage[k];
    if (entry) trimmed[k] = entry;
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Usage tracking (feeds 常用 under the pins)
// ---------------------------------------------------------------------------

/**
 * Counts of how often something was touched, with the last time.
 *
 * 常用 is "auto-aggregate as the base, pins float above it", so something has to
 * remember what was actually used. Keys are namespaced strings:
 * `setting:<id>`, `repo:<slug>`, `action:<id>`. Kept in the same record as the
 * layout overrides because they share a lifetime (both are per-device display
 * state) and one write per change is cheaper than two.
 */
export type Usage = { count: number; last: number };

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const STORAGE_KEY = "devhub.customize.v1";

/** Cap so a year of clicking cannot grow the blob without bound. */
const MAX_USAGE_KEYS = 200;

export type Customize = {
  overrides: Record<string, ElementOverride>;
  devMode: boolean;
  /** 侧边栏收纳成图标栏。 Lives here rather than in 外观 because it is a block-level interface fact. */
  sidebarCollapsed: boolean;
  /** 侧边栏拖出来的宽度，px。`0` 表示用档位而不是手动值。 */
  sidebarWidth: number;
  /**
   * What clicking a GitHub search result does.
   *
   * The report asked for all three — jump to the browser, show the README inside
   * the app, and fill the composer — and said the choice should be configurable
   * rather than decided for them. So it is one switch with three positions, and
   * the row still carries the other two as explicit buttons.
   */
  resultClick: "fill" | "browser" | "readme";
  usage: Record<string, Usage>;
  /**
   * 常用页的固定列表，数组顺序即页面展示顺序。
   *
   * 常用项不再只由 usage 统计派生：统计只能记住"你点过什么"，记住不了
   * "你每周只碰一次但绝不能找不到的那个仓库"。与 usage 同条存储通道，因为
   * 它同样是本机显示事实，且导出/导入界面布局时理应随行（像钉选的区块一样）。
   *
   * Round 9 (需求 7) widened the list from repositories to *entries*: a project,
   * a view, or a settings page can each be pinned, so one list can be the whole
   * 常用 page. Entries are prefixed ids (`repo:<slug>` / `view:<id>` /
   * `settings:<id>`); see `settingsCatalog.ts`. The pre-round-9 key
   * (`frequentRepos`, bare slugs) is still read on load and on import, migrated
   * to `repo:` entries by the consumer - renaming the field without that
   * fallback would empty a page the person had arranged.
   */
  frequentEntries: string[];
  /**
   * 设置入口的位置（round 9，需求 10）。
   *
   * The brief asked where a settings button conventionally belongs once 设置
   * stops being a peer of 项目; both answers are defensible, so the entry ships
   * in the sidebar's footer zone by default (the conventional desktop place,
   * separated from the content views) and can be moved to the title bar from
   * 外观 → 界面区块. Whichever is chosen, exactly one renders, and the same
   * `nav-item-settings` registry element gates it - hiding the entry hides it
   * wherever it lives.
   */
  settingsEntry: "footer" | "titlebar";
};

const DEFAULTS: Customize = {
  overrides: {},
  devMode: false,
  sidebarCollapsed: false,
  sidebarWidth: 0,
  resultClick: "fill",
  usage: {},
  frequentEntries: [],
  settingsEntry: "footer",
};

function normalise(raw: unknown): Customize {
  const out: Customize = { ...DEFAULTS };
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Partial<Customize>;
  if (r.overrides && typeof r.overrides === "object") {
    // An imported file is another machine's untrusted JSON. Every field of every
    // entry goes through the same coercion the live writers use, so the
    // stylesheet generator never receives a value it would silently drop (G11)
    // — and never receives a string where a number belongs at all
    // (r15-correct-8, see `coerceOverride`).
    out.overrides = coerceOverrides(r.overrides);
  }
  if (typeof r.devMode === "boolean") out.devMode = r.devMode;
  if (typeof r.sidebarCollapsed === "boolean") out.sidebarCollapsed = r.sidebarCollapsed;
  if (typeof r.sidebarWidth === "number" && Number.isFinite(r.sidebarWidth)) {
    out.sidebarWidth = Math.max(0, Math.round(r.sidebarWidth));
  }
  if (r.resultClick === "fill" || r.resultClick === "browser" || r.resultClick === "readme") {
    out.resultClick = r.resultClick;
  }
  if (r.usage && typeof r.usage === "object") out.usage = coerceUsage(r.usage);
  if (r.settingsEntry === "footer" || r.settingsEntry === "titlebar") {
    out.settingsEntry = r.settingsEntry;
  }
  // Round 9 renamed the field; the old key is still honoured so an existing
  // arrangement survives the upgrade (see the field's doc comment). It is read
  // through a loose view because the current type no longer carries it.
  const loose = r as { frequentRepos?: unknown; frequentEntries?: unknown };
  const legacy = Array.isArray(loose.frequentRepos) ? loose.frequentRepos : [];
  const entries = Array.isArray(loose.frequentEntries) ? loose.frequentEntries : legacy;
  out.frequentEntries = entries.filter((s): s is string => typeof s === "string");
  return out;
}

function load(): Customize {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    return normalise(JSON.parse(raw));
  } catch {
    return { ...DEFAULTS };
  }
}

/**
 * Writes the whole record through the shared coalescing writer.
 *
 * Why (r15-correct-9): the sidebar's drag handle calls `setSidebarWidth` on every
 * `pointermove` (`Sidebar.tsx:183-186`), and `persist` stringified the entire
 * record each time — every block override plus up to 200 `usage` keys — and wrote
 * it synchronously. That is precisely the write storm `src/lib/storage.ts` exists
 * to stop, bypassed because this store never used it: a 60 fps drag is ~60 full
 * serialisations per second, only the last of which can ever be read back.
 *
 * The semantics are the ones `wall.ts` and `appearance.ts` already rely on: one
 * trailing flush per burst, last value wins, and `beforeunload` / `pagehide`
 * commit whatever is pending, so a preference is never lost on quit. A drag that
 * ends mid-gesture still lands.
 */
function persist(c: Customize) {
  try {
    scheduleStorageWrite(STORAGE_KEY, JSON.stringify(c));
  } catch {
    /* circular / unserialisable state: the session keeps its look, like the direct write it replaces */
  }
}

type CustomizeState = Customize & {
  setOverride: (id: string, patch: ElementOverride) => void;
  toggleHidden: (id: string) => void;
  togglePin: (id: string) => void;
  setSize: (id: string, size: string | undefined) => void;
  setOrder: (id: string, order: number | undefined) => void;
  setLayout: (id: string, layout: LayoutRect | undefined) => void;
  setCss: (id: string, css: string | undefined) => void;
  resetElement: (id: string) => void;
  resetAll: () => void;
  /**
   * G5：导入必须走 action 而不是裸 setState —— persist() 只在各 action 内
   * 调用，绕过它意味着导入结果只存在内存里，重启即丢。
   */
  importLayout: (parsed: Partial<Customize>) => void;
  setDevMode: (v: boolean) => void;
  setSidebarCollapsed: (v: boolean) => void;
  setSidebarWidth: (px: number) => void;
  setResultClick: (v: Customize["resultClick"]) => void;
  setSettingsEntry: (v: Customize["settingsEntry"]) => void;
  recordUsage: (key: string) => void;
  clearUsage: () => void;
  addFrequentEntry: (id: string) => void;
  removeFrequentEntry: (id: string) => void;
  /** Drag-sort commit: replaces the whole list in one write. */
  setFrequentEntries: (ids: string[]) => void;
};

export const useCustomize = create<CustomizeState>((set) => {
  /**
   * Every override action used to repeat the same five steps — copy the map,
   * merge a patch, drop the key once nothing is left, persist, return. Seven
   * copies of that sequence is seven places to forget the prune (which is what
   * leaves `{hidden:false}` residue in 设置→界面) or the persist (审计 G5).
   * One write path, seven one-line policies.
   */
  const patchOverride = (id: string, patch: (cur: ElementOverride) => ElementOverride) =>
    set((s) => {
      const overrides = { ...s.overrides };
      const merged = patch(overrides[id] ?? {});
      if (isOverrideEmpty(merged)) delete overrides[id];
      else overrides[id] = merged;
      const next = { ...s, overrides };
      persist(next);
      return next;
    });

  return {
    ...load(),
    setOverride: (id, patch) => patchOverride(id, (cur) => ({ ...cur, ...patch })),
    toggleHidden: (id) => patchOverride(id, (cur) => ({ ...cur, hidden: !cur.hidden })),
    togglePin: (id) => patchOverride(id, (cur) => ({ ...cur, pinned: !cur.pinned })),
    setSize: (id, size) => patchOverride(id, (cur) => ({ ...cur, size })),
    setOrder: (id, order) => patchOverride(id, (cur) => ({ ...cur, order })),
    setLayout: (id, layout) =>
      patchOverride(id, (cur) => ({
        ...cur,
        layout: layout ? clampLayout(layout) : undefined,
      })),
    setCss: (id, css) =>
      patchOverride(id, (cur) => ({ ...cur, css: css && css.trim() ? css : undefined })),
    resetElement: (id) => patchOverride(id, () => ({})),
  resetAll: () =>
    set((s) => {
      const next: Customize = { ...s, overrides: {}, sidebarWidth: 0 };
      persist(next);
      return next;
    }),
  importLayout: (parsed) =>
    set((s) => {
      // normalise 内部做容错与默认值回填；这里再与当前状态合并，保留导入
      // 文件未涵盖的字段（如 usage 统计）。
      const imported: Partial<Customize> = { ...parsed };
      /**
       * Two fields a file never gets to decide (r15-correct-8):
       *
       *   - `devMode`: 开发者模式 is the switch that turns the whole interface
       *     click-to-edit. It used to travel in the export and be applied on
       *     import, so loading someone else's layout silently enabled editing
       *     on this machine — the user then drags something believing they had
       *     always been able to. 常用页的钉选、区块显隐 are layout facts; whether
       *     the app lets you edit it at all is a local decision.
       *   - `usage`: already excluded by `parseLayout`, and enforced here too,
       *     because the action is the boundary that matters — 统计是这台设备自己的
       *     历史，任何入口都不该被一个文件改写。
       */
      delete imported.devMode;
      delete imported.usage;
      const next: Customize = {
        ...s,
        ...imported,
        overrides: coerceOverrides(imported.overrides ?? s.overrides),
      };
      persist(next);
      return next;
    }),
  setDevMode: (v) =>
    set((s) => {
      const next = { ...s, devMode: v };
      persist(next);
      return next;
    }),
  setSidebarCollapsed: (v) =>
    set((s) => {
      const next = { ...s, sidebarCollapsed: v };
      persist(next);
      return next;
    }),
  setSidebarWidth: (px) =>
    set((s) => {
      const next = { ...s, sidebarWidth: px };
      persist(next);
      return next;
    }),
  setResultClick: (v) =>
    set((s) => {
      const next = { ...s, resultClick: v };
      persist(next);
      return next;
    }),
  setSettingsEntry: (v) =>
    set((s) => {
      const next = { ...s, settingsEntry: v };
      persist(next);
      return next;
    }),
  recordUsage: (key) =>
    set((s) => {
      const prev = s.usage[key] ?? { count: 0, last: 0 };
      // A stored `count` that is not a number would poison this key forever
      // (NaN + 1 is NaN) and then survive every later write, so the base is
      // re-checked here rather than trusted from the record — the same rule the
      // import path applies in `coerceUsage` (r15-correct-8).
      const base = Number.isFinite(prev.count) && prev.count >= 0 ? Math.floor(prev.count) : 0;
      const usage = { ...s.usage, [key]: { count: base + 1, last: Date.now() } };
      // Trim to the most recently touched keys rather than letting the blob
      // grow for the life of the install.
      const next = { ...s, usage: trimUsage(usage) };
      persist(next);
      return next;
    }),
  clearUsage: () =>
    set((s) => {
      const next = { ...s, usage: {} };
      persist(next);
      return next;
    }),
  addFrequentEntry: (id) =>
    set((s) => {
      // Idempotent by construction: the pickers filter already-added entries, and
      // a duplicate append here would silently break the display-order contract.
      if (s.frequentEntries.includes(id)) return s;
      const next = { ...s, frequentEntries: [...s.frequentEntries, id] };
      persist(next);
      return next;
    }),
  removeFrequentEntry: (id) =>
    set((s) => {
      const next = { ...s, frequentEntries: s.frequentEntries.filter((x) => x !== id) };
      persist(next);
      return next;
    }),
  setFrequentEntries: (ids) =>
    set((s) => {
      const next = { ...s, frequentEntries: ids };
      persist(next);
      return next;
    }),
  };
});

// ---------------------------------------------------------------------------
// Style sheet generation
// ---------------------------------------------------------------------------

/** Escape an id for use inside an attribute selector. */
function sel(id: string): string {
  return `[data-reg-id="${id.replace(/["\\]/g, "")}"]`;
}

/**
 * G7：用户 CSS 的声明级过滤。
 *
 * 之前 o.css 原样拼进规则体，一个未闭合的大括号就会吞掉它后面所有规则
 * （包括其他元素的 hidden/档位与选中高亮）——「写坏一处、全表失效」。
 * 现在按分号拆开、只保留「属性: 值」形状的声明；含大括号/@规则的片段
 * 整段丢弃。返回剔除的片段数**与片段本身**：过滤此前只在生成样式表时静默
 * 发生，写的人不知道自己的声明被丢了（「没反应」与「被过滤」不可区分），
 * `rejected` 让 Inspector 能把丢掉的东西原样指给人看。
 */
export function sanitizeUserCss(raw: string): {
  clean: string;
  dropped: number;
  rejected: string[];
} {
  const pieces = raw
    .replace(/[{}]/g, ";")
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean);
  const kept: string[] = [];
  const rejected: string[] = [];
  let dropped = 0;
  for (const piece of pieces) {
    if (/^[a-zA-Z-][a-zA-Z0-9-]*\s*:\s*[^;]+$/.test(piece) && !piece.includes("@")) {
      kept.push(piece.endsWith(";") ? piece : `${piece};`);
    } else {
      dropped += 1;
      rejected.push(piece);
    }
  }
  return { clean: kept.join(" "), dropped, rejected };
}

/**
 * Builds the whole customisation stylesheet from the current overrides.
 *
 * Order within a rule is deliberate: size tier, then geometry, then the user's
 * own declarations, so a developer writing `width: 400px` wins over a 档位 that
 * only sets a custom property. `display:none` is `!important` because several
 * blocks set their own display (flex rows, grids) and a plain declaration would
 * lose to them.
 */
/**
 * The generated stylesheet for a set of overrides.
 *
 * Takes only the two fields it reads (`overrides`, `sidebarWidth`) rather than
 * the whole `Customize`: the round-9 rename of `frequentRepos` surfaced that
 * the caller was already passing three fields this function never looked at,
 * and a narrower parameter keeps that honest instead of re-adding a stub.
 */
export function buildStyleSheet(c: Pick<Customize, "overrides" | "sidebarWidth">): string {
  const rules: string[] = [];
  for (const [id, o] of Object.entries(c.overrides)) {
    const def = ELEMENT_BY_ID[id];
    const body: string[] = [];
    if (o.hidden) body.push("display: none !important;");
    // Re-checked here, not only at the trust boundary: this is the one place a
    // stored value is handed to the CSS parser, so the generator refuses anything
    // that is not a finite integer rather than relying on every writer having
    // cooperated (`o.order` used to go into the template verbatim, so a stored
    // string wrote arbitrary declarations). 0 and negatives are real positions.
    const order = coerceOrder(o.order);
    if (order !== undefined) body.push(`order: ${order};`);
    const tier = def?.sizes?.find((t) => t.id === o.size);
    if (tier?.vars) {
      for (const [k, v] of Object.entries(tier.vars)) body.push(`${k}: ${v};`);
    }
    if (tier?.css) body.push(tier.css);
    if (o.layout) {
      body.push("position: relative;");
      if (o.layout.x || o.layout.y) body.push(`transform: translate(${o.layout.x}px, ${o.layout.y}px);`);
      if (o.layout.w > 0) body.push(`width: ${o.layout.w}px;`);
      if (o.layout.h > 0) body.push(`height: ${o.layout.h}px;`);
    }
    // G8：CSS 覆写不再依赖 devMode 开关 —— 与 layout 同语义（写下的东西
    // 一直生效，开发者模式只控制「能否编辑」），消除两套行为不对称。
    if (o.css && o.css.trim()) {
      const { clean } = sanitizeUserCss(o.css);
      if (clean) body.push(clean);
    }
    if (body.length) rules.push(`${sel(id)} { ${body.join(" ")} }`);
  }
  // The sidebar width is a real geometry fact the user drags, so it gets its own
  // rule rather than being smuggled through a 档位.
  if (c.sidebarWidth > 0) {
    rules.push(`${sel("sidebar-rail")} { width: ${c.sidebarWidth}px; min-width: ${c.sidebarWidth}px; }`);
  }
  return rules.join("\n");
}

/**
 * Layer 2 must not silently keep applying once developer mode is off: the
 * stylesheet builder already skips `o.css`, but `o.layout` is kept on purpose —
 * a layout someone dragged is theirs to keep, and dropping it when a switch
 * flips would be the surprising behaviour.
 *
 * Takes a `Pick` of the store, like `pinnedElements` below (r17-o2-1): the only
 * input it walks is `overrides`, so the signature says so and 设置→界面 can
 * subscribe narrowly instead of pulling the whole store down — a usage tick or a
 * sidebar drag must not re-derive (or re-render) this list.
 */
export function elementsWithChanges(c: Pick<Customize, "overrides">): ElementDef[] {
  return ELEMENTS.filter((e) => !isOverrideEmpty(c.overrides[e.id]));
}

// ---------------------------------------------------------------------------
// Component helpers
// ---------------------------------------------------------------------------

/**
 * Spreadable props that put a block in the registry.
 *
 * Deliberately an attribute and not a wrapper element: the codebase already has
 * the shape `[data-repo-path="off"] .repo-path { display: none }` working, and a
 * wrapper would change which node is the flex/grid item in a dozen places.
 */
export function reg(id: string): Record<string, string> {
  return { "data-reg-id": id };
}

/**
 * Everything the user pinned, in registry order.
 *
 * Takes a `Pick` of the store, not the whole `Customize` (r16-o2-4): the only
 * input this walks is `overrides`, so the parameter says so. That is what lets
 * a caller subscribe narrowly — `useCustomize((s) => s.overrides)` — instead of
 * taking the entire store, which re-renders (and re-derives) on every usage
 * tick and every layout drag that has nothing to do with the pinned list.
 */
export function pinnedElements(c: Pick<Customize, "overrides">): ElementDef[] {
  return ELEMENTS.filter((e) => c.overrides[e.id]?.pinned);
}

/** Export / import for 设置 → 界面, so a look can move between machines. */
export function exportLayout(c: Customize): string {
  return JSON.stringify(
    {
      version: 1,
      // `devMode` is deliberately NOT exported (r15-correct-8): it is a statement
      // about what this machine lets the user edit, not part of how the interface
      // is arranged. Shipping it in the file made importing a friend's layout turn
      // on click-to-edit here without asking.
      sidebarCollapsed: c.sidebarCollapsed,
      sidebarWidth: c.sidebarWidth,
      overrides: c.overrides,
      frequentEntries: c.frequentEntries,
      settingsEntry: c.settingsEntry,
    },
    null,
    2,
  );
}

export function parseLayout(text: string): Partial<Customize> | null {
  try {
    const parsed = normalise(JSON.parse(text));
    // Import deliberately does not bring another machine's usage counts along:
    // 常用 should reflect what *this* device has been doing. The pinned repo
    // list is the opposite — it is the user's own curation, so it travels.
    // `devMode` is dropped for the same reason as 统计: whether this app is
    // click-to-edit is decided on this machine, never by a file (r15-correct-8).
    return {
      overrides: parsed.overrides,
      sidebarCollapsed: parsed.sidebarCollapsed,
      sidebarWidth: parsed.sidebarWidth,
      frequentEntries: parsed.frequentEntries,
      settingsEntry: parsed.settingsEntry,
    };
  } catch {
    return null;
  }
}
