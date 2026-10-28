/**
 * `slugFromRef` (`src/lib/slug.ts`) — the canonical slug for a *pasted ref*.
 *
 * The defect (r16-o4-3): the download queue's 打开项目 derived its slug from a
 * parser that only understood pasted `http(s)` URLs. `git@github.com:owner/repo`
 * came out as `github.com/git@github.com:owner/repo`, `ssh://git@host/o/r` as
 * four wrongly joined segments, and a bare word as itself — a slug nothing in
 * the app can be found by. The action stayed enabled (a done task always has an
 * outcome) and opening a dialog on that slug just fails to load.
 *
 * The table covers the shapes people actually paste — https, git@, ssh://,
 * bare `owner/repo`, trailing `.git` — plus the honest `null` for refs that name
 * no repository at all. `DownloadOutcome` carries no identity fields to fall
 * back on (`path`/`layer`/`attempts` only), which is why the parser lives on the
 * ref and why "cannot name this repository" is a first-class answer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { slugFromRef } from "../src/lib/slug.ts";

/** [ref, canonical slug or null] */
const TABLE: [string, string | null][] = [
  // --- https / http: the shapes the old parser already handled ---------------
  ["https://github.com/rust-lang/rust", "github.com/rust-lang/rust"],
  ["http://github.com/owner/repo", "github.com/owner/repo"],
  ["https://gitlab.com/group/repo", "gitlab.com/group/repo"],
  ["  https://github.com/owner/repo  ", "github.com/owner/repo"],
  // --- trailing `.git` and trailing slash, in every family -------------------
  ["https://github.com/owner/repo.git", "github.com/owner/repo"],
  ["https://github.com/owner/repo/", "github.com/owner/repo"],
  ["git@github.com:owner/repo.git", "github.com/owner/repo"],
  ["git@github.com:owner/repo/", "github.com/owner/repo"],
  ["owner/repo.git", "github.com/owner/repo"],
  // --- git@ (scp-like): the mangled family this fixes ------------------------
  ["git@github.com:owner/repo", "github.com/owner/repo"],
  ["git@gitlab.com:group/repo", "gitlab.com/group/repo"],
  ["git@gitee.com:owner/repo", "gitee.com/owner/repo"],
  ["someone@example.com:owner/repo", "example.com/owner/repo"],
  // --- ssh:// and git://: one URL parse, identity without transport ----------
  ["ssh://git@github.com/owner/repo", "github.com/owner/repo"],
  ["ssh://git@github.com/owner/repo.git", "github.com/owner/repo"],
  ["ssh://github.com/owner/repo", "github.com/owner/repo"],
  // The port is transport detail for ssh, not part of the identity.
  ["ssh://git@host.example:22/owner/repo", "host.example/owner/repo"],
  ["git://github.com/owner/repo", "github.com/owner/repo"],
  // --- bare: owner/repo assumes GitHub, host/owner/repo is taken as typed ----
  ["owner/repo", "github.com/owner/repo"],
  ["github.com/owner/repo", "github.com/owner/repo"],
  // --- unparseable: null, never a fabricated slug ----------------------------
  ["myrepo", null],
  ["", null],
  ["   ", null],
  ["rust http client", null],
  ["github.com", null],
  // A host with no repo pair never named a repository; the old parser answered
  // "github.com" here and the dialog silently failed to load.
  ["https://github.com/", null],
  ["https://github.com/owner", null],
  ["git@github.com:owner", null],
];

test("slugFromRef: 每种粘贴形态 → 规范 host/owner/repo（或诚实的 null）", () => {
  for (const [ref, expected] of TABLE) {
    assert.equal(slugFromRef(ref), expected, `slugFromRef(${JSON.stringify(ref)})`);
  }
});

test("旧解析器的三种错法不再出现", () => {
  // Pinned by value above, restated here as the shape of the regression: the
  // scp-like form must not swallow the login into the host segment, ssh:// must
  // not keep the scheme, and a bare word must not pass through as a slug.
  assert.equal(slugFromRef("git@github.com:owner/repo"), "github.com/owner/repo");
  assert.notEqual(slugFromRef("git@github.com:owner/repo"), "github.com/git@github.com:owner/repo");
  assert.notEqual(slugFromRef("ssh://git@host/o/r"), "ssh:/git@host/o/r");
  assert.equal(slugFromRef("myrepo"), null);
});

test("答案与 slugOf 的规范形状一致：三段、无 scheme、无 login", () => {
  for (const [ref, expected] of TABLE) {
    if (expected === null) continue;
    const parts = expected.split("/");
    assert.equal(parts.length, 3, `${ref} → ${expected} must be host/owner/repo`);
    assert.ok(!parts.some((p) => p.length === 0), `${ref} → ${expected} has an empty part`);
    assert.ok(!expected.includes("@"), `${ref} → ${expected} still carries a login`);
    assert.ok(!expected.includes("://"), `${ref} → ${expected} still carries a scheme`);
  }
});
