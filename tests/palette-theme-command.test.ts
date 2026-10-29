/**
 * `src/components/CommandPalette.tsx` — the theme command answers with the
 * colour the app is actually showing.
 *
 * The defect (r16-o4-4): the command's label/icon/action read
 * `useAppearance.getState().theme` imperatively inside the `commands` memo,
 * whose deps do not include appearance — so the command went stale while the
 * palette stayed open — and compared the raw `ThemeId`, which can be "system".
 * With 跟随系统 + a light OS the palette offered 切换到浅色 while the app WAS
 * light, and clicking wrote `theme: "light"` with no visible change. The fix is
 * `resolveTheme(state.theme)` (the same function `applyAppearance` writes
 * `data-theme` from) plus a narrow subscription on the stored preference.
 *
 * Structural, same harness as `tests/statusstrip-nesting.test.ts`: `.tsx` cannot
 * be mounted under `--experimental-strip-types` (DEVELOPMENT.md §8.1).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tFor } from "../src/lib/i18n";

const PALETTE = "src/components/CommandPalette.tsx";

/** Code only, line numbers preserved. */
function codeOnly(src: string): string[] {
  const kept: string[] = [];
  let inBlock = false;
  for (const raw of src.split(/\r?\n/)) {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf("*/");
      if (end < 0) {
        kept.push("");
        continue;
      }
      line = line.slice(end + 2);
      inBlock = false;
    }
    const open = line.indexOf("/*");
    if (open >= 0) {
      const close = line.indexOf("*/", open + 2);
      if (close >= 0) line = line.slice(0, open) + line.slice(close + 2);
      else {
        line = line.slice(0, open);
        inBlock = true;
      }
    }
    const slash = line.indexOf("//");
    kept.push(slash >= 0 ? line.slice(0, slash) : line);
  }
  return kept;
}

const lines = codeOnly(readFileSync(PALETTE, "utf8"));
const code = lines.join("\n");

test("主题命令由 resolveTheme 推导，不再拿 ThemeId 直接比 light", () => {
  assert.match(
    code,
    /import \{ resolveTheme, useAppearance \} from "\.\.\/store\/appearance"/,
    "the effective colour comes from the store's own resolver",
  );
  assert.match(code, /const isLight = resolveTheme\(theme\) === "light"/,
    "one derivation the label, icon and action all read");
  assert.doesNotMatch(
    code,
    /useAppearance\.getState\(\)\.theme === "light"/,
    "the imperative stale read this replaces",
  );
  for (const [what, re] of [
    // r21-o2-2: the two wording literals moved into the dictionary — the shape
    // still has to read from the same `isLight` derivation, and the zh values
    // they resolve to are pinned byte-for-byte just below.
    ["label", /label: isLight \? t\("palette\.themeDark"\) : t\("palette\.themeLight"\)/],
    ["action", /run: setTheme\(isLight \? "dark" : "light"\)/],
  ] as const) {
    assert.match(code, re, `the ${what} must come from the same derivation`);
  }
  assert.equal(tFor("zh-CN", "palette.themeDark"), "切换到深色");
  assert.equal(tFor("zh-CN", "palette.themeLight"), "切换到浅色");
});

test("palette 开着时命令不发霉：appearance 进了 memo 依赖，且是窄订阅", () => {
  // r16-n2-2 added `t` (the locale-memoised translator) to the same deps for
  // the same reason as `theme`: the 去… / 设置 page labels are built inside
  // this memo, so a language switch has to rebuild it. r30-N1 adds `savedViews`
  // because the 应用视图 commands are built from that list. The assertion pins
  // the full list — theme included, in order — not a subset of it.
  assert.match(
    code,
    /\}, \[repos, records, onRefresh, onClose, ui, theme, t, savedViews\]\);/,
    "the commands memo rebuilds when the stored preference moves",
  );
  assert.match(
    code,
    /const theme = useAppearance\(\(s\) => s\.theme\);/,
    "narrow primitive subscription — not the whole appearance object",
  );
});
