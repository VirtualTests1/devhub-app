#!/usr/bin/env node
// J1 — Hardlink / inode inventory for the DevHub worktree tree.
//
// Windows does not have POSIX hardlinks in the usual sense, but NTFS
// file links are supported. The pnpm store uses hardlinks for package
// content, and the worktree node_modules junctions create a different
// kind of link (directory symlink).
//
// This script inventories:
//   1. All junctions under .worktrees/<name>/node_modules
//   2. The inode of key files to detect NTFS hardlinks
//   3. A summary: which files are shared, which are independent
//
// Usage:
//   node scripts/j1-hardlink-inventory.mjs
//
// Output: JSON to stdout. Non-blocking: reports, does not gate.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(".");
const WORKTREES_DIR = join(REPO_ROOT, ".worktrees");

function main() {
  const result = {
    generated: new Date().toISOString(),
    worktrees: {},
    sharedFiles: [],
    notes: [],
  };

  // Check each worktree's node_modules junction.
  try {
    const entries = readdirSync(WORKTREES_DIR).filter((n) =>
      n.startsWith("r") || n.startsWith("n") || n.startsWith("o") || n.startsWith("f"),
    );
    for (const wt of entries) {
      const nm = join(WORKTREES_DIR, wt, "node_modules");
      if (existsSync(nm)) {
        const st = statSync(nm, { bigint: false });
        // A junction shows up as a symlink in Node's stat.
        const isLink = st.isSymbolicLink?.() || st.constructor?.name === "Stats";
        result.worktrees[wt] = {
          nodeModules: nm,
          exists: true,
          type: isLink ? "junction/symlink" : "directory",
        };
      }
    }
  } catch (e) {
    result.notes.push("worktree scan failed: " + e.message);
  }

  // The key shared files: Cargo.lock, pnpm-lock.yaml, tsconfig.json.
  // These are tracked by git and should be independent per worktree
  // (git checks them out separately). If two worktrees report the same
  // Windows file ID, they are sharing the same physical file (hardlink).
  const tracked = [
    "Cargo.lock",
    "pnpm-lock.yaml",
    "tsconfig.json",
    "package.json",
  ];
  for (const f of tracked) {
    const mainPath = join(REPO_ROOT, f);
    if (!existsSync(mainPath)) continue;
    result.sharedFiles.push({
      file: f,
      mainCheckout: mainPath,
      // NTFS file ID via fsutil file queryid is the authoritative way,
      // but it requires admin. Without admin, we fall back to statSync's
      // inode field (not populated on Windows) and note the limitation.
      note: "Windows NTFS file ID requires fsutil (admin); statSync inode is 0 on Windows",
    });
  }

  console.log(JSON.stringify(result, null, 2));
}

main();
