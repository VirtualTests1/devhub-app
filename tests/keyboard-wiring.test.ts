/**
 * Wiring guards for the keyboard/IME fixes (r35-E).
 *
 * The repo's Node runner cannot import `.tsx`, so the *behaviour* that can live
 * in a pure module is tested elsewhere (`sidebar-order.test.ts`, `ime.test.ts`).
 * These assertions pin the parts that only exist as JSX: a removed `role`,
 * `tabIndex`, key handler or composition guard would otherwise regress silently.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

test("StatusCard: a double-click target is also a keyboard button", () => {
  const src = read("src/components/StatusCard.tsx");
  assert.match(src, /role=\{interactive \? "button" : undefined\}/);
  assert.match(src, /tabIndex=\{interactive \? 0 : undefined\}/);
  assert.match(src, /e\.key !== "Enter" && e\.key !== " "/);
  assert.match(src, /aria-keyshortcuts=\{interactive \? "Enter Space" : undefined\}/);
});

test("Sidebar: Alt+Up/Down is wired to the same persisted order as drag", () => {
  const src = read("src/shell/Sidebar.tsx");
  assert.match(src, /aria-keyshortcuts="Alt\+ArrowUp Alt\+ArrowDown"/);
  assert.match(src, /moveByKeyboard\(item\.id, -1, ev\)/);
  assert.match(src, /moveByKeyboard\(item\.id, 1, ev\)/);
  assert.match(src, /next\.forEach\(\(n, p\) => setOrder\(n\.regId, p\)\)/);
});

test("dialogs and the command palette ignore keys while an IME is composing", () => {
  for (const file of ["src/components/DialogShell.tsx", "src/components/CommandPalette.tsx"]) {
    const src = read(file);
    assert.match(src, /isImeComposing\(e\)/, `${file}: Escape during composition must not close`);
  }
});
