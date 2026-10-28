/**
 * `src/shell/StatusStrip.tsx` — a coloured pill must not print its label in its own
 * background colour.
 *
 * The defect (r15-correct-10): both live counts in the strip were styled with the
 * same token behind and in front of the glyphs. `src/index.css:108` defines
 * `--color-success` as *one* token feeding both the background and the text
 * utility, so the two 15-minute-a-day facts the strip carries — 运行中 N and
 * 下载失败 N — rendered as a solid blob with nothing readable in it. Each branch
 * additionally trailed a hover pair naming the colour it was already in, i.e. a
 * no-op that read like a hover state; and the 运行中 ternary keyed on `runOpen`
 * had two identical arms, so it was dead code pretending to be a state style.
 *
 * The house idiom these lines are held to is the one `Sidebar.tsx:327` and
 * `RepoSyncPanel.tsx:234` already use: a translucent wash behind coloured text.
 *
 * `.tsx` cannot be mounted at this layer (`--experimental-strip-types` refuses it,
 * DEVELOPMENT.md §8.1), so the classes are pinned structurally — the same approach
 * as `tests/single-source.test.ts` and `tests/repos-seq-guard.test.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const STRIP = "src/shell/StatusStrip.tsx";
const TONES = "success|danger|warning|info";

/** Every `.ts`/`.tsx` under `src`, the way `single-source.test.ts` walks it. */
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

/**
 * Comments blanked out, line numbers preserved.
 *
 * Needed, not cosmetic: this codebase documents a fix by quoting the line it
 * replaced, so a scanner that reads comments would fail on the sentence explaining
 * the bug it just prevented. JSX braces comments (`{/* … *\/}`) count as comments.
 */
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

function hits(pattern: RegExp) {
  const found: { where: string; text: string }[] = [];
  for (const file of sourceFiles()) {
    codeOnly(readFileSync(file, "utf8")).forEach((text, i) => {
      if (pattern.test(text)) found.push({ where: `${file}:${i + 1}`, text: text.trim() });
    });
  }
  return found;
}

const stripCode = codeOnly(readFileSync(STRIP, "utf8"));

test("全仓：没有任何一行把文字画在它自己的背景色上", () => {
  // The `/NN` between the tone and the whitespace is the whole difference between
  // the good shape (`bg-success/15 text-success`) and the invisible one, and it is
  // what this pattern cannot cross — which is why the guard can be app-wide instead
  // of parked on the strip.
  for (const tone of TONES.split("|")) {
    assert.deepEqual(
      hits(new RegExp(`bg-${tone}\\s+text-${tone}\\b|text-${tone}\\s+bg-${tone}\\b`)),
      [],
      `bg-${tone} text-${tone} renders the label invisible: --color-${tone} is one token for both`,
    );
  }
});

test("全仓：没有 hover 到同一颜色的空转声明", () => {
  for (const tone of TONES.split("|")) {
    assert.deepEqual(
      hits(new RegExp(`hover:bg-${tone}\\s+hover:text-${tone}\\b`)),
      [],
      `hover:bg-${tone} hover:text-${tone} is a no-op that reads like a hover state`,
    );
  }
});

test("状态条两个胶囊：彩色文字 + 半透明底纹", () => {
  assert.ok(
    stripCode.some((l) => /bg-success\/\d+/.test(l) && /text-success/.test(l)),
    "运行中 must be a wash behind green text",
  );
  assert.ok(
    stripCode.some((l) => /bg-danger\/\d+/.test(l) && /text-danger/.test(l)),
    "下载失败 must be a wash behind red text",
  );
});

test("运行中胶囊的开合状态不再由那段同色三元表达式假扮", () => {
  // The dead branch: both arms were the same colours, so the only honest statement
  // here is that no line may pair `runOpen` with a background utility again — the
  // open state is carried by `aria-expanded`, the `title`, and the chevron that
  // rotates at the end of the row.
  const colourArms = stripCode.filter((l) => /runOpen/.test(l) && /\bbg-/.test(l));
  assert.deepEqual(colourArms, [], "开合态要留在 aria 与非颜色线索上，不要回到胶囊配色里");
  assert.ok(
    stripCode.some((l) => /\(open \|\| runOpen\) && "rotate-180"/.test(l)),
    "the chevron is still the visual open/closed cue",
  );
});
