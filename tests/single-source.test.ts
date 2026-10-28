/**
 * Single-source guards (round 12, 单一来源).
 *
 * Every formatter and label table this repo has drifted on followed the same
 * pattern: a second copy was written *inside a component or a view* because that
 * was the file being edited, and the original stayed in place. The two then
 * rendered side by side with different words for one fact
 * (`15 分 00 秒` next to `15 分 0 秒`, 记录保留时长 next to 记录保留).
 *
 * A reviewer cannot catch that by reading one file, so these tests read the tree:
 * each protected name may be *declared* in exactly one designated home. A second
 * copy anywhere in `src/` fails the suite with the file it came from.
 *
 * `node:fs` scanning is deliberate — it is the same approach
 * `scripts/check-registry.mjs` takes against the element registry.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

type Hit = { file: string; line: number; text: string };

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name)) out.push(p);
    }
  };
  walk("src");
  return out;
}

/** Every line in `src/` that declares a symbol matching `pattern`. */
function declarations(pattern: RegExp): Hit[] {
  const hits: Hit[] = [];
  for (const file of sourceFiles()) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((text, i) => {
      if (pattern.test(text)) hits.push({ file, line: i + 1, text: text.trim() });
    });
  }
  return hits;
}

/**
 * Assert a name is declared only in `home`.
 *
 * `home` is compared as a suffix because the scanner yields POSIX-ish paths while
 * the assertion message should read like the paths in the audit reports.
 */
function assertSingleDeclaration(pattern: RegExp, names: string, home: string) {
  const hits = declarations(pattern);
  const outside = hits.filter((h) => !h.file.replace(/\\/g, "/").endsWith(home));
  assert.deepEqual(
    outside.map((h) => `${h.file}:${h.line} ${h.text}`),
    [],
    `${names} must be declared only in ${home}; found copies:\n` +
      hits.map((h) => `  ${h.file}:${h.line}`).join("\n"),
  );
  assert.ok(
    hits.length > 0,
    `${names} has no declaration at all — if it was renamed, update this guard to the new name`,
  );
}

test("elapsed duration is declared only in lib/format", () => {
  // The four copies this replaces: fmtElapsed here, `elapsedText` in RepoTile
  // (imported by the shell — that is how it escaped lib/), the `15m00s` ternary
  // in DownloadQueue, and the padded seconds in the download log helpers.
  assertSingleDeclaration(
    /^\s*(?:export\s+)?(?:function|const)\s+(?:fmtElapsed|elapsedText)\b/,
    "the elapsed-duration formatter",
    "src/lib/format.ts",
  );
});

test("relative-ladder names are declared only in lib/format", () => {
  assertSingleDeclaration(
    /^\s*(?:export\s+)?(?:function|const)\s+(?:fmtAgo|fmtRelative|lastOpenedText)\b/,
    "the relative-time ladder",
    "src/lib/format.ts",
  );
});

test("no file outside lib/format writes its own 前 wording", () => {
  // The ladder is only single-sourced if a new surface cannot quietly emit the
  // same units by hand. `秒前 / 分钟前 / 小时前 / 天前` as an interpolated answer
  // means somebody re-grew the ladder — go through `fmtAgo` instead.
  // (Comments quoting the words are fine, so this looks for the template shape.)
  const hits = declarations(/`\$\{[^`]*\}\s*(?:秒前|分钟前|小时前|天前)/);
  assert.deepEqual(
    hits.filter((h) => !h.file.replace(/\\/g, "/").endsWith("src/lib/format.ts")).map((h) => `${h.file}:${h.line} ${h.text}`),
    [],
    "relative ages come from fmtAgo; found hand-written units:\n" +
      hits.map((h) => `  ${h.file}:${h.line}`).join("\n"),
  );
});

test("two-digit padding is declared only in lib/format", () => {
  // `pad2` is the second thing that got re-invented per file (RepoTile had a
  // module-level `pad` and a function-local one), and each copy drifted its
  // padding width a little differently from the others.
  assertSingleDeclaration(
    /^\s*(?:export\s+)?(?:function|const)\s+pad2\b/,
    "pad2",
    "src/lib/format.ts",
  );
  const locals = declarations(/const\s+pad\s*=\s*\(n:?\s*(?:number)?\)?\s*=>\s*String\(n\)\.padStart/);
  assert.deepEqual(
    locals.map((h) => `${h.file}:${h.line} ${h.text}`),
    [],
    "use pad2 from lib/format instead of a local `pad`",
  );
});

/**
 * Files another work stream owns, listed here so the guard can be exact today.
 * Each entry is a 交接 item; delete it once the site imports `lib/slug`.
 */
const KNOWN_FOREIGN_COPIES: string[] = [
  // The one entry this list used to carry — `src/components/DownloadQueue.tsx`,
  // whose local ref→slug parser was the 交接 item above — is gone as of
  // r16-o4-3: the queue imports `slugFromRef` from `lib/slug` now, so the file
  // declares no slug function at all and the allowance would only be slack.
];

const KNOWN_FOREIGN_TRIPLES = [
  // `src/views/AddRepoView.tsx` — inlines the canonical triple to build a
  // lower-cased dedupe set. Same identity, one `.toLowerCase()` on top, so it
  // should call `slugOf(...).toLowerCase()`. Not this work stream's file.
  "src/views/AddRepoView.tsx",
];

function outsideHomes(file: string, home: string, allow: string[]): boolean {
  const f = file.replace(/\\/g, "/");
  return !f.endsWith(home) && !allow.some((a) => f.endsWith(a));
}

test("slugOf is declared only in lib/slug", () => {
  const hits = declarations(/^\s*(?:export\s+)?(?:function|const)\s+slugOf\b/);
  const copies = hits
    .filter((h) => outsideHomes(h.file, "src/lib/slug.ts", KNOWN_FOREIGN_COPIES))
    .map((h) => `${h.file}:${h.line} ${h.text}`);
  assert.deepEqual(copies, [], "the canonical slug has exactly one declaration (lib/slug)");
});

test("the canonical host/owner/repo triple is spelled only in lib/slug", () => {
  // The two private copies this removed were byte-identical to the store's, so an
  // equality test could not tell them apart from drift — only "one place spells
  // the identity" can.
  const hits = declarations(/`\$\{\s*\w+\.host\s*\}\/\$\{[^}]*\.owner\s*\}\/\$\{[^}]*\.repo\s*\}/);
  const copies = hits
    .filter((h) => outsideHomes(h.file, "src/lib/slug.ts", KNOWN_FOREIGN_TRIPLES))
    .map((h) => `${h.file}:${h.line} ${h.text}`);
  assert.deepEqual(copies, [], "build the canonical slug with lib/slug's slugOf()");
});

test("the config-key name table exists only in lib/targetLabel", () => {
  assertSingleDeclaration(
    /^\s*(?:export\s+)?(?:const|function)\s+(?:CONFIG_TARGET_LABEL|CONFIG_TARGET_KEYS|configTargetLabel)\b/,
    "the setting-name catalog",
    "src/lib/targetLabel.ts",
  );
});

test("no surface writes its own key→中文 label table", () => {
  // The exact shape that drifted twice: `"config.searchDebounceMs": "搜索停顿"` in
  // one view and `searchDebounceMs: "搜索停顿时间"` in another. A jump-target table
  // (`"config.x": "network"`) is a different fact and stays where it is.
  const hits = declarations(/["'](?:config|ui)\.[A-Za-z]+["']\s*:\s*["'][^"']*[\u4e00-\u9fff]/);
  const copies = hits
    .filter((h) => !h.file.replace(/\\/g, "/").endsWith("src/lib/targetLabel.ts"))
    .map((h) => `${h.file}:${h.line} ${h.text}`);
  assert.deepEqual(copies, [], `setting names come from lib/targetLabel; found:\n${copies.join("\n")}`);
});

test("lib/format is imported from lib/format, not re-sold by types.ts", () => {
  // `types.ts` used to re-export the formatters, so `from "../types"` and
  // `from "../../lib/format"` were both "correct" and neither side could tell the
  // copies apart. The re-export survives for exactly one foreign file, listed.
  const KNOWN_TRANSITIONAL = ["src/views/ProjectsView.tsx"];
  const hits = declarations(/import\s*\{[^}]*\bformatBytes\b[^}]*\}\s*from\s*["'][^"']*\btypes["']/);
  const strays = hits
    .filter((h) => !KNOWN_TRANSITIONAL.some((a) => h.file.replace(/\\/g, "/").endsWith(a)))
    .map((h) => `${h.file}:${h.line} ${h.text}`);
  assert.deepEqual(
    strays,
    [],
    `formatBytes comes from lib/format (the ProjectsView line is 交接'd; delete it and this allowance together):\n${strays.join("\n")}`,
  );
});
