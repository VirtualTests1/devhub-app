/**
 * r21-n1b-3 — the scan runner's rules, driven with deferred probes.
 *
 * `runDepsScan` (`src/lib/deps-scan.ts`) is the scheduler behind 设置 →
 * 依赖更新: a bounded worker pool over a list of slugs. Its four rules are
 * exactly the ones that are easy to break silently (a cap that stops capping,
 * a cancel that throws away in-flight work, a rejection that disappears, an
 * output order that depends on the network) — so each is pinned here with
 * hand-resolved promises rather than real IPC: the probes never touch a
 * registry, the module never imports React or Tauri, and the tests run in
 * milliseconds.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { DEPS_WIDTH, runDepsScan } from "../src/lib/deps-scan.ts";
import type { DependencyReport } from "../src/types.ts";

const report = (slug: string, outdated = 0): DependencyReport => ({
  slug,
  manager: "npm",
  outdated: Array.from({ length: outdated }, (_, i) => ({
    name: `pkg-${i}`,
    current: "1.0.0",
    wanted: "1.0.0",
    latest: "2.0.0",
  })),
  error: null,
});

/** A probe whose promises the test resolves by hand. */
function deferredProbe() {
  const pending = new Map<string, { resolve: (r: DependencyReport) => void; reject: (e: unknown) => void }>();
  const started: string[] = [];
  const probe = (slug: string): Promise<DependencyReport> => {
    started.push(slug);
    return new Promise((resolve, reject) => {
      pending.set(slug, { resolve, reject });
    });
  };
  return {
    probe,
    started,
    resolve: (slug: string) => {
      const p = pending.get(slug);
      assert.ok(p, `no pending probe for ${slug}`);
      p.resolve(report(slug));
      pending.delete(slug);
    },
    reject: (slug: string, err: unknown) => {
      const p = pending.get(slug);
      assert.ok(p, `no pending probe for ${slug}`);
      p.reject(err);
      pending.delete(slug);
    },
  };
}

test("width: never more than the cap in flight, even with 10 slugs", async () => {
  const d = deferredProbe();
  let inFlight = 0;
  let peak = 0;
  const tracking = (slug: string) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    return d.probe(slug).finally(() => {
      inFlight -= 1;
    });
  };
  const slugs = Array.from({ length: 10 }, (_, i) => `github.com/a/r${i}`);
  const done = runDepsScan(slugs, tracking, { width: 3 });
  // The first wave is launched synchronously; nothing else may start until one
  // of them settles.
  assert.deepEqual(d.started, ["github.com/a/r0", "github.com/a/r1", "github.com/a/r2"]);
  // Resolve nine one at a time; a macrotask boundary drains the then/catch/
  // finally chain so the next launch has happened before we look.
  const tick = () => new Promise<void>((r) => setImmediate(r));
  for (let i = 0; i < 9; i += 1) {
    const slug = slugs[i];
    assert.ok(slug, `slug ${i} missing`);
    d.resolve(slug);
    await tick();
    assert.ok(d.started.length <= i + 4, `wave ${i} over-launched: ${d.started.length} started`);
  }
  const last = slugs[9];
  assert.ok(last);
  d.resolve(last);
  const out = await done;
  assert.equal(peak, 3, "the cap held at 3 in flight");
  assert.equal(out.length, 10, "every slug got an answer");
});

test("default width is DEPS_WIDTH", () => {
  assert.equal(DEPS_WIDTH, 3, "the panel's footnote renders this number; it is a contract");
});

test("cancellation stops scheduling; in-flight probes still finish and are kept", async () => {
  const d = deferredProbe();
  let cancelled = false;
  const answers: string[] = [];
  const slugs = ["github.com/a/one", "github.com/a/two", "github.com/a/three", "github.com/a/four"];
  const done = runDepsScan(slugs, d.probe, {
    width: 2,
    isCancelled: () => cancelled,
    onAnswer: (slug) => answers.push(slug),
  });
  assert.deepEqual(d.started, ["github.com/a/one", "github.com/a/two"], "first wave only");
  cancelled = true;
  d.resolve("github.com/a/one");
  d.resolve("github.com/a/two");
  const out = await done;
  assert.deepEqual(
    d.started,
    ["github.com/a/one", "github.com/a/two"],
    "nothing new was scheduled after the cancel flag flipped",
  );
  assert.deepEqual(
    out.map((r) => r.slug),
    ["github.com/a/one", "github.com/a/two"],
    "the in-flight answers were kept, not discarded",
  );
  assert.deepEqual(answers, ["github.com/a/one", "github.com/a/two"], "progress callbacks saw them too");
});

test("rejection becomes a manager:\"\" error report, never a missing row", async () => {
  const d = deferredProbe();
  const slugs = ["github.com/a/ok", "github.com/a/bad"];
  const done = runDepsScan(slugs, d.probe, { width: 2 });
  assert.deepEqual(d.started, slugs, "both probes launched");
  d.resolve("github.com/a/ok");
  d.reject("github.com/a/bad", new Error("spawn ENOENT"));
  const out = await done;
  assert.equal(out.length, 2, "a rejection is an answer — both slugs produced a row");
  const bad = out.find((r) => r.slug === "github.com/a/bad");
  assert.ok(bad, "the rejected slug still has a row");
  assert.equal(bad.manager, "", "manager \"\" is the no-answer shape the aggregate module understands");
  assert.deepEqual(bad.outdated, [], "no phantom packages from a failure");
  assert.equal(bad.error, "spawn ENOENT", "the rejection's own words survive");
  const ok = out.find((r) => r.slug === "github.com/a/ok");
  assert.ok(ok);
  assert.equal(ok.error, null, "the clean answer is untouched by its neighbour's failure");
});

test("output is input-ordered even when answers arrive out of order", async () => {
  const d = deferredProbe();
  const slugs = ["github.com/a/zzz", "github.com/a/aaa", "github.com/a/mmm"];
  const done = runDepsScan(slugs, d.probe, { width: 3 });
  // Resolve in reverse arrival order.
  d.resolve("github.com/a/mmm");
  d.resolve("github.com/a/zzz");
  d.resolve("github.com/a/aaa");
  const out = await done;
  assert.deepEqual(
    out.map((r) => r.slug),
    slugs,
    "the caller's order is the render order; the network's order is an accident",
  );
});

test("empty input resolves immediately with no probes", async () => {
  const d = deferredProbe();
  const out = await runDepsScan([], d.probe);
  assert.deepEqual(out, []);
  assert.deepEqual(d.started, [], "nothing was started");
});

test("a width of 0 or negative is clamped to at least 1", async () => {
  const d = deferredProbe();
  const done = runDepsScan(["github.com/a/only"], d.probe, { width: 0 });
  assert.deepEqual(d.started, ["github.com/a/only"], "the single slug still got probed");
  d.resolve("github.com/a/only");
  const out = await done;
  assert.equal(out.length, 1);
});
