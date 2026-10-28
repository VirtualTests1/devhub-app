/**
 * `src/shell/StatusStrip.tsx` — the live GitHub signal is wired, not decorative.
 *
 * The pure contract lives in `tests/net-status.test.ts`; what a Node test cannot
 * mount is the component. This pins the seam at source level: the one literal
 * `invoke("net_status")` the command checker can see, the payload guard, the
 * poller's lifecycle (start, hidden/visible, focus, cleanup), the forced click,
 * and the customization slot that makes the segment hideable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const STRIP = "src/shell/StatusStrip.tsx";
const CUSTOMIZE = "src/store/customize.ts";

function codeOnly(src: string): string {
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
  return kept.join("\n");
}

const code = codeOnly(readFileSync(STRIP, "utf8")).replace(/\r\n/g, "\n");
const customize = readFileSync(CUSTOMIZE, "utf8").replace(/\r\n/g, "\n");

test("strip: net_status is a literal invoke the command checker can parse", () => {
  assert.match(
    code,
    /import \{[^}]*createNetStatusPoller[^}]*\} from "\.\.\/lib\/net-status"/,
    "the poller and its guards come from the pure module, not a local copy",
  );
  assert.match(
    code,
    /invoke<unknown>\("net_status", \{ force \}\)/,
    "the scanner sees a command literal, and force is part of the call",
  );
  assert.match(code, /parseNetStatus\(value\)/, "the IPC answer crosses the runtime guard");
  assert.match(code, /everyMs: NET_POLL_MS/, "the cadence is the exported constant");
});

test("strip: the poll pauses while hidden and re-probes on focus and visibility", () => {
  assert.match(
    code,
    /isVisible: \(\) => document\.visibilityState !== "hidden"/,
    "the poller reads the document, not a stale mount-time boolean",
  );
  assert.match(
    code,
    /addEventListener\("visibilitychange", onVisibility\)/,
    "a hidden window stops arming timers",
  );
  assert.match(code, /poller\.setVisible\(document\.visibilityState !== "hidden"\)/, "and resumes on show");
  assert.match(code, /addEventListener\("focus", onFocus\)/, "an OS focus re-asks without forcing");
  assert.match(code, /poller\.refresh\(false\)/, "focus does not bypass the short backend cache");
  for (const remove of [
    /removeEventListener\("visibilitychange", onVisibility\)/,
    /removeEventListener\("focus", onFocus\)/,
    /poller\.stop\(\)/,
  ]) {
    assert.match(code, remove, "cleanup must undo the listener/timer, not only the JSX");
  }
  assert.match(code, /poller\.start\(\)/, "the first probe starts on mount");
});

test("strip: a click forces a fresh probe and the row does not double-toggle", () => {
  assert.match(
    code,
    /\{\.\.\.reg\("status-seg-net"\)\}[\s\S]{0,400}onClick=\{\(e\) => \{[\s\S]{0,160}e\.stopPropagation\(\);[\s\S]{0,160}netPollerRef\.current\?\.refresh\(true\);/,
    "the segment is a real control that stops the row click and forces the probe",
  );
  assert.match(code, /title=\{netAria\}/, "hover copy carries the measured round trip");
  assert.match(code, /aria-label=\{netAria\}/, "the accessible name says the same thing");
});

test("strip: the segment sits between the path source and git, and can be hidden", () => {
  const link = code.indexOf('reg("status-seg-link")');
  const net = code.indexOf('reg("status-seg-net")');
  const git = code.indexOf('reg("status-seg-git")');
  assert.ok(link >= 0 && net > link && git > net, "link → live signal → git is the reading order");
  assert.match(
    code,
    /const showNet = useCustomize\(\(s\) => !s\.overrides\["status-seg-net"\]\?\.hidden\)/,
    "the customization override gates both the segment and its poller",
  );
  assert.match(code, /if \(!showNet\) return;/, "a hidden segment must not keep polling");
  assert.ok(
    customize.includes('{ id: "status-seg-net",'),
    "reg() ids have to be registered in ELEMENTS or the settings UI cannot manage them",
  );
});
