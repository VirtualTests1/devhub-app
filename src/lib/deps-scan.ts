import type { DependencyReport } from "../types";

/**
 * The scan runner behind 设置 → 依赖更新 (r21-n1b-2).
 *
 * `check_dependencies` (`src-tauri/src/deps.rs:42`) answers one repository at a
 * time and can take up to 30 s per repo (the npm timeout), so a 40-repo wall
 * scanned serially would hold the panel hostage for twenty minutes. This module
 * is the scheduler: a bounded worker pool over a list of slugs, with a
 * cancellation check between launches and a per-probe progress callback the UI
 * renders. Everything it needs is injected (the probe itself, the cancel flag),
 * so it stays a pure Node-importable module like its rollup sibling
 * (`lib/deps-aggregate.ts`) — the tests drive it with deferred promises and no
 * React, no IPC.
 *
 * ## The rules it owns
 *
 *   - **Concurrency cap.** `DEPS_WIDTH` probes in flight at once (the same
 *     default the clone queue settled on); the width is a parameter so a test
 *     can pin the cap at 2 without waiting for the real one.
 *   - **Rejection is an answer of its own.** A probe that throws is
 *     synthesised into `{ slug, manager: "", outdated: [], error }` — the
 *     shape the aggregate module already treats as "no answer" — never a
 *     missing row. A repo that was not asked and a repo that answered "I have
 *     nothing" are different sentences, and only one of them is true.
 *   - **Cancellation stops scheduling, not in-flight work.** A probe already
 *     running is allowed to finish and its answer is kept: the user asked to
 *     stop, not to throw away the bytes that are already on the wire. What
 *     never happens after cancel is a *new* launch.
 *   - **Output is input-ordered.** Answers come back in the order the caller
 *     listed the slugs, not the order the network finished, so a re-scan of
 *     the same selection renders the same rows in the same places.
 */

/** Default probes in flight. Matches the download queue's parallelism default. */
export const DEPS_WIDTH = 3;

export type DepsScanOptions = {
  /** Max concurrent probes; clamped to at least 1. */
  width?: number;
  /** Checked before each launch; true stops the pool from starting new work. */
  isCancelled?: () => boolean;
  /** A probe for `slug` is about to start. */
  onStart?: (slug: string) => void;
  /** A probe settled — a real report, or the synthesised rejection report. */
  onAnswer?: (slug: string, report: DependencyReport) => void;
};

/** Backend error payloads are strings; probe rejections may be anything. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run `probe` over `slugs` with a concurrency cap, answering in input order.
 *
 * The returned promise resolves once every *started* probe has settled — after
 * a cancel that means the in-flight tail, not an abort of the whole call.
 */
export async function runDepsScan(
  slugs: readonly string[],
  probe: (slug: string) => Promise<DependencyReport>,
  opts: DepsScanOptions = {},
): Promise<DependencyReport[]> {
  const width = Math.max(1, Math.floor(opts.width ?? DEPS_WIDTH));
  const answered = new Map<string, DependencyReport>();
  let next = 0;
  let active = 0;

  return new Promise<DependencyReport[]>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled || active > 0) return;
      const cancelled = opts.isCancelled?.() === true;
      if (next < slugs.length && !cancelled) return;
      settled = true;
      const out: DependencyReport[] = [];
      for (const slug of slugs) {
        const r = answered.get(slug);
        if (r) out.push(r);
      }
      resolve(out);
    };

    const pump = () => {
      while (active < width && next < slugs.length && opts.isCancelled?.() !== true) {
        const slug = slugs[next];
        next += 1;
        if (slug === undefined) break;
        active += 1;
        opts.onStart?.(slug);
        void probe(slug)
          .then((report) => {
            answered.set(slug, report);
            opts.onAnswer?.(slug, report);
          })
          .catch((err: unknown) => {
            const report: DependencyReport = {
              slug,
              manager: "",
              outdated: [],
              error: errorText(err),
            };
            answered.set(slug, report);
            opts.onAnswer?.(slug, report);
          })
          .finally(() => {
            active -= 1;
            pump();
            finish();
          });
      }
      finish();
    };

    finish();
    pump();
  });
}
