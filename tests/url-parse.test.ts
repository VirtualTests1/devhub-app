/**
 * `parseGithubRepoUrl` — the 添加页 search box recognising a pasted link
 * (round 11, 需求 8.8).
 *
 * The stakes are asymmetric: a false positive sends a legitimate search query
 * into the download box, and a false negative makes a pasted link search for
 * its own text. Both are covered, plus the reserved-path prefixes that look
 * like `owner/repo` but are not repositories.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseGithubRepoUrl } from "../src/lib/utils.ts";

test("parses the shapes people actually paste", () => {
  assert.equal(parseGithubRepoUrl("https://github.com/rust-lang/rust"), "rust-lang/rust");
  assert.equal(parseGithubRepoUrl("http://github.com/rust-lang/rust"), "rust-lang/rust");
  assert.equal(parseGithubRepoUrl("github.com/rust-lang/rust"), "rust-lang/rust");
  assert.equal(parseGithubRepoUrl("  https://github.com/rust-lang/rust  "), "rust-lang/rust");
  assert.equal(parseGithubRepoUrl("www.github.com/rust-lang/rust"), "rust-lang/rust");
  assert.equal(parseGithubRepoUrl("https://github.com/rust-lang/rust.git"), "rust-lang/rust");
  // A path inside the repository is still that repository.
  assert.equal(
    parseGithubRepoUrl("https://github.com/rust-lang/rust/tree/main/src"),
    "rust-lang/rust",
  );
  assert.equal(
    parseGithubRepoUrl("https://github.com/rust-lang/rust/issues/123#issuecomment-1"),
    "rust-lang/rust",
  );
  // Dots and dashes and underscores are legal in both halves.
  assert.equal(parseGithubRepoUrl("https://github.com/a.b-c/d_e.f"), "a.b-c/d_e.f");
});

test("returns null for everything that is not a repository URL", () => {
  // Plain keywords, including ones that mention the host.
  assert.equal(parseGithubRepoUrl("rust http client"), null);
  assert.equal(parseGithubRepoUrl("github"), null);
  assert.equal(parseGithubRepoUrl("tauri app"), null);
  assert.equal(parseGithubRepoUrl(""), null);
  assert.equal(parseGithubRepoUrl("   "), null);
  // Not GitHub, or the host appearing later in the string.
  assert.equal(parseGithubRepoUrl("https://gitlab.com/rust-lang/rust"), null);
  assert.equal(parseGithubRepoUrl("https://evil.com/github.com/a/b"), null);
  assert.equal(parseGithubRepoUrl("https://notgithub.com/a/b"), null);
  // A host with no repository pair.
  assert.equal(parseGithubRepoUrl("https://github.com/"), null);
  assert.equal(parseGithubRepoUrl("https://github.com/rust-lang"), null);
  // Reserved paths that look like owner/repo but are pages, not repositories.
  for (const p of [
    "https://github.com/settings/profile",
    "https://github.com/notifications",
    "https://github.com/explore",
    "https://github.com/topics/rust",
    "https://github.com/marketplace",
    "https://github.com/login",
    "https://github.com/new",
  ]) {
    assert.equal(parseGithubRepoUrl(p), null, `${p} is not a repository`);
  }
});

test("the composer's own owner/repo shorthand is not mistaken for a URL", () => {
  // `owner/repo` (no host) is the composer's format; the search box must not
  // claim it, or typing a shorthand would be intercepted before the query.
  assert.equal(parseGithubRepoUrl("rust-lang/rust"), null);
});
