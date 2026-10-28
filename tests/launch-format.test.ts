/**
 * `repoUrlOf` in `src/dialogs/launch/format.ts` — the 启动 dialog's link back
 * to the repository's web page. `RepoRef` carries host/owner/repo and no URL
 * field, so the slug (already `host/owner/repo`) is the only input; nothing is
 * percent-encoded on the way out, and this file pins that a later "helpful"
 * `encodeURIComponent` would be a deliberate contract change.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { repoUrlOf } from "../src/dialogs/launch/format.ts";

test("repoUrlOf: the canonical slug becomes the repo's web page", () => {
  assert.equal(repoUrlOf("github.com/joeseesun/opus"), "https://github.com/joeseesun/opus");
  assert.equal(repoUrlOf("gitee.com/rust-lang/rust"), "https://gitee.com/rust-lang/rust");
});

test("repoUrlOf: fewer than three parts still yields a browsable link", () => {
  // Degraded input (a paste that never parsed into a triple) keeps the host
  // visible rather than throwing — `https://github.com` is still the right
  // place to send someone, and `https://` costs nothing to construct.
  assert.equal(repoUrlOf("github.com"), "https://github.com");
  assert.equal(repoUrlOf("github.com/owner"), "https://github.com/owner");
  assert.equal(repoUrlOf(""), "https://");
});

test("repoUrlOf: extra path parts survive; spaces and unicode are NOT encoded", () => {
  // `host/owner/repo/…`: everything after the host rejoins verbatim.
  assert.equal(repoUrlOf("github.com/a/b/c"), "https://github.com/a/b/c");
  // The slug is a storage key, not a user-typed URL: raw bytes stay raw.
  assert.equal(repoUrlOf("gitee.com/some user/my repo"), "https://gitee.com/some user/my repo");
  assert.equal(repoUrlOf("github.com/所有者/仓库"), "https://github.com/所有者/仓库");
});
