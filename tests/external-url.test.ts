/**
 * External-link allowlist (r28-O3).
 *
 * Only absolute http/https URLs without userinfo may reach the OS opener. The
 * source half of the test proves every call site goes through the wrapper; the
 * pure half drives the parser with the usual dangerous schemes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { safeHttpUrl } from "../src/lib/external-url.ts";

test("safeHttpUrl: accepts absolute http(s) and normalizes", () => {
  assert.equal(safeHttpUrl(" https://github.com/o/r "), "https://github.com/o/r");
  assert.equal(safeHttpUrl("http://127.0.0.1:3000"), "http://127.0.0.1:3000/");
  assert.equal(safeHttpUrl("HTTPS://EXAMPLE.COM/x"), "https://example.com/x");
});

test("safeHttpUrl: refuses everything that can escape a browser", () => {
  for (const raw of [
    "",
    "   ",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///C:/Windows/System32/calc.exe",
    "mailto:a@example.com",
    "vbscript:msgbox(1)",
    "/relative/path",
    "github.com/o/r",
    "https://user:pass@example.com/x",
  ]) {
    assert.equal(safeHttpUrl(raw), null, raw);
  }
});

test("all opener call sites use the allowlist wrapper", () => {
  const files = [
    "src/components/DialogShell.tsx",
    "src/components/RepoPortPanel.tsx",
    "src/dialogs/LaunchDialog.tsx",
    "src/dialogs/ProjectSettingsDialog.tsx",
    "src/dialogs/RepoReadmeDialog.tsx",
    "src/views/AddRepoView.tsx",
    "src/views/ProjectsView.tsx",
  ];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    assert.match(src, /import \{ openHttpUrl \} from "\.\.\/lib\/external-url"/, file);
    assert.doesNotMatch(src, /from "@tauri-apps\/plugin-opener"/, file);
  }
  const helper = readFileSync("src/lib/external-url.ts", "utf8");
  assert.match(helper, /safeHttpUrl/);
  assert.match(helper, /await openUrl\(safe\)/);
});
