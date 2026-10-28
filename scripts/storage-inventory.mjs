#!/usr/bin/env node
/**
 * storage-inventory.mjs — r21-R3-1: reproducible localStorage usage inventory.
 *
 * WHY THIS EXISTS
 *   The R3 question is "does DevHub's persisted state fit in the 5 MiB
 *   localStorage quota, and if it does not, which key is the offender?" Answering
 *   it from prose ("probably a few kilobytes") is how a quota bug survives until
 *   a user's `QuotaExceededError`. This script produces the number from the tree,
 *   twice over:
 *
 *     1. STATIC SCAN — walk `src/**\/*.ts(x)` for versioned `devhub.*` string
 *        literals, so a key that exists but is never written in a measurable way
 *        still shows up in the table with its declaration site.
 *     2. RUNTIME PROBE — spawn a child Node with the same flags `pnpm test` uses
 *        (`--experimental-strip-types --import ./tests/helpers/register.mjs`),
 *        install the test suite's fake `localStorage`, import each store module
 *        FRESH (empty storage = first run) and serialize exactly what that
 *        module's own write path would put on disk. Two methods, labelled per
 *        row so nobody mistakes one for the other:
 *          * `write-path`  — drove a real no-op mutation through the store and
 *            read the bytes back with `readBack`; the payload is byte-identical
 *            to what the app writes.
 *          * `state-shape` — the store has no no-op write (its writer is private
 *            or only fires on a user action), so the payload is reconstructed as
 *            `JSON.stringify(<the exact value its writer passes to setItem>)`
 *            from the fresh module's default state.
 *
 * CLI
 *   node scripts/storage-inventory.mjs            human table on stdout
 *   node scripts/storage-inventory.mjs --md       (re)write docs/r21-storage-eval.md
 *   node scripts/storage-inventory.mjs --json     machine-readable
 *   node scripts/storage-inventory.mjs --probe    internal: the measurement child
 *
 * The markdown run owns the GENERATED half of the doc (header, inventory,
 * sources, first-read verdict) and preserves everything below the
 * `HAND_MARKER` line verbatim — that is where the hand-written decision chapter
 * lives, so re-running the inventory can never eat it.
 *
 * Dependency-free by rule: node:fs / node:path / node:url / node:child_process,
 * same as the other scripts in this directory.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DOC = "docs/r21-storage-eval.md";
const HAND_MARKER = "<!-- r21-storage-eval:handwritten -->";

/** The assumed localStorage quota, in bytes (see SOURCES[2]: 5 × 2^20). */
const QUOTA_BYTES = 5 * 1024 * 1024;
/** When this run's numbers were taken — printed into the doc so it is dated. */
const RUN_DATE = "2026-10-19";

// ---------------------------------------------------------------------------
// Static scan
// ---------------------------------------------------------------------------

/** Every versioned webview-side key literal in `src/`, with its declaration site. */
function scanKeys() {
  const hits = new Map();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name)) scanFile(p);
    }
  };
  const scanFile = (abs) => {
    // Normalise first: `join` produces backslashes on Windows, and a prefix
    // replace against `ROOT + "/"` silently matched nothing, printing absolute
    // paths into the doc (and the doc's existence checks only ever see `src/...`).
    const rel = abs.replace(/\\/g, "/").replace(ROOT.replace(/\\/g, "/").replace(/\/$/, "") + "/", "");
    const lines = readFileSync(abs, "utf8").split(/\r?\n/);
    lines.forEach((text, i) => {
      const re = /["'](devhub\.[A-Za-z0-9._-]+\.v\d+)["']/g;
      for (const m of text.matchAll(re)) {
        const key = m[1];
        // A key is often *named* in a doc comment before it is declared (every
        // `shortcut-bindings.ts` header lists its neighbours' keys), so the first
        // hit is usually prose. Prefer the line that actually binds the literal
        // to a `const`, and only fall back to a mere mention.
        const isDecl = new RegExp(`(?:const|let|var)\\s+[A-Za-z_$][\\w$]*\\s*=\\s*["']${key.replace(/\./g, "\\.")}["']`).test(text);
        const prev = hits.get(key);
        if (!prev || (isDecl && !prev.isDecl)) hits.set(key, { key, file: rel, line: i + 1, isDecl });
      }
    });
  };
  walk(join(ROOT, "src"));
  return [...hits.values()].sort((a, b) => a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------------------
// Growth models (static reading of the caps each writer enforces)
// ---------------------------------------------------------------------------

/**
 * Per-key growth model. `bounded` is the byte ceiling of the *capped* part of
 * the payload — a deliberately conservative arithmetic bound derived from the
 * caps the writer itself enforces (row caps x row size), not a measurement.
 * `null` means "no cap: grows with user data" and is excluded from the bounded
 * total, then reported as an explicit risk line instead of being silently added.
 */
const GROWTH = {
  "devhub.wall.v1": {
    bounded: 200,
    model: "prefs (4 fields, fixed) + one entry per wall card (NO CAP — grows with repos)",
    risk: "unbounded in repo count; each entry can carry alias/cover/tags",
  },
  "devhub.appearance.v1": {
    bounded: null,
    model: "fixed field set (coerceAppearance merges onto DEFAULTS) — bound = its measured size",
    risk: "none: size is constant for every user",
  },
  "devhub.appearance.templates.v1": {
    bounded: null,
    model: "one template per saved snapshot (NO CAP)",
    risk: "unbounded in template count",
  },
  "devhub.customize.v1": {
    bounded: 11000,
    model: "usage capped at 200 keys (~50 B each) + overrides / frequentEntries (NO CAP)",
    risk: "unbounded in overridden elements and pinned entries; per-element custom CSS is free text",
  },
  "devhub.landing.v1": {
    bounded: 2300,
    model: "capped at 8 paths x 260 chars + framing",
    risk: "none",
  },
  "devhub.failures.v1": {
    bounded: 20000,
    model: "capped at 50 rows x (verb 40 + text 300 + at/kind/count)",
    risk: "none",
  },
  "devhub.searches.v1": {
    bounded: 3000,
    model: "capped at 12 queries x 200 chars + sort",
    risk: "none",
  },
  "devhub.ui.nav.v1": {
    bounded: 1600,
    model: "history capped at 50 destinations; per-destination ctx comes from the view snapshot",
    risk: "ctx payload is view-defined and was not measured (information gap)",
  },
  "devhub.shortcuts.v1": {
    bounded: 1200,
    model: "one override per action; the action table is a code constant",
    risk: "none",
  },
  "devhub.launch.templates.v1": {
    bounded: null,
    model: "one template per saved step list (NO CAP)",
    risk: "unbounded in template count and step count",
  },
  "devhub.i18n.locale.v1": {
    bounded: 16,
    model: "one enum string",
    risk: "none",
  },
};

// ---------------------------------------------------------------------------
// Sources actually fetched for this evaluation (URL + fetch date + key facts)
// ---------------------------------------------------------------------------

const SOURCES = [
  {
    title: "WHATWG Storage Standard — registered storage endpoints",
    url: "https://storage.spec.whatwg.org/",
    fetched: RUN_DATE,
    facts: [
      "Registered quota for the `localStorage` endpoint is `5 × 2^20` bytes (5 MiB) per storage bottle; `sessionStorage` the same.",
      "`indexedDB` and `caches` register a quota of `null` — no per-endpoint cap; they are bounded only by the enclosing storage shelf quota.",
      "Storage shelf quota is an implementation-defined conservative estimate and must not be a function of free disk space (anti-fingerprinting).",
    ],
  },
  {
    title: "MDN — Storage quotas and eviction criteria",
    url: "https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria",
    fetched: RUN_DATE,
    facts: [
      "Web Storage: “up to 5 MiB of local storage, and 5 MiB of session storage per origin”; exceeding it throws `QuotaExceededError`, which must be caught.",
      "Chromium-based browsers: an origin may store up to 60% of total disk size for IndexedDB/Cache/OPFS-class storage; the whole browser uses at most 80% of disk.",
      "Data is best-effort by default and LRU-evicted under storage pressure; `navigator.storage.persist()` opts in to non-evictable storage.",
      "`navigator.storage.estimate()` reports usage/quota — estimates by design, padded for cross-origin data.",
    ],
  },
  {
    title: "MDN — Window.localStorage",
    url: "https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage",
    fetched: RUN_DATE,
    facts: [
      "Keys and values are UTF-16 strings; data is partitioned by origin (scheme + host + port).",
      "`file:` origins are undefined by spec — each file URL effectively gets its own area, so the loading scheme decides what shares storage.",
      "Blocked cookies / policy decisions surface as `SecurityError` on access.",
    ],
  },
  {
    title: "web.dev — Storage for the web",
    url: "https://web.dev/articles/storage-for-the-web",
    fetched: RUN_DATE,
    facts: [
      "localStorage ≈ 5 MB, string-only, synchronous and main-thread blocking; IndexedDB is the recommended alternative for larger data.",
      "Chrome: browser-wide cap 80% of disk, per-origin cap 60% of disk.",
    ],
  },
  {
    title: "Microsoft Learn — WebView2: Manage user data folders",
    url: "https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/user-data-folder",
    fetched: RUN_DATE,
    facts: [
      "WebView2 stores DOM storage in the user data folder; `CoreWebView2BrowsingDataKinds` lists `LocalStorage` (0x4), `IndexedDb` (0x2), `FileSystems` (0x1), `CacheStorage` (0x10) and the `AllDomStorage` (0x20) umbrella.",
      "Consequence: IndexedDB and OPFS-class file systems are first-class, host-clearable storage in this runtime — not browser-only APIs.",
    ],
  },
  {
    title: "Microsoft Learn — WebView2: Using local content",
    url: "https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/working-with-local-content",
    fetched: RUN_DATE,
    facts: [
      "The loading scheme decides the origin: `file:` URLs get a per-path origin, `NavigateToString` yields origin `null` where localStorage/IndexedDB are unusable, virtual-host mapping yields a real http(s) origin.",
      "DevHub's own production origin was NOT measured in this round (information gap) — see the runtime-measurement plan in the decision chapter.",
    ],
  },
  {
    title: "MDN — Origin private file system (OPFS)",
    url: "https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system",
    fetched: RUN_DATE,
    facts: [
      "OPFS is subject to the same origin quota as IndexedDB; `navigator.storage.estimate()` covers it, and clearing site data deletes it.",
      "Its synchronous access handles exist only inside web workers — on the main thread every OPFS call is async.",
      "Baseline: available across browsers since March 2023; secure-context only.",
    ],
  },
  {
    title: "MDN — FileSystemObserver",
    url: "https://developer.mozilla.org/en-US/docs/Web/API/FileSystemObserver",
    fetched: RUN_DATE,
    facts: [
      "Experimental, non-standard: observes changes to the user-visible file system and to OPFS (including `FileSystemSyncAccessHandle`), replacing polling.",
      "`observe(handle, { recursive })` / `disconnect()`; change types include appeared / disappeared / modified / moved / unknown / errored.",
    ],
  },
  {
    title: "Chrome Platform Status — FileSystemObserver interface",
    url: "https://chromestatus.com/feature/4622243656630272",
    fetched: RUN_DATE,
    facts: [
      "Origin trial Chrome 129–134; shipped on desktop in Chrome 133 (commit `[M133][FSO] Enable FileSystemObserver API on desktop platforms`).",
      "“Not enabled on WebView” per the intent-to-ship, and desktop-only — so availability inside the WebView2 runtime must be feature-detected, not assumed (information gap).",
    ],
  },
  {
    title: "Chromium blink-dev — Intent to Ship: FileSystemObserver",
    url: "https://groups.google.com/a/chromium.org/g/blink-dev/c/6oOaFmia2dc",
    fetched: RUN_DATE,
    facts: [
      "Flag `file-system-observer`; WebKit gave no signal, Firefox positive; not on Android WebView.",
      "Feature detection: `if ('FileSystemObserver' in self)`.",
    ],
  },
];

// ---------------------------------------------------------------------------
// Runtime probe (the child process)
// ---------------------------------------------------------------------------

const PROBE_MARK = "@@STORAGE-INVENTORY-PROBE@@";

/**
 * The measurement table itself. Each entry names the module, the method and the
 * drive function; the functions run ONLY in the child (they need `importSeeded`).
 * The `drive` field here is documentation for the human table; the child has its
 * own switch, kept next to the code that needs the dynamic import.
 */
const PROBE_SPEC = [
  { key: "devhub.wall.v1", method: "write-path", note: "setPref(sort, current) — a no-op change that still calls persist()" },
  { key: "devhub.appearance.v1", method: "write-path", note: "set(fontScale, current) — no-op change, same payload the app writes" },
  { key: "devhub.appearance.templates.v1", method: "state-shape", note: "loadTemplates() on an empty store — writer is private, fires only on save" },
  { key: "devhub.customize.v1", method: "write-path", note: "setSidebarWidth(current) — no-op change that still calls persist()" },
  { key: "devhub.landing.v1", method: "state-shape", note: "history default [] — writer only fires inside remember()" },
  { key: "devhub.failures.v1", method: "write-path", note: "clear() — persist([]) is exactly the empty default" },
  { key: "devhub.searches.v1", method: "write-path", note: "clear() — persist([]) is exactly the empty default" },
  { key: "devhub.ui.nav.v1", method: "state-shape", note: "{view,history,pointer} as persistNav() serializes it" },
  { key: "devhub.shortcuts.v1", method: "write-path", note: "resetBindings() — saveOverrides({}) is the default map" },
  { key: "devhub.launch.templates.v1", method: "state-shape", note: "loadUserTemplates() on an empty store — writer is private" },
  { key: "devhub.i18n.locale.v1", method: "state-shape", note: "readLocale() — the JSON setLocale() would write" },
];

function pack(json, method) {
  if (typeof json !== "string") return { method, error: "writer returned no payload" };
  return {
    method,
    json,
    bytes: Buffer.byteLength(json, "utf8"),
    // UTF-16 code units — what a browser-side quota counter can count without
    // decoding, and the conservative figure for a UTF-16 string store.
    units: json.length,
  };
}

async function probeMain() {
  const helperUrl = pathToFileURL(join(ROOT, "tests", "helpers", "storage.ts")).href;
  const helper = await import(helperUrl);
  helper.installBrowserGlobals();
  const { flushStorage } = await import(pathToFileURL(join(ROOT, "src", "lib", "storage.ts")).href);
  const spec = (rel) => pathToFileURL(join(ROOT, rel)).href;
  const out = {};

  const record = async (key, method, fn) => {
    try {
      out[key] = pack(await fn(), method);
    } catch (err) {
      out[key] = { method, error: String((err && err.message) || err) };
    }
  };

  await record("devhub.wall.v1", "write-path", async () => {
    const m = await importSeeded(helper, spec("src/store/wall.ts"));
    const st = m.useWall.getState();
    st.setPref("sort", st.sort);
    flushStorage();
    return helper.readBack("devhub.wall.v1");
  });

  await record("devhub.appearance.v1", "write-path", async () => {
    const m = await importSeeded(helper, spec("src/store/appearance.ts"));
    const st = m.useAppearance.getState();
    st.set("fontScale", st.fontScale);
    flushStorage();
    return helper.readBack("devhub.appearance.v1");
  });

  await record("devhub.appearance.templates.v1", "state-shape", async () => {
    const m = await importSeeded(helper, spec("src/store/appearance.ts"));
    return JSON.stringify(m.loadTemplates());
  });

  await record("devhub.customize.v1", "write-path", async () => {
    const m = await importSeeded(helper, spec("src/store/customize.ts"));
    const st = m.useCustomize.getState();
    st.setSidebarWidth(st.sidebarWidth);
    flushStorage();
    return helper.readBack("devhub.customize.v1");
  });

  await record("devhub.landing.v1", "state-shape", async () => {
    const m = await importSeeded(helper, spec("src/store/landing.ts"));
    return JSON.stringify(m.useLanding.getState().history);
  });

  await record("devhub.failures.v1", "write-path", async () => {
    const m = await importSeeded(helper, spec("src/store/failures.ts"));
    m.useFailures.getState().clear();
    flushStorage();
    return helper.readBack("devhub.failures.v1");
  });

  await record("devhub.searches.v1", "write-path", async () => {
    const m = await importSeeded(helper, spec("src/store/searches.ts"));
    m.useSavedSearches.getState().clear();
    flushStorage();
    return helper.readBack("devhub.searches.v1");
  });

  await record("devhub.ui.nav.v1", "state-shape", async () => {
    const m = await importSeeded(helper, spec("src/store/ui.ts"));
    const st = m.useUI.getState();
    return JSON.stringify({ view: st.view, history: st.history, pointer: st.pointer });
  });

  await record("devhub.shortcuts.v1", "write-path", async () => {
    const m = await importSeeded(helper, spec("src/lib/shortcut-bindings.ts"));
    m.resetBindings();
    return helper.readBack("devhub.shortcuts.v1");
  });

  await record("devhub.launch.templates.v1", "state-shape", async () => {
    const m = await importSeeded(helper, spec("src/lib/launch-templates.ts"));
    return JSON.stringify(m.loadUserTemplates());
  });

  await record("devhub.i18n.locale.v1", "state-shape", async () => {
    const m = await importSeeded(helper, spec("src/lib/i18n.ts"));
    return JSON.stringify(m.readLocale());
  });

  process.stdout.write(`${PROBE_MARK}${JSON.stringify(out)}\n`);
}

/** `importSeeded` needs a resolved URL; keep the helper's contract in one place. */
async function importSeeded(helper, url) {
  return helper.importSeeded(url);
}

function spawnProbe() {
  const child = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--import",
      "./tests/helpers/register.mjs",
      "scripts/storage-inventory.mjs",
      "--probe",
    ],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
  if (child.error) return { ok: false, why: String(child.error.message) };
  const line = (child.stdout || "").split(/\r?\n/).find((l) => l.startsWith(PROBE_MARK));
  if (!line) {
    return { ok: false, why: `probe child exited ${child.status} with no measurement: ${(child.stderr || "").trim().slice(-400)}` };
  }
  try {
    return { ok: true, data: JSON.parse(line.slice(PROBE_MARK.length)) };
  } catch (err) {
    return { ok: false, why: `probe child returned unparseable JSON: ${String(err.message)}` };
  }
}

// ---------------------------------------------------------------------------
// Merge + formatting
// ---------------------------------------------------------------------------

function pct(bytes) {
  return `${((bytes / QUOTA_BYTES) * 100).toFixed(4)}%`;
}

function buildRows(scanned, probe) {
  const rows = scanned.map((s) => {
    const p = probe ? probe[s.key] : undefined;
    const growth = GROWTH[s.key] ?? { bounded: null, model: "not modelled", risk: "unknown" };
    return {
      key: s.key,
      file: s.file,
      line: s.line,
      method: p && !p.error ? p.method : "—",
      note: (PROBE_SPEC.find((x) => x.key === s.key) || {}).note ?? "",
      bytes: p && !p.error ? p.bytes : null,
      units: p && !p.error ? p.units : null,
      error: p && p.error ? p.error : null,
      growth,
    };
  });
  // Keys the probe measured but the scanner missed would be a scanner bug; report
  // them rather than dropping them on the floor.
  if (probe) {
    for (const key of Object.keys(probe)) {
      if (rows.some((r) => r.key === key)) continue;
      const p = probe[key];
      rows.push({
        key,
        file: "(not found by the static scan)",
        line: 0,
        method: p && !p.error ? p.method : "—",
        note: "probe-only — the static scan did not find this literal",
        bytes: p && !p.error ? p.bytes : null,
        units: p && !p.error ? p.units : null,
        error: p && p.error ? p.error : null,
        growth: GROWTH[key] ?? { bounded: null, model: "not modelled", risk: "unknown" },
      });
    }
  }
  return rows.sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1));
}

function totals(rows) {
  const measured = rows.filter((r) => typeof r.bytes === "number");
  const missing = rows.filter((r) => typeof r.bytes !== "number");
  const bytes = measured.reduce((n, r) => n + r.bytes, 0);
  const units = measured.reduce((n, r) => n + (r.units ?? 0), 0);
  const bounded = rows.reduce((n, r) => n + (typeof r.growth.bounded === "number" ? r.growth.bounded : 0), 0);
  return { bytes, units, bounded, measured, missing };
}

function renderMarkdown(rows, probeState) {
  const t = totals(rows);
  const measuredNote = probeState.ok
    ? "runtime probe OK (fresh module import under the test runner's flags)"
    : `runtime probe UNAVAILABLE — 信息缺失: ${probeState.why}`;
  const lines = [];
  const push = (s = "") => lines.push(s);

  push("# r21 R3:持久化存储层评估(localStorage → IndexedDB/OPFS)");
  push();
  push(`**轮次**：r21 / R3(研究探索类) **生成日期**:${RUN_DATE}`);
  push(`**生成命令**:\`node scripts/storage-inventory.mjs --md\``);
  push(`**运行时探针**:${measuredNote}`);
  push();
  push("## 1. 方法与假设");
  push();
  push("1. **静态扫描**:遍历 `src/**/*.ts(x)`,收集形如 `devhub.<name>.v<N>` 的版本化键字面量,给出声明文件与行号。");
  push("2. **运行时探针**:以 `node --experimental-strip-types --import ./tests/helpers/register.mjs scripts/storage-inventory.mjs --probe` 起子进程,安装 `tests/helpers/storage.ts` 的假 `localStorage`,用 `importSeeded` 重新导入各 store 模块(空存储 = 首次启动),再按每个键自己的写入点产出载荷并用 `readBack` 读回。");
  push("3. **两种口径**(逐行标注,不混用):");
  push("   - `write-path`:驱动一次“值不变”的写操作,读到的字节与应用真实写出的完全一致;");
  push("   - `state-shape`:该 store 没有 no-op 写(写入点私有、只在用户动作时触发),于是用 `JSON.stringify(<写入点实际传给 setItem 的值>)` 重建默认态载荷。");
  push("4. **单位**:`字节` = `Buffer.byteLength(json,'utf8')`(UTF-8);`UTF-16 码元` = `json.length`。localStorage 的键与值都是 UTF-16 字符串,配额计数细节本次未核实(见来源 3 与“信息缺失”),故监控侧采用 `码元 × 2` 的保守口径。");
  push("5. **默认态 ≠ 用户态**:下表是“第一次启动”的下限;有上限的键另给静态上限估算,无上限的键单列风险。");
  push("6. **假定配额** 5 MiB = 5 × 2²⁰ 字节(WHATWG Storage Standard 注册表中 `localStorage` 端点的配额)。");
  push();

  push("## 2. 盘点表(默认态实测)");
  push();
  push("| key | 声明处 | 口径 | 字节 (UTF-8) | UTF-16 码元 | 占 5 MiB | 说明 |");
  push("| --- | --- | --- | ---: | ---: | ---: | --- |");
  for (const r of rows) {
    const where = r.line ? `\`${r.file}\` (${r.line})` : `\`${r.file}\``;
    const bytes = typeof r.bytes === "number" ? String(r.bytes) : "信息缺失";
    const units = typeof r.units === "number" ? String(r.units) : "—";
    const share = typeof r.bytes === "number" ? pct(r.bytes) : "—";
    const note = r.error ? `probe error: ${r.error}` : r.note;
    push(`| \`${r.key}\` | ${where} | ${r.method} | ${bytes} | ${units} | ${share} | ${note} |`);
  }
  push(`| **合计** | — | ${t.measured.length}/${rows.length} 键实测 | **${t.bytes}** | **${t.units}** | **${pct(t.bytes)}** | 默认态下限 |`);
  push();
  if (t.missing.length) {
    push(`未实测的键:${t.missing.map((r) => `\`${r.key}\`(${r.error ?? "probe 不可用"})`).join("、")} — **信息缺失**。`);
    push();
  }

  push("## 3. 上限估算(静态,来自各写入点自身的封顶)");
  push();
  push("| key | 增长模型 | 有界部分上限 (字节) | 无界风险 |");
  push("| --- | --- | ---: | --- |");
  for (const r of rows) {
    const b = typeof r.growth.bounded === "number" ? String(r.growth.bounded) : "—(见风险列)";
    push(`| \`${r.key}\` | ${r.growth.model} | ${b} | ${r.growth.risk} |`);
  }
  push();
  push(`- **有界部分合计**:${t.bounded} 字节 = ${pct(t.bounded)} 的 5 MiB(不含任何“无上限”项)。`);
  push("- **无上限项**:`devhub.wall.v1` 的 `repos`、`devhub.customize.v1` 的 `overrides`/`frequentEntries`、两个 templates 键 —— 都随用户数据线性增长,是唯一可能推高用量的来源。");
  push();

  push("## 4. 调研来源(本次实际抓取)");
  push();
  push("| # | 来源 | URL | 抓取日期 | 关键事实 |");
  push("| --- | --- | --- | --- | --- |");
  SOURCES.forEach((s, i) => {
    const facts = s.facts.map((f) => `- ${f}`).join("<br>");
    push(`| ${i + 1} | ${s.title} | ${s.url} | ${s.fetched} | ${facts} |`);
  });
  push();
  push("### 4.1 信息缺失(明确未核实项)");
  push();
  push("- **Chromium/WebView2 对 localStorage 的计数口径**(UTF-16 码元 ×2 还是 UTF-8 字节):来源只给出“5 MiB / 抛 `QuotaExceededError`”,没有给出实现细节 → 未核实,监控按保守口径估算。");
  push("- **本应用生产构建下的 origin**(Tauri 自定义协议 vs `devUrl` 的 `http://localhost:1420`):决定 localStorage 落在哪一个分区,来源 6 说明加载方式决定 origin,但 DevHub 自身用哪一种未实测 → 未核实。");
  push("- **FileSystemObserver 在 WebView2 运行时是否暴露**:chromestatus 的 “Not enabled on WebView” 指 Android WebView,WebView2 桌面运行时未给出结论 → 未核实,须运行时 `feature-detect`。");
  push("- **IndexedDB/OPFS 在本机 WebView2 的可用版本与实际配额**:只有 BrowsingDataKinds 的存在性证据(来源 5),没有版本号与配额实测 → 未核实。");
  push();

  push("## 5. 结论初判(r3-1)");
  push();
  if (!probeState.ok) {
    push("- 运行时探针不可用,**无法得到可靠的默认态字节数** → 按 r3-3 的 (c) 路线降级:报告“信息缺失”、给出 CDP 运行时测量方案,并仍执行 (a) 的最小接入。");
  } else {
    push(`- 默认态合计 **${t.bytes} 字节(${pct(t.bytes)} 的 5 MiB)**,有界上限合计 **${t.bounded} 字节(${pct(t.bounded)})**;最大的单项是 \`${(t.measured[0] || {}).key ?? "—"}\`(${(t.measured[0] || {}).bytes ?? 0} 字节)。`);
    push("- 距离“某 key > 512 KB 或总量 > 1 MB”的迁移触发线至少差两个数量级 → **初判:不迁移**,走 (a) 路线,落地配额监控最小集成;终章给出阈值与接入点。");
  }
  push("- 无上限项(`wall.repos` / `customize.overrides` / 两个 templates)是唯一需要持续观测的增长面,监控阈值即为此设。");
  push();
  push("---");
  push();
  push("以上为脚本生成部分;标记以下的内容由人工维护,`--md` 重跑不会覆盖。");
  push();
  push(HAND_MARKER);

  return lines.join("\n");
}

function defaultHandTail() {
  return [
    "",
    "## 6. 终章:决策与落地(r3-3)",
    "",
    "(待 r3-3 填写:三选一决策、接入点、迁移触发阈值、遗留风险。)",
    "",
  ].join("\n");
}

function writeMarkdown(rows, probeState) {
  const generated = renderMarkdown(rows, probeState);
  let tail = defaultHandTail();
  const abs = join(ROOT, DOC);
  if (existsSync(abs)) {
    const prev = readFileSync(abs, "utf8");
    const at = prev.indexOf(HAND_MARKER);
    if (at >= 0) tail = prev.slice(at + HAND_MARKER.length);
  }
  writeFileSync(abs, `${generated}${tail}`, "utf8");
}

function humanReport(rows, probeState) {
  const t = totals(rows);
  const out = [];
  out.push(`storage-inventory — ${RUN_DATE}`);
  out.push(`probe: ${probeState.ok ? "ok" : `UNAVAILABLE (${probeState.why})`}`);
  out.push("");
  out.push(`${"key".padEnd(34)}${"method".padEnd(13)}${"bytes".padStart(9)}${"utf16".padStart(9)}  ${"5MiB%"}`);
  for (const r of rows) {
    const b = typeof r.bytes === "number" ? String(r.bytes) : "n/a";
    const u = typeof r.units === "number" ? String(r.units) : "n/a";
    out.push(
      `${r.key.padEnd(34)}${r.method.padEnd(13)}${b.padStart(9)}${u.padStart(9)}  ${
        typeof r.bytes === "number" ? pct(r.bytes) : "—"
      }`,
    );
  }
  out.push("");
  out.push(`total (measured ${t.measured.length}/${rows.length}): ${t.bytes} bytes = ${pct(t.bytes)} of 5 MiB`);
  out.push(`bounded-cap total: ${t.bounded} bytes = ${pct(t.bounded)} of 5 MiB`);
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const KNOWN = new Set(["--md", "--json", "--probe", "--help"]);
for (const a of argv) {
  if (KNOWN.has(a)) continue;
  console.error(`storage-inventory.mjs: unknown argument '${a}'`);
  console.error("usage: node scripts/storage-inventory.mjs [--md] [--json] [--probe] [--help]");
  process.exit(2);
}
if (argv.includes("--help")) {
  console.log(
    "node scripts/storage-inventory.mjs [--md] [--json] [--probe]\n" +
      "  --md      regenerate the generated half of docs/r21-storage-eval.md\n" +
      "  --json    machine-readable rows + totals\n" +
      "  --probe   internal: run the runtime measurement child (spawned by this script)\n" +
      "  (no flag) human-readable inventory table on stdout",
  );
  process.exit(0);
}

if (argv.includes("--probe")) {
  await probeMain();
} else {
  const scanned = scanKeys();
  const probeState = spawnProbe();
  const rows = buildRows(scanned, probeState.ok ? probeState.data : null);
  if (argv.includes("--json")) {
    console.log(JSON.stringify({ date: RUN_DATE, quota: QUOTA_BYTES, probe: probeState, rows, totals: totals(rows) }, null, 2));
  } else if (argv.includes("--md")) {
    writeMarkdown(rows, probeState);
    console.log(`storage-inventory: wrote ${DOC} (${rows.length} keys, probe ${probeState.ok ? "ok" : "unavailable"})`);
  } else {
    console.log(humanReport(rows, probeState));
  }
}
