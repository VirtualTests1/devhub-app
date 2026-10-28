/**
 * The key map's pure half (r20-N1-1).
 *
 * Pinned here rather than in a browser scenario because every one of these failures
 * is silent in the UI: a chord that parses wrong simply never fires, a conflict makes
 * one action win by listener order, and a missing `allowInField` gate eats a keystroke
 * the user meant for the 搜索项目 box.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { SHORTCUT_ACTIONS } from "../src/lib/shortcut-actions.ts";
import {
  chordFromEvent,
  findConflicts,
  formatChord,
  isTextField,
  matchAction,
  matchesChord,
  parseChord,
  resolveBindings,
} from "../src/lib/shortcuts.ts";

import { atKey } from "./helpers/definite.ts";

test("parseChord: modifiers in any order canonicalise to the same chord", () => {
  const a = parseChord("shift+ctrl+k");
  const b = parseChord("Ctrl+Shift+K");
  assert.ok(a && b);
  assert.equal(formatChord(a), "Ctrl+Shift+K");
  assert.equal(formatChord(b), "Ctrl+Shift+K");
});

test("parseChord: junk is refused instead of thrown", () => {
  // A binding map comes from localStorage, so a hostile or half-written value has to
  // be *no chord* — the shell must keep its other keys.
  assert.equal(parseChord(""), null);
  assert.equal(parseChord("Ctrl+"), null);
  assert.equal(parseChord("a+b"), null);
  assert.equal(parseChord("Ctrl+K+Alt+J"), null);
  assert.equal(parseChord("k"), null, "an unmodified letter would swallow typing");
  assert.ok(parseChord("F1"));
  assert.ok(parseChord("?"));
});

test("matchesChord: ctrl/alt/meta must agree, shift is forgiving for plain keys", () => {
  const ctrlK = { key: "k", ctrlKey: true };
  assert.ok(matchesChord("Ctrl+K", ctrlK));
  assert.ok(!matchesChord("Ctrl+K", { key: "k" }), "a bare k must not open the palette");
  assert.ok(!matchesChord("Ctrl+K", { key: "k", ctrlKey: true, altKey: true }));
  // Shift is not part of what the user asked for on a letter key, and Windows layouts
  // produce both forms for the same physical press.
  assert.ok(matchesChord("Ctrl+K", { key: "k", ctrlKey: true, shiftKey: true }));
  // Punctuation is different: `?` is literally Shift+/ on a US layout.
  assert.ok(matchesChord("?", { key: "?", shiftKey: true }));
});

test("meta is its own modifier, not an alias for ctrl", () => {
  assert.ok(matchesChord("Cmd+K", { key: "k", metaKey: true }));
  assert.ok(!matchesChord("Cmd+K", { key: "k", ctrlKey: true }));
});

test("resolveBindings: a bad override falls back to the default, not to nothing", () => {
  const bindings = resolveBindings(SHORTCUT_ACTIONS, { palette: "not a chord" });
  assert.equal(bindings.palette, "Ctrl+K");
  assert.equal(
    resolveBindings(SHORTCUT_ACTIONS, { palette: "" }).palette,
    "Ctrl+K",
    "clearing a chord is a default, not a disable — the UI has its own 清除 verb",
  );
});

test("findConflicts names both claimants, keyed by the canonical chord", () => {
  const conflicts = findConflicts({
    palette: "Ctrl+K",
    help: "ctrl+k",
    back: "Alt+ArrowLeft",
  });
  assert.deepEqual(Object.keys(conflicts), ["Ctrl+K"]);
  assert.deepEqual(conflicts["Ctrl+K"], ["palette", "help"]);
});

test("matchAction prefers the more specific chord and is deterministic", () => {
  const actions = [
    { id: "loose", labelKey: "x", group: "nav", defaultChord: "Ctrl+K", allowInField: true },
    { id: "tight", labelKey: "y", group: "nav", defaultChord: "Ctrl+Shift+K", allowInField: true },
  ] as const;
  const bindings = { loose: "Ctrl+K", tight: "Ctrl+Shift+K" };
  // Both match under the forgiving-shift rule; `tight` asks for more, so it wins —
  // and it wins the same way on every run, which listener order does not promise.
  assert.equal(matchAction(actions, bindings, { key: "k", ctrlKey: true, shiftKey: true }, false), "tight");
  assert.equal(matchAction(actions, bindings, { key: "k", ctrlKey: true }, false), "loose");
  assert.equal(matchAction(actions, bindings, { key: "j", ctrlKey: true }, false), null);
});

test("matchAction: allowInField=false actions stay out of the way while typing", () => {
  const ev = { key: "ArrowLeft", altKey: true };
  assert.equal(matchAction(SHORTCUT_ACTIONS, resolveBindings(SHORTCUT_ACTIONS, {}), ev, true), null);
  assert.equal(
    matchAction(SHORTCUT_ACTIONS, resolveBindings(SHORTCUT_ACTIONS, {}), ev, false),
    "back",
  );
});

test("isTextField recognises the three editors and contenteditable", () => {
  for (const tag of ["INPUT", "TEXTAREA", "SELECT"]) {
    assert.ok(isTextField({ tagName: tag }));
  }
  assert.ok(isTextField({ tagName: "DIV", isContentEditable: true }));
  assert.ok(!isTextField({ tagName: "BUTTON" }));
  assert.ok(!isTextField(null));
});

test("the shipped table has no default conflicts and every chord parses", () => {
  const bindings = resolveBindings(SHORTCUT_ACTIONS, {});
  assert.deepEqual(findConflicts(bindings), {}, "two shipped actions on one chord");
  for (const a of SHORTCUT_ACTIONS) {
    assert.ok(parseChord(atKey(bindings, a.id)), `${a.id} ships an unparseable chord`);
    assert.ok(a.labelKey.startsWith("shortcut."), `${a.id} must render through i18n`);
  }
  assert.equal(chordFromEvent({ key: "K", ctrlKey: true }).key, "k", "letter case is normalised");
});
