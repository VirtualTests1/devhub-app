/**
 * `src/lib/slug.ts` — the canonical repository identity, and the proof that the
 * store's export is the *same function* rather than a second copy.
 *
 * `store/wall.ts` keeps re-exporting `slugOf` only while `ProjectsView` and
 * `settings/ProjectsSection` import it from there (round-12 交接). A re-export is
 * how `types.ts` and `lib/format` ended up with two import paths for one
 * formatter, so this file pins the difference: identity, not equality of output.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { slugOf } from "../src/lib/slug.ts";
import { slugOf as slugOfViaWall } from "../src/store/wall.ts";

test("slugOf: host/owner/repo, byte-identical to the backend key", () => {
  assert.equal(slugOf({ host: "github.com", owner: "joeseesun", repo: "opus" }), "github.com/joeseesun/opus");
  assert.equal(slugOf({ host: "gitee.com", owner: "a", repo: "b" }), "gitee.com/a/b");
  // No trimming, no lower-casing, no host guessing — the parts are what the walk gave.
  assert.equal(slugOf({ host: "GitHub.com", owner: "RustLang", repo: "Cargo" }), "GitHub.com/RustLang/Cargo");
});

test("slugOf via store/wall is the very same function, not a copy", () => {
  assert.equal(slugOfViaWall, slugOf, "wall's export must be a pass-through of lib/slug");
});

test("the cover key is a different fact and stays different", () => {
  // `owner/repo` (no host) is what `fetch_cover` is addressed by; collapsing it
  // into slugOf would change which cache file a wall card reads.
  const repo = { host: "github.com", owner: "BurntSushi", repo: "ripgrep" };
  assert.equal(slugOf(repo), "github.com/BurntSushi/ripgrep");
  assert.equal(`${repo.owner}/${repo.repo}`, "BurntSushi/ripgrep");
});
