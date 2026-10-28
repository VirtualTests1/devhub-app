/**
 * `src/shell/StatusStrip.tsx` — `runOpen` resets when the last process exits.
 *
 * The defect (r16-o4-1): `runOpen` was only ever cleared by a click — the 运行中
 * toggle, the row, the 链路 button, dismiss — and the toggle unmounts at
 * `runningCount === 0`. So once the last process exited nothing could close the
 * popover state again: the chevron stayed rotated, `useDismiss` stayed armed, and
 * because `runLayer` derives from `runOpen && runningCount > 0`, the next launch
 * popped the panel open unprompted.
 *
 * The fix is the reset effect, not a derivation on the consumers: deriving
 * `runOpen && runningCount > 0` at the three read sites would fix the chevron and
 * the dismiss arming but leave the stale `runOpen` in state, which is exactly the
 * half that re-opens on the next launch. Pinning the effect — and the consumers
 * that stay honest because of it — is the point of this file.
 *
 * Structural, same harness as `tests/statusstrip-nesting.test.ts`: `.tsx` cannot
 * be mounted under `--experimental-strip-types` (DEVELOPMENT.md §8.1).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const STRIP = "src/shell/StatusStrip.tsx";

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

const lines = codeOnly(readFileSync(STRIP, "utf8"));
const code = lines.join("\n");

test("运行数归零后 runOpen 自己复位——触发器已卸载，再没有点击能清它", () => {
  assert.match(
    code,
    /if \(runningCount === 0\) setRunOpen\(false\)/,
    "the reset must fire on the count itself, not on a click that can no longer happen",
  );
  // An effect keyed on the count, so a mount at 0 and every exit down to 0 go
  // through the same reset. (`}, [runningCount]);` closes that effect.)
  assert.match(code, /useEffect\(\(\) => \{/, "the reset is an effect on the live count");
  assert.match(code, /}, \[runningCount\]\);/, "and re-runs only when the count moves");
  // r18-o2 swapped the reportedAt `useMemo(() => Date.now(), [live])` for a ref
  // keyed on the array's identity (the memo's dep was the trigger, not a value
  // the callback read, which is exactly what the hook linter refuses), so
  // useMemo is gone from this file. The pin's subject is unchanged: useEffect
  // comes from react, not a hand-rolled subscription.
  assert.match(
    code,
    /import \{ useEffect, useRef, useState \} from "react"/,
    "useEffect comes from react, not a hand-rolled subscription",
  );
});

test("复位的对象是 runOpen 本身，不是只把读它的地方改哑", () => {
  // The three consumers keep reading `runOpen` — the reset is what makes those
  // reads truthful. If a future change swaps them to a derived `runActive`
  // without keeping this effect, the stale state comes back and the next launch
  // pops the panel again, so pin both halves together.
  assert.match(code, /runLayer = useLayerExit\(runOpen && runningCount > 0\)/,
    "the panel still derives from the (now reset) runOpen");
  assert.match(code, /enabled: open \|\| runOpen/,
    "dismiss arming still reads runOpen — which the effect clears at 0");
  assert.match(code, /\(open \|\| runOpen\) && "rotate-180"/,
    "the chevron still reads runOpen (also pinned by statusstrip-nesting)");
  assert.match(code, /aria-expanded=\{runOpen\}/,
    "aria-expanded still reads runOpen, and it can no longer outlive the trigger");
});
