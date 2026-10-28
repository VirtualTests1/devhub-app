import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

/**
 * Trees the dev server must not watch.
 *
 * Two separate reasons:
 *
 *   - `src-tauri` is cargo's world. Vite has no use for it, and the Rust build
 *     rewrites `target/` continuously.
 *   - The **project container** is the user's repositories. DevHub is a launcher
 *     whose configured roots can point anywhere - including inside this working
 *     copy, which is what `extraRoots` in a dev config tends to hold after a test
 *     download. Watching it means chokidar holds a descriptor for every directory
 *     of every cloned repository, `node_modules` included. It is also the one
 *     place a clone can reach Vite's own reactions: a repository that ships an
 *     `.html` file makes Vite send a **full page reload** for it (measured:
 *     `[watch] … (0 graph module(s))` followed by `page reload …`), and a clone
 *     writes plenty of those. That is the mechanism behind "点了下载之后页面反复刷新".
 *
 * **These are directory names, and they are anchored to the project directory on
 * purpose.** Chokidar matches a glob against the whole absolute path, so a pattern
 * written as "any depth, then `.wt`, then any depth" - meant to exclude the nested
 * worktrees - also matches *this* working copy when it is itself a worktree under
 * `.wt/`, and silently ignores the entire project. That was measured, not
 * theorised: with the unanchored list, touching `index.html` produced no reaction
 * at all, while the previous config logged `page reload index.html`. A watcher
 * that watches nothing looks exactly like a dev server with no reload problem.
 */
const NEVER_WATCH = [
  "src-tauri", // cargo's world, and `target/` is rewritten continuously
  ".pack", // portable packaging output, holds real repositories
  ".shots",
  ".cardshow",
  ".cdpfixtures",
  ".wt", // nested git worktrees: a second copy of everything
  ".worktrees", // the parallel agent checkouts this repo actually uses most
  //   (`git worktree list` shows `.worktrees/*` and `.wt/round10-ui`). eslint.config.js
  //   already ignores `.worktrees/**`, but until now this watcher did not — and a
  //   another stream's mid-edit `.html` (see the full-reload note above) inside
  //   `.worktrees/` would blank this dev window on every save. Both roots now covered.
  "portable",
  "dist", // vite's own build output
];

/** Chokidar's own defaults, restated: overriding `ignored` replaces the list. */
const ALWAYS_IGNORED = ["**/node_modules/**", "**/.git/**"];

/** Every project root the app is configured to scan, absolute, inside this folder. */
function configuredContainers(cwd: string): string[] {
  const candidates: string[] = [];
  if (process.env.DEVHUB_PROJECT_ROOT) candidates.push(process.env.DEVHUB_PROJECT_ROOT);

  // A development run keeps its config next to `Cargo.toml` (see
  // `bundled_runtime_dir`); a packaged one keeps it beside the exe.
  for (const rel of ["src-tauri/devhub-config.json", "devhub-config.json"]) {
    const file = path.resolve(cwd, rel);
    if (!existsSync(file)) continue;
    try {
      const cfg = JSON.parse(readFileSync(file, "utf8")) as {
        projectRoot?: string;
        extraRoots?: string[];
      };
      if (cfg.projectRoot?.trim()) candidates.push(cfg.projectRoot.trim());
      for (const extra of cfg.extraRoots ?? []) if (extra.trim()) candidates.push(extra.trim());
    } catch {
      // A half-written config must not stop the dev server.
    }
    break;
  }

  return candidates
    .map((p) => path.resolve(p))
    // Only roots inside the working copy are Vite's problem; anything else was
    // never in the watched tree to begin with.
    .filter((p) => {
      const rel = path.relative(cwd, p);
      return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
    });
}

/**
 * The file the probe writes under the Vite root, and removes again.
 *
 * Deliberately an `.html`: that is the file type that produced the reported
 * reloads (Vite sends a full reload for any changed `.html`, whether or not it is
 * in the module graph), so the sentinel exercises the same path as the bug.
 */
const PROBE_FILE = ".devhub-watch-probe.html";

/** `0` / `off` / `none` / empty means OFF, matching `DEVHUB_TIMING` in `lib.rs`. */
function watchLogEnabled(): boolean {
  const v = process.env.DEVHUB_WATCH_LOG?.trim().toLowerCase();
  return !!v && v !== "0" && v !== "off" && v !== "none";
}

/**
 * `DEVHUB_WATCH_LOG=1` prints what the dev server reacts to, which is the only
 * honest way to investigate "热更新频繁触发 page reload".
 *
 * Three lines matter. `[watch] change <file>` is every event the watcher
 * forwarded, `<file> (N graph module(s))` is what Vite could do with it, and
 * `FULL RELOAD` is the message that actually blanks the window - so a report can
 * be matched to the file that caused it instead of to a guess. A file with
 * `0 graph modules` is one Vite saw but has no use for, which is exactly the
 * distinction the ignore list is built on.
 *
 * The value is read like the Rust side reads `DEVHUB_TIMING` and
 * `DEVHUB_NO_INDEX`: `0`/`off`/`none`/empty turn it OFF. Truthiness alone made
 * `DEVHUB_WATCH_LOG=0` switch the log on, which is the opposite of what the
 * person typing it means.
 *
 * ## The self-test exists because a dead probe looks exactly like a quiet server
 *
 * The first investigation of this bug concluded "not reproducible", and the
 * instrument could not have said anything else: the HMR websocket needs
 * `?token=` on Vite 8, so a client connected and received nothing, and a
 * depth-only chokidar glob silently ignored the whole project when the checkout
 * itself lived under `.wt/`. Both failures print the same blank as success.
 *
 * So the probe must produce a POSITIVE before its later silence means anything:
 * it writes and then edits `PROBE_FILE` under the root and requires at least one
 * watcher event for it. If that fails, it says so in the same voice it will use
 * for every other line, and "no events" stops being evidence.
 *
 * Cost, stated because it is real: the sentinel causes one full reload of the dev
 * window at startup, and leaves a file behind if the process is killed mid-test.
 * Both are why this only runs when the flag is on, and why `PROBE_FILE` is
 * git-ignored.
 */
function watchLog() {
  let probeEvents = 0;
  let probeStarted = false;

  const runProbe = (root: string) => {
    if (probeStarted) return;
    probeStarted = true;
    const file = path.join(root, PROBE_FILE);
    const verdict = (outcome: string) => console.log(`[watch] SELF-TEST ${outcome}`);
    try {
      writeFileSync(file, "<!doctype html>\n<title>devhub watch probe</title>\n");
    } catch (err) {
      verdict(`FAILED TO START - cannot write ${PROBE_FILE} (${String(err)})`);
      return;
    }
    setTimeout(() => {
      // chokidar's `add` already proves it can see the path; the `change` is the
      // event that reaches Vite's reload decision, so write twice.
      try {
        appendFileSync(file, "<!-- touched -->\n");
      } catch {
        /* the verdict below reports whatever did or did not arrive */
      }
    }, 300);
    setTimeout(() => {
      rmSync(file, { force: true });
      verdict(
        probeEvents > 0
          ? `PASS - the sentinel drew ${probeEvents} event(s); silence about an ignored tree below is the ignore list working`
          : `FAILED - nothing arrived for a file we just wrote and changed. Every "no events" below is unproven, not a clean result`,
      );
    }, 2000);
  };

  return {
    name: "devhub-watch-log",
    configureServer(server: {
      hot: { send: (payload: unknown) => void };
      watcher: {
        on: (event: string, cb: (event: string, file: string) => void) => void;
        once: (event: string, cb: () => void) => void;
      };
    }) {
      const send = server.hot.send.bind(server.hot);
      server.hot.send = (payload: unknown) => {
        const p = payload as { type?: string; path?: string };
        if (p?.type === "full-reload") {
          console.log(`[watch] FULL RELOAD ${p.path ?? "(no path)"}`);
        }
        send(payload);
      };
      server.watcher.on("all", (event: string, file: string) => {
        if (path.basename(file) === PROBE_FILE) probeEvents += 1;
        console.log(`[watch] ${event} ${path.relative(process.cwd(), file)}`);
      });
      // Wait for the watcher to finish its initial scan, or the probe would be
      // racing a tree that is not being watched yet and could read as a failure
      // of the ignore list. The timer is the fallback for a `ready` that never
      // arrives: a probe that cannot run must say so rather than go quiet.
      server.watcher.once("ready", () => setTimeout(() => runProbe(process.cwd()), 400));
      setTimeout(() => runProbe(process.cwd()), 12_000);
    },
    handleHotUpdate(ctx: { file: string; modules: unknown[] }) {
      console.log(
        `[watch] ${path.relative(process.cwd(), ctx.file)} (${ctx.modules.length} graph module(s))`,
      );
    },
  };
}

/** Chokidar matches forward-slash paths, including on Windows. */
const toPosix = (p: string) => p.split(path.sep).join("/");

// https://vite.dev/config/
export default defineConfig(({ command }) => {
  const cwd = process.cwd();
  const containers = configuredContainers(cwd);
  const ignored = [
    ...ALWAYS_IGNORED,
    ...NEVER_WATCH.map((d) => `${toPosix(path.join(cwd, d))}/**`),
    ...containers.map((p) => `${toPosix(p)}/**`),
  ];
  if (command === "serve") {
    console.log(
      `[devhub] not watching: ${NEVER_WATCH.length} local trees` +
        (containers.length ? ` + ${containers.length} project root(s) inside the checkout` : ""),
    );
  }

  return {
    plugins: [react(), tailwindcss(), ...(watchLogEnabled() ? [watchLog()] : [])],
    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    //
    // 1. prevent Vite from obscuring rust errors
    clearScreen: false,
    // 2. tauri expects a fixed port, fail if that port is not available.
    //    `scripts/port-guard.ps1` names whoever holds it before this fails.
    server: {
      port: 1420,
      strictPort: true,
      host: host || false,
      // Start transforming the entry graph as soon as the server is up, instead of
      // when the webview first asks for it. In `tauri dev` the CLI waits for this
      // port before launching the exe, so anything that shortens the first response
      // is time nobody stares at: the reported "加载很长一段时间" is this phase, not
      // the app.
      //
      // Honest limit: no before/after number is claimed here. The two measurements
      // attempted for it were invalid - another application's `vite build` was
      // running against the same shared `node_modules` cache, and a cold figure taken
      // under that contention (98 s) says nothing about a quiet machine.
      warmup: {
        clientFiles: ["./src/main.tsx"],
      },
      hmr: host
        ? {
            protocol: "ws",
            host,
            port: 1421,
          }
        : undefined,
      watch: {
        ignored,
      },
    },
    // 3. Release builds ship source maps. The only on-the-ground diagnostic layer
    //    this app has is `src/lib/report-error.ts`, which shows a raw stack when
    //    something goes wrong; without maps that stack is minified identifiers and
    //    line numbers that point into a compressed blob.
    //
    //    A trap, measured rather than warned about: do NOT set `sourcemap: "cheap"`
    //    to save build time. Rollup accepts that value; Rolldown (Vite 8, what this
    //    repo builds with) does not — it prints `unknown sourcemap: cheap`, builds
    //    "successfully" and emits **zero** `.map` files. Full speed, no symbolication,
    //    reported as a pass.
    //
    //    What maps cost here could not be isolated, and an earlier draft of this
    //    comment claimed they cost ~168 s. That was wrong and is retracted: four
    //    builds on this machine, same tree, came out at 3 m 9 s (maps on, cold),
    //    20.8 s (maps off, warm), 2 m 5 s (maps off) and 4.9 s (maps on). The slow
    //    runs are the ones Vite's `[PLUGIN_TIMINGS]` note attributes ~99 % to
    //    `@tailwindcss/vite:generate:build`, and the ordering against maps is
    //    inconsistent, so build duration is dominated by something else (cache state
    //    at minimum). Maps stay on; nobody should quote a number for their cost until
    //    it is measured with repetitions.
    //
    //    R18-O3 resolved that "something else": it was Tailwind's source scan, and
    //    `src/index.css` now registers `src/` and `index.html` explicitly instead
    //    of letting the scanner start from cwd. The scanner read the ROOT
    //    `.gitignore` only, so `src-tauri/target` (24 GB, ignored solely by the
    //    NESTED `src-tauri/.gitignore`) and every checkout under `.worktrees/` were
    //    scanned on each build — 164 s in `@tailwindcss/vite:generate:build` in one
    //    probe, 600 s+ with the build still in `transforming` in another, while the
    //    same tree without those directories built in 12 s. After the change the
    //    generate step is ~1.5 s regardless of what sits ignored-but-unscanned
    //    beside the checkout, so the variability above is gone, not merely rarer.
    build: {
      sourcemap: true,
      // 4. Vite warns at 500 kB per chunk by default and this app's entry chunk
      //    has been over that line for a while (measured: 553 kB at round 12).
      //    The threshold is raised rather than the warning silenced, so a genuine
      //    regression past 600 kB still surfaces. Splitting the entry is a
      //    separate piece of work; this only makes the current size visible
      //    instead of buried in a build log nobody reads.
      chunkSizeWarningLimit: 600,
      // Round 13 (d6-3): split the heavy third-party vendors out of the entry
      // chunk so the application code and each framework update land in their
      // own cacheable files. The entry was a single ~550 kB blob; grouping by the
      // top-level package keeps React/Tauri-API/Monaco-style deps isolated from
      // first-party code without hand-maintaining a per-module allowlist (which
      // is exactly the brittle thing the audit flagged). First-party code stays
      // in the entry chunk, which is what benefits most from the app changing.
      rollupOptions: {
        output: {
          manualChunks(id) {
            // First-party shared UI: keep the toast host and the dialog frame in their
            // own cacheable chunk. Without this, the lazy card dialogs make Rolldown
            // hoist both into the entry chunk (entry 163→328 kB in r22-O4); with it the
            // entry stays the wall, and both chunks are modulepreloaded like before.
            if (/[\/]src[\/](components[\/]Toast|components[\/]DialogShell|lib[\/]confirm)\.tsx?$/.test(id)) {
              return "ui-shared";
            }
            if (!id.includes("node_modules")) return undefined;
            // Handle both layouts: npm/yarn put the package directly under
            // `node_modules/<pkg>`, but pnpm nests it under
            // `node_modules/.pnpm/<pkg>@<ver>/node_modules/<pkg>` — so the
            // segment right after the FIRST `node_modules/` is `.pnpm/...`,
            // not the package. Walk to the real package name.
            let rest = id.slice(id.indexOf("node_modules/") + "node_modules/".length);
            if (rest.startsWith(".pnpm/")) {
              const pnpmTail = id.slice(id.indexOf(".pnpm/") + ".pnpm/".length);
              rest = pnpmTail.includes("/node_modules/")
                ? pnpmTail.slice(pnpmTail.indexOf("/node_modules/") + "/node_modules/".length)
                : pnpmTail;
            }
            const seg = rest.split("/");
            // noUncheckedIndexedAccess（r19-o2-4）：split 的产物一定有首元素，
            // 但类型不说这件事——显式兜底，不用 `!`。语义不变：head 为 "" 时
            // 不走 @scope 分支，与从前 seg[0] 非空时的行为逐字节一致。
            const head = seg[0] ?? "";
            const top = head.startsWith("@") ? `${head}/${seg[1] ?? ""}` : head;
            return `vendor-${top.replace(/[^a-z0-9]/gi, "-")}`;
          },
        },
      },
    },
  };
});
