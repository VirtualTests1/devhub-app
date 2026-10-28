/**
 * The one catalog of what a setting is called.
 *
 * Same fact, six spellings — this is what the round-12 audit measured:
 *
 *   | key                   | 记录 (`CONFIG_TARGET_LABEL`) | 常用 (`SETTING_LABEL`) | 设置行 | 后端记录文案 |
 *   |-----------------------|-------------------------------|------------------------|--------|--------------|
 *   | `searchDebounceMs`    | 搜索停顿时间                  | 搜索停顿               | 搜索输入停顿 | 搜索停顿 (`lib.rs:4361`) |
 *   | `cleanupMode`         | 自动清理频率                  | 清理计划               | 自动清理 | 记录清理计划 (`lib.rs:4354`) |
 *   | `activityRetentionDays` | 记录保留时长                | 记录保留               | 保留时长 | 记录保留时长 (`lib.rs:4327`) |
 *   | `parallelDownloads`   | 并行下载数                    | 并行下载               | 同时下载数 | 并行下载数 (`lib.rs:4368`) |
 *
 * Two tables in the frontend plus hand-written titles in the settings pages plus
 * the strings the Rust writes into the record itself. Only the last is unavoidable
 * (it is in the stored `action` text), so the frontend's two tables collapse into
 * this one file and the 设置行 titles are 交接'd to whoever owns those files.
 *
 * ## The naming rule applied here
 *
 * A label travels: it appears in a 记录 row, on a 常用 chip and in a 回退 dialog
 * without the section heading that would have explained it. So each name is the
 * shortest one that still identifies the thing out of context, and never restates
 * the verb the surface already prints (the record says 修改X / 启用X, so `第三方镜像`
 * not `允许第三方镜像`). Where two candidates both fit, the records table won,
 * because a record is read long after the change and needs the unit in the name
 * (`…时长`, `…数`).
 *
 * ## The `ui.*` half is not here
 *
 * Appearance keys already have an exhaustive, typed table — `APPEARANCE_LABEL` in
 * `store/appearance.ts`, `Record<keyof Appearance, string>`, checked by
 * `tests/appearance-value.test.ts` — and a second one would only drift. `views/
 * records/format.ts`'s `displayTarget` is where the two halves are joined; this
 * file stays dependency-free so it can be imported anywhere (that is the same
 * reason `lib/format` has no imports: a `lib/` module that pulled in a store would
 * drag `zustand` and `localStorage` into every test that formats a name).
 *
 * ## Reachability
 *
 * The key set is the backend's undoable-config set (`src-tauri/src/lib.rs:2719`
 * `restore_config_value`) — the keys that can appear as a `config.<key>` activity
 * target — plus three keys that only ever reach a 常用 chip from a legacy
 * `setting:<key>` usage blob. `tests/setting-labels.test.ts` pins both halves.
 */

/** Human-readable name for one config key, as the app calls it everywhere. */
export const CONFIG_TARGET_LABEL: Record<string, string> = {
  projectRoot: "项目目录",
  extraRoots: "附加目录",
  mirrorEnabled: "第三方镜像",
  ipPinEnabled: "IP 钉死",
  proxy: "本地代理",
  githubToken: "GitHub Token",
  searchRoute: "搜索链路",
  downloadRoute: "下载链路",
  searchDebounceMs: "搜索停顿时间",
  parallelDownloads: "并行下载数",
  terminalChoice: "默认终端",
  ideChoice: "默认 IDE",
  activityRetentionDays: "记录保留时长",
  cleanupMode: "自动清理频率",
  cleanupKeepDays: "清理时保留",
};

/** Every config key this catalog names, in table order. */
export const CONFIG_TARGET_KEYS: readonly string[] = Object.keys(CONFIG_TARGET_LABEL);

/**
 * The name of one `config.<key>` target, or `null` when the key is unknown.
 *
 * `null` rather than the raw key: the callers decide how to degrade. A 记录 row
 * prints the key itself (a record must never be unrenderable), while a test can
 * assert that a known key never hits that path.
 */
export function configTargetLabel(key: string): string | null {
  return CONFIG_TARGET_LABEL[key] ?? null;
}
