/**
 * r18 N1 — the failure history's wiring: who records, and where.
 *
 * The store's own rules are pinned in `failures-store.test.ts`. This file is
 * about the two ends that feed it and (from n1-3) the panel that reads it:
 *
 *   - `reportError` — the single choke point every command failure and the
 *     window-level report path go through. Behavioural, through the real
 *     modules: the contract is "anything the user is told is in the history",
 *     not "these lines exist".
 *   - `main.tsx` — the boot-overlay branch has no toast to ride, so its record
 *     call and the two listener `kind`s are pinned structurally; there is no
 *     DOM in these tests to route a real fatal through.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { installBrowserGlobals } from "./helpers/storage.ts";
import { messageOf, reportError } from "../src/lib/report-error.ts";
import { useFailures } from "../src/store/failures.ts";
import { useToast } from "../src/store/toast.ts";

import { at } from "./helpers/definite.ts";

installBrowserGlobals();

// The toast store arms its dismiss ticker with `window.setInterval` on the first
// push (same stub, and same reason, as `report-error.test.ts`).
(globalThis as { window?: unknown }).window = {
  setInterval: () => 1,
  clearInterval: () => undefined,
};

const MAIN = readFileSync("src/main.tsx", "utf8").replace(/\r\n/g, "\n");

function drain() {
  useFailures.getState().clear();
  useToast.setState({ items: [] });
}

test("reportError: telling the user and recording the history are one act", () => {
  drain();
  reportError("网络错误", "保存失败");
  const entries = useFailures.getState().entries;
  assert.equal(entries.length, 1, "the toast was shown, so the row exists");
  const entry = at(entries, 0);
  assert.equal(entry.kind, "command", "a command rejection defaults to kind command");
  assert.equal(entry.verb, "保存失败");
  assert.equal(entry.text, "网络错误");
  assert.equal(entry.count, 1);
  assert.ok(entry.at > 0, "the store stamps arrival; the caller passes no time");

  const items = useToast.getState().items;
  const last = items[items.length - 1];
  assert.equal(last?.text, "保存失败：网络错误", "the toast sentence is unchanged by recording");
});

test("reportError: the history text is messageOf, not a second prose dialect", () => {
  drain();
  reportError({ code: "outside_root", message: "路径不在项目根目录内" }, "打开失败");
  const entry = at(useFailures.getState().entries, 0);
  assert.equal(entry.text, messageOf({ code: "outside_root", message: "路径不在项目根目录内" }));
  assert.equal(entry.text, "路径不在项目根目录内（outside_root）");
});

test("reportError: window-level kinds pass through to the row", () => {
  drain();
  reportError(new TypeError("boom"), "运行失败", "runtime");
  reportError("late rejection", "调用失败", "rejection");
  const kinds = useFailures.getState().entries.map((e) => e.kind);
  assert.deepEqual(kinds, ["rejection", "runtime"], "newest first, each row wearing its own kind");
});

test("main.tsx: both listeners hand routeFatal a kind instead of the command default", () => {
  assert.match(
    MAIN,
    /routeFatal\(\s*t\("app\.fatal\.runtimeTitle"\),\s*t\("app\.fatal\.runtimeOk"\),\s*reason,\s*"runtime",?\s*\)/,
    "window error events are runtime failures",
  );
  assert.match(
    MAIN,
    /routeFatal\(\s*t\("app\.fatal\.rejectionTitle"\),\s*t\("app\.fatal\.rejectionOk"\),\s*e\.reason,\s*"rejection",?\s*\)/,
    "unhandled rejections are rejections",
  );
  assert.ok(
    MAIN.includes("function routeFatal(title: string, verb: string, reason: unknown, kind: FailureKind): void"),
    "and the signature demands one — a new listener cannot forget it silently",
  );
});

test("main.tsx: the boot overlay records before it paints, without a toast", () => {
  assert.ok(
    MAIN.includes("    recordFailure(kind, verb, messageOf(reason));\n    showFatal(title, reason);"),
    "overlay branch: record first, then replace the page",
  );
  assert.ok(
    MAIN.includes("  reportError(reason, verb, kind);"),
    "report branch: the kind survives the ride through reportError",
  );
});

// ---------------------------------------------------------------------------
// n1-3 — the panel that reads the store, and how it is reachable.

const COMPONENT = readFileSync("src/views/settings/FailureHistorySection.tsx", "utf8").replace(
  /\r\n/g,
  "\n",
);
const CATALOG = readFileSync("src/settingsCatalog.tsx", "utf8").replace(/\r\n/g, "\n");
const SETTINGS_VIEW = readFileSync("src/views/SettingsView.tsx", "utf8").replace(/\r\n/g, "\n");

test("settings: 故障与诊断 is a catalog section with its own icon and page", () => {
  assert.ok(
    CATALOG.includes(
      '{ id: "diagnostics", label: "故障与诊断", icon: <TriangleAlert className="h-3.5 w-3.5" /> },',
    ),
    "the catalog row — the rail, palette and 常用 picker all map this one list",
  );
  assert.ok(
    CATALOG.includes('| "diagnostics"'),
    "the id is in the union the i18n scans read; without it the section key is dead",
  );
  assert.ok(
    SETTINGS_VIEW.includes('{activeSection === "diagnostics" && ('),
    "the settings page renders the page the catalog promises",
  );
  // r21-N2-1 made that branch a fragment: the Docker panel is a *sibling* under
  // the same section, so the pin is the mount + the branch, not the old one-liner.
  const diagnosticsBranch = SETTINGS_VIEW.slice(
    SETTINGS_VIEW.indexOf('{activeSection === "diagnostics" && ('),
  );
  assert.ok(
    diagnosticsBranch.includes("<FailureHistorySection />"),
    "and the failure history panel is still inside it",
  );
});

test("panel: draws the store's live list through the records page's time scale", () => {
  assert.ok(COMPONENT.includes("useFailures((s) => s.entries)"), "live list, not a snapshot");
  assert.ok(COMPONENT.includes("useFailures((s) => s.clear)"), "clear is the store's own action");
  // `at` is epoch ms (the store's unit) and `formatTime` wants seconds — the
  // division is what keeps a row from rendering 1970.
  const conversions = COMPONENT.match(/formatTime\(e\.at \/ 1000, timeFormat\)/g) ?? [];
  assert.ok(conversions.length >= 2, `row and copy line both convert ms→s (found ${conversions.length})`);
  assert.ok(
    COMPONENT.includes("useAppearance((s) => s.recordTimeFormat)"),
    "the 显示时间 setting governs this panel too, like the records page",
  );
});

test("panel: copy and clear behave like their neighbours elsewhere in the app", () => {
  assert.ok(COMPONENT.includes("navigator.clipboard.writeText"), "copy goes through the clipboard");
  assert.ok(
    COMPONENT.includes('t("settings.page.failuresClipboardDenied")'),
    "and the failure copy says where to select the text by hand",
  );
  assert.ok(COMPONENT.includes("confirmDestructive("), "clear is destructive, so it asks first");
  assert.ok(COMPONENT.includes("settings.page.failuresClearConfirm"), "with the failure-specific question");
  for (const kind of ["command", "runtime", "rejection"]) {
    assert.ok(
      COMPONENT.includes(`t("settings.page.failureKind.${kind}")`),
      `${kind} label must stay a literal call site — the dictionary's dead-key scan only follows literals`,
    );
  }
});
