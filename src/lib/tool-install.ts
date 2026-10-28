/**
 * "缺什么 + 怎么装" for the launch panel's missing-tool warning.
 *
 * REQUIREMENTS §5.1 (the dependency table) promises the UI says not only which
 * tool is missing but how to install it. `LaunchDialog` used to print a bare
 * `缺少：python、node。启动前请先安装` line, which is the "缺什么" half only and
 * leaves a non-developer staring at a tool name with no next step. This module
 * turns each missing label into one actionable row: a winget command (the app is
 * Windows-only, so `winget` is the installer every target machine already has),
 * the official download page to open in the browser, and — where the project's
 * own detection notes declare a version — which version to get.
 *
 * Kept pure (no `openUrl`, no JSX) so the mapping and the version extraction are
 * testable from Node; the dialog supplies the labels it already computed.
 */

export type ToolGuidance = {
  /** The label as it appears in the warning, e.g. `Node.js`. */
  name: string;
  /** One concrete install step the user can copy or read. */
  how: string;
  /** Official page to open, when there is one worth linking. */
  url?: string;
  /** The version the project asks for, if its notes say so. */
  version?: string;
};

/** Static, per-tool install guidance. Windows-only, so `winget` is assumed present. */
const GUIDANCE: Omit<ToolGuidance, "version">[] = [
  {
    name: "Node.js",
    how: "winget install OpenJS.NodeJS.LTS",
    url: "https://nodejs.org/zh-cn/download",
  },
  {
    name: "Python",
    how: "winget install Python.Python.3",
    url: "https://www.python.org/downloads/",
  },
  {
    name: "任意可用 IDE",
    how: "在 设置 → 启动 里手动指定一个编辑器，或安装 VS Code（winget install Microsoft.VisualStudioCode）",
    url: "https://code.visualstudio.com/",
  },
];

/**
 * The version a note declares for a tool, or null.
 *
 * Detection notes are free-form Chinese sentences (`package.json engines 需要
 * node >= 18.0`), so this looks for the note that mentions the tool (by any of
 * its aliases) AND carries a `major.minor[.patch]` token, and returns that token.
 * Returns null when nothing matches rather than inventing a version.
 */
export function versionFromNotes(notes: string[], aliases: string[]): string | null {
  const keys = aliases.map((a) => a.toLowerCase());
  for (const note of notes) {
    const lower = note.toLowerCase();
    if (!keys.some((k) => lower.includes(k))) continue;
    const m = lower.match(/(\d+\.\d+(?:\.\d+)?)/);
    if (m) return m[1] ?? null;
  }
  return null;
}

/** The aliases a note might use to name each tool. */
const ALIASES: Record<string, string[]> = {
  "Node.js": ["node", "npm", "engines"],
  Python: ["python", "py", "venv"],
  "任意可用 IDE": ["ide", "vscode", "编辑器"],
};

/**
 * Guidance rows for the given missing labels, in the order they were requested.
 * A label with no static entry (an unexpected tool) still yields a row so the
 * user is never told "missing" with no path forward — it just has no link.
 */
export function toolGuidanceFor(missing: string[], notes: string[] = []): ToolGuidance[] {
  return missing.map((label) => {
    const base = GUIDANCE.find((g) => g.name === label);
    const version = versionFromNotes(notes, ALIASES[label] ?? [label]);
    const row: ToolGuidance = base ? { ...base } : { name: label, how: "请按项目文档安装该工具" };
    if (version) row.version = version;
    return row;
  });
}
