/**
 * The English dictionary is a lazy chunk (r32-O1).
 *
 * The rest of the suite installs it eagerly (tests/helpers/register.mjs) so
 * production-like lookups can be asserted. This file checks the other half:
 * a fresh process starts without the English table, every English lookup falls
 * back to Chinese instead of a blank/key, and `ensureEnglish()` is the one
 * import that fills it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const ROOT = process.cwd();

test("i18n.ts has no static import of the English chunk", () => {
  const src = readFileSync(resolve(ROOT, "src/lib/i18n.ts"), "utf8");
  assert.doesNotMatch(src, /from\s+["']\.\/i18n-en["']/, "a static import puts English back in the initial bundle");
  assert.match(src, /import\("\.\/i18n-en"\)/, "the dynamic import must remain the load path");
  assert.match(src, /export function ensureEnglish\(\)/, "the lazy loader must stay exported");
});

test("a fresh process starts in zh fallback, then loads English on demand", () => {
  const url = JSON.stringify(pathToFileURL(resolve(ROOT, "src/lib/i18n.ts")).href);
  const script = `
    const m = await import(${url});
    if (Object.keys(m.DICTIONARIES.en).length !== 0) throw new Error("en table must start empty");
    if (m.tFor("en", "view.projects") !== "项目") throw new Error("unloaded en must fall back to zh");
    await m.ensureEnglish();
    if (m.tFor("en", "view.projects") !== "Projects") throw new Error("loaded en must answer in English");
    if (Object.keys(m.DICTIONARIES.en).length !== Object.keys(m.DICTIONARIES["zh-CN"]).length) {
      throw new Error("loaded en must pair every zh key");
    }
    console.log("lazy-ok");
  `;
  const register = pathToFileURL(resolve(ROOT, "tests/helpers/register.mjs")).href;
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--import", register, "--input-type=module", "-e", script],
    {
      encoding: "utf8",
      cwd: ROOT,
      timeout: 30_000,
      env: { ...process.env, DEVHUB_TEST_SKIP_ENGLISH: "1" },
    },
  );
  assert.equal(r.status, 0, `${r.stdout || ""}${r.stderr || ""}`);
  assert.match(r.stdout, /lazy-ok/);
});
