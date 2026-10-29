// Cross-checks every command name the frontend invokes against the list
// registered in src-tauri/src/lib.rs's generate_handler! — in both directions.
//
// A mismatch here is exactly the class of bug that made a 回退 button fail at
// runtime rather than at compile time, so it is worth a mechanical check.
//
// Two things this file used to get wrong, both in the "green without coverage"
// direction, which is the only direction that can silently disable the gate:
//
//   * One direction only. `missing` was the sole exit-code driver, so the day
//     every `invoke("x")` moved behind one wrapper function, `used` would come
//     back EMPTY, `missing` would be empty, and the script would print
//     `invoked from frontend: 0` / `OK` and exit 0 — total loss of contract
//     coverage reading as a passing gate. The floors below are the collapse
//     detector for exactly that, and they print the number they compared
//     against so a red run is diagnosable without opening this file.
//   * The reverse direction was `informational`, i.e. unconditional. A command
//     registered and called by nobody is dead IPC surface, and the old line
//     reported it in a voice that could never make a run fail. It is now
//     allowlisted-per-name-with-a-reason: keeping a callerless command must be a
//     written decision, and the allowlist itself is checked for entries that no
//     longer need cover.
//   * `index.html` was never scanned, although it is frontend code and really
//     does invoke a command from there (`index.html:314`
//     `ipc.invoke("note_boot_painted")`). That command was therefore reported as
//     "registered but not invoked" — a false dead entry caused by an incomplete
//     scan, which is the worst kind of finding for a checker that is meant to be
//     believed. The scan now covers `src/**` *and* `index.html`.
//
// Dependency-free by rule: node:fs, node:path only.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Root anchoring (round 15 d7): `walk("src")` (:92), `index.html` (:95) and
// `readFileSync("src-tauri/src/lib.rs")` (:109) were all cwd-relative. check-commands
// usually runs with cwd=ROOT — either launched by `pnpm check`, or spawned by
// check-invariants.mjs after THAT has chdir'd — which is why the gap hid: only a
// direct run from a subdirectory (`cd tests && node ../scripts/check-commands.mjs`)
// exposed the ENOENT. chdir to the script's own root so any invocation directory
// works; `tests/checkers.test.ts` proves it from `tests/`.
process.chdir(dirname(dirname(fileURLToPath(import.meta.url))));

// ---------------------------------------------------------------------------
// Floors: "the parse produced a plausible amount of coverage"
// ---------------------------------------------------------------------------
// NOT debt ratchets — do not tune them like ones. They sit well below the
// measured value on purpose, so ordinary churn (adding a command, deleting a
// view, renaming a file) never trips them, while the collapse they exist to
// detect (0 or single-digit counts after a wrapper refactor, a renamed
// `generate_handler!` marker, a moved invoke helper, running from the wrong
// directory) trips them immediately.
//
// Measured on this tree at commit time: invoked 69 (68 from `src/**` + 1 from
// `index.html`), registered 69. Floors are 60 / 65 — about 87% / 94% of the
// measured values. (Round 13 d8-4: the old line said "registered 73" — that was
// the count before `feat/d6-registry-tests` deleted four dead commands, and
// nobody re-measured the comment.) If you delete a lot of commands legitimately
// and trip one, lower the floor and say why in the commit message, exactly like
// a baseline.
// Measured on 2026-10-16 after round 16's N1 landed the three worktree commands:
// invoked 73, registered 73. Raised from 60/65 to the live count on purpose — a floor
// that is 13 below reality detects "the handler list got truncated" but shrugs at a
// single command going missing, and a missing command is exactly how `git worktree`
// support would silently become cleanup-only again. Deleting one of these names is a
// legitimate act; doing it without editing this line in the same commit is not.
// Re-measured on 2026-10-17 (round 17 O1 added `repo_freshness_many`: invoked by the
// wall's 检查更新 in `src/views/ProjectsView.tsx`, registered next to `repo_freshness`
// in `generate_handler!`): invoked 76, registered 76. Raised to the live count for the
// reason above.
// Re-measured on 2026-10-19 after the r19/r20 merges landed: the r19 fleet's
// `docker_status` / `project_has_compose` / `repo_grep` and the r20 fleet's
// `register_deeplink` commands all shipped since the 77/77 pin. Live counts
// are invoked 79, registered 85. Raised to the live count for the reason
// above — the floor is a collapse detector, not a growth target.
//
// Raised 79/85 -> 80/86 on 2026-10-19 after the r18-r3-token merge
// (`f588f96`): `verify_github_token` is invoked by the 设置页「校验令牌」
// button (`src/views/SettingsView.tsx`) and registered in `generate_handler!`
// (`src-tauri/src/lib.rs`). One command added on both sides.
// Raised 80 -> 81 on 2026-10-19 by r21-N2-1: `docker_status` gained its first
// frontend caller (`src/views/settings/DockerDiagnosticsSection.tsx`), so its
// allowlist entry was deleted in the same commit — one side up, one cover gone.
// The registered side is unchanged at 86; the floor follows the live count, not
// a wish for it to grow.
// Raised 81 -> 82 on 2026-10-19 by r21-N2-2: `project_has_compose` gained its
// caller (`src/components/RepoComposePanel.tsx` in 项目设置) and its allowlist
// entry went with it, same discipline, same reason.
//
// Raised 80/86 -> 81/86 on 2026-10-19 after r21-N1 (`feat/n1-3-grep-closeout`):
// `repo_grep` gained a frontend caller — `src/lib/grep.ts`'s `runGrep` (invoked
// from `src/dialogs/RepoGrepDialog.tsx`) — which is also why its
// RUST_ONLY_COMMANDS entry above was deleted in the same fleet. Registered stays
// 86 because no new command was added.
//
// Raised to 83 when N1 and N2 landed together: three callers, so the floor is the
// sum of them, not either branch's number.
//
// Raised 83 -> 84 on 2026-10-19 after r21-N3-1 gave `register_deeplink` its
// frontend caller (the 设置页「注册协议」 row → `src/lib/deeplink-register.ts`),
// which also took the name out of `RUST_ONLY_COMMANDS`. Invoked +1 (83 → 84), the
// handler list untouched (86). Same rule as every raise above: the floor is the
// live count, so a single command going missing is a red run rather than a shrug.
//
// Union when this side meets master (r21 N3-3 closeout, 2026-10-19): master carries
// 83/86 — its own raise notes for the r21 N2/N1 wirings of `docker_status` /
// `project_has_compose` / `repo_grep` — while this side adds `register_deeplink`,
// so the merged tree invokes 83 + 1 = 84. The floor at the merge is therefore
// 84/86, with both raise reasons kept side by side (the N1 × N2 merge `2ed542d`
// did exactly that: 取并集、理由并列). Three pins move together: the constant below,
// `tests/star-import-ui.test.ts`, and `tests/deeplink-register-ui.test.ts`.
// It stayed 81 on this branch on purpose — that tree measured 81 live (master's
// N2/N1 code was not in it) and the floor must equal the tree's own live count, or
// the gate is a lie. The merged tree's live count is 84 (measured: `node
// scripts/check-commands.mjs` → invoked 84), so the merged constant is 84.
//
// Raised 84 -> 85 on 2026-10-20 by r21-N1b-2: `check_dependencies` gained a
// second, DIRECT frontend caller — the 设置 → 依赖更新 panel
// (`src/views/settings/DepsUpdateSection.tsx` calls
// `invoke<DependencyReport>("check_dependencies", { slug })`, which the
// scanner's regex sees) — so its RUST_ONLY_COMMANDS entry went with it, same
// discipline as every wiring above. The `probe()` indirection in
// `RepoDiagnoseDialog.tsx` still exists and still works; it just is no longer
// the only path, and a cover for a name the scanner CAN see would trip the
// stale check. Invoked +1 (84 → 85), handler list untouched (86). Four pins
// move together: the constant below, `tests/star-import-ui.test.ts`,
// `tests/deeplink-register-ui.test.ts`, and `tests/compose-isolation-ui.test.ts`.
// Raised 85/86 -> 85/87 on 2026-10-21 by r21-N4-1: `netstatus::net_status` is
// registered in `generate_handler!` as the live reachability probe. The invoked
// side stayed 85 for that commit because its caller landed in N4-2.
// Raised 85 -> 86 on 2026-10-21 by r21-N4-2: the strip now calls
// `invoke<unknown>("net_status", { force })`, so the bridge entry below is gone
// and the invoked floor follows the live count. Registered stays 87.
const INVOKED_FLOOR = 88;
const REGISTERED_FLOOR = 89;

// ---------------------------------------------------------------------------
// Commands with no frontend caller, and the written reason each is allowed to
// keep one
// ---------------------------------------------------------------------------
// Two kinds live here, and the difference matters:
//
//   SUPERSEDED  the one-argument form below still answers a real request, and the
//               frontend calls the explicit-variant instead.
//   DEAD        measured zero callers on BOTH sides (`src/**`, `index.html`,
//               `src-tauri/src` outside `generate_handler!`). Listed to keep this
//               gate green, not to bless it: deleting the command and this line
//               in the same commit is the intended resolution (round-12 matrix
//               6.3 is the open backend item).
//
// The round-11 report (`docs/archive/DevHub第十一轮改进报告_20261014.md` §五.4)
// asserted the `set_*` pair "另有 Rust 侧调用". Re-measured here: it does not —
// `set_mirror_enabled` / `set_ip_pin_enabled` appear only at their `#[tauri::command]`
// definition and in the handler list. That is why they are filed under DEAD.
const RUST_ONLY_COMMANDS = {
  // Empty by design, and it started empty in this round: the four names that used to
  // sit here (`open_terminal`, `open_ide`, `set_mirror_enabled`, `set_ip_pin_enabled`)
  // were deleted in `feat/d6-registry-tests` — the resolution this allowlist asked
  // for. An entry here is a promise to delete something, so an entry whose command is
  // gone is not harmless bookkeeping, it is a cover for a name that no longer needs
  // one; the `stale` check below fails the run on exactly that.
  //
  // The one BRIDGE entry this table ever held (`list_starred_repos`, round 18 N3)
  // lived for one commit by design and was deleted in the commit that added its
  // caller (`src/components/StarImportPanel.tsx`) — which is the deadline the entry
  // itself named. Kept as a note so the next bridge author copies the pattern
  // honestly: an entry with a deadline, deleted by the commit that fulfils it.
  //
  // The `check_dependencies` entry (r20-N2) is gone as of r21-N1b-2: the 设置 →
  // 依赖更新 panel calls it DIRECTLY (`src/views/settings/DepsUpdateSection.tsx`),
  // so the scanner sees the literal and the cover would now be STALE — which is
  // exactly the anti-rot rule the entry's own comment lived under.
  // Round 19 N2 → r21-N1 收口：`repo_grep` 曾在这里等搜索面板 UI。卡片菜单
  // 「在项目中搜索…」（src/dialogs/RepoGrepDialog.tsx，经 src/lib/grep.ts 的
  // runGrep 调用）就是那个 UI，调用者真实存在，所以这条 cover 已删除——留着
  // 会触发下面的 stale 检查（豁免不再需要就是伪装）。
  // Round 19 R1: Tantivy 本地索引调研骨架——命令已注册，实际索引/查询逻辑后续接入。
  // Round 19 N3's Deep Link entry (`register_deeplink: … 设置页 deep link 注册按钮待实现`)
  // is gone as of r21 N3-1: the button shipped, so the command has a caller
  // (`src/lib/deeplink-register.ts` → `invoke("register_deeplink")`) and keeping a
  // cover for it would trip the `staleAllowlist` check above — which is exactly the
  // anti-rot rule that entry's own comment promised to honour.
  // (The Round 19 N1 pair `docker_status` / `project_has_compose` is gone too —
  // r21 N2 wired both and deleted their covers on their own branch.)
};

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------
const files = [];
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(f)) files.push(p);
  }
};
walk("src");
// `index.html` is not a typo in the list above: the boot overlay talks to Rust
// directly, before any module of `src/` has loaded.
if (existsSync("index.html")) files.push("index.html");

const used = new Map();
for (const f of files) {
  const src = readFileSync(f, "utf8");
  // Round 13 (d7-4): both quote styles. The old pattern only accepted double
  // quotes; `invoke('cmd')` was invisible to the scan. The floor (60/65 below)
  // already catches a collapse, so this is coverage completeness rather than a
  // red gate - but a missed invoke is a missed contract either way.
  for (const m of src.matchAll(/invoke(?:<[^()]*>)?\(\s*["']([a-z0-9_]+)["']/g)) {
    if (!used.has(m[1])) used.set(m[1], f);
  }
}

const handler = readFileSync("src-tauri/src/lib.rs", "utf8");
const afterMarker = handler.split("generate_handler![")[1];
if (!afterMarker) {
  // A missing marker used to be a crash inside `.split()`, i.e. a stack trace
  // rather than a verdict. It is the exact collapse the floors are here for, so
  // say what happened and fail with the same voice as the other assertions.
  console.error("FATAL: no `generate_handler![` found in src-tauri/src/lib.rs — cannot check IPC registration");
  process.exit(1);
}
const block = afterMarker.split("])")[0];
// Entries may be module-qualified — `fonts::list_system_fonts` is registered that
// way — and Tauri exposes such a command under its **last** path segment. Dropping
// the qualified entries instead of unwrapping them made the checker report a
// command the frontend really does call as MISSING, and undercount `registered`
// (64 vs the 65 in the list) while still exiting green-looking.
const registered = new Set(
  block
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => /^[a-z0-9_:]+$/.test(s) && s.length > 0)
    .map((s) => s.split("::").pop()),
);

const missing = [...used.keys()].filter((n) => !registered.has(n));
const uninvoked = [...registered].filter((n) => !used.has(n));
const offAllowlist = uninvoked.filter((n) => !(n in RUST_ONLY_COMMANDS));
// An exemption nobody needs is a cover, not a decision — the same rot the baseline
// entries in check-invariants.mjs had. Two ways one goes stale: the command gained
// a caller, or the command is gone from `generate_handler!` altogether.
const staleAllowlist = Object.keys(RUST_ONLY_COMMANDS).filter(
  (n) => used.has(n) || !registered.has(n),
);

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------
const failures = [];

console.log(`invoked from frontend: ${used.size}   (scanned ${files.length} files: src/** + index.html)`);
console.log(`registered:            ${registered.size}`);

console.log(
  missing.length
    ? "MISSING (invoked, not registered): " + missing.join(", ")
    : "OK: every invoked name is registered",
);
if (missing.length) failures.push(`${missing.length} invoked name(s) not registered`);

if (offAllowlist.length) {
  console.log("UNUSED (registered, no frontend caller, NOT allowlisted): " + offAllowlist.join(", "));
  failures.push(`${offAllowlist.length} unexplained dead command(s)`);
} else {
  // Round 13 (d7-3): the empty marker is `(none)`, not `none`. The consumer in
  // check-invariants.mjs splits this line on commas and used to read the word
  // "none" as a command literally named none - its PASS detail then said
  // "1 command(s) registered without a frontend caller: none".
  console.log(
    `registered but not invoked: ${uninvoked.length === 0 ? "(none)" : uninvoked.join(", ")} — all allowlisted above with a reason`,
  );
}

if (staleAllowlist.length) {
  console.log("ALLOWLIST STALE (needs no cover any more): " + staleAllowlist.join(", "));
  failures.push(`${staleAllowlist.length} stale allowlist entry(ies)`);
}

// The floor line is printed on every run, including green ones: a gate whose
// "compared against" number only appears when it fails is a gate you have to
// read the source to interpret.
const floorOk = used.size >= INVOKED_FLOOR && registered.size >= REGISTERED_FLOOR;
console.log(
  `floors: invoked ${used.size} >= ${INVOKED_FLOOR}, registered ${registered.size} >= ${REGISTERED_FLOOR} — ${floorOk ? "OK" : "VIOLATED"}`,
);
if (!floorOk) {
  failures.push("coverage collapse");
  console.log(
    `FLOOR VIOLATION: the scan found far less IPC than this contract carries (${used.size} invoked / ${registered.size} registered). ` +
      "Either the parsers stopped seeing the code (a wrapper function, a renamed marker, the wrong working directory) or a large `generate_handler!` deletion really did happen — lower the floor in this file and say why in the commit message.",
  );
}

if (failures.length) {
  console.log("FAIL: " + failures.join("; "));
  process.exitCode = 1;
}
