/**
 * Idle-cost baseline: the r21-O2 measurements, made repeatable (r21-O2-3).
 *
 * WHY THIS EXISTS
 *   r21-O2 sampled the idle app for real (`docs/r21-idle-sample.md`) and ablated the
 *   three `additionalBrowserArgs` switches (`docs/r21-webview2-arg-ablation.md`).
 *   Verdict on all three: 无法判定 — every config difference sat inside the
 *   same-config replicate noise. When a comparison cannot decide, the honest landing
 *   is a repeatable assertion instead of a config change, and this scenario is it:
 *   every number below is a bound taken from the 2026-10-19 readings, so the next
 *   round can tell "idle cost moved" from "the machine was busy".
 *
 * WHAT IT ASSERTS (bounds → measured origin, same day, same sampler)
 *   Documents    ≤ 5      (steady state measured 1; right after the runner's reload the
 *                          reloaded-away document lingers — measured 3 in the window,
 *                          with lazy collection taking 7–13+ s here — so the bound gives
 *                          the post-reload state room for one more stale document from a
 *                          previous scenario instead of flaking)
 *   LayoutObjects ≤ 400   (measured 276 steady / 325 in the post-reload window)
 *   JS heap peak ≤ 30 MB  (measured 18.66–19.07 MB steady, 20.1–22.4 MB post-reload)
 *   node growth  ≤ 10 / s (measured ≈ 4 / s — a known detached-node accumulation,
 *                          see docs/r21-idle-sample.md §5; the bound is a ratchet
 *                          that catches runaway leaks without failing on today's rate;
 *                          computed over the steady tail only, never across a
 *                          document teardown)
 *   live DOM     ≤ 800 elements (measured 238)
 *
 * The window mirrors the sampler's cadence: after a reload, 8 s for the wall scan AND
 * the reloaded-away document to be collected (7–13+ s, measured here), then
 * 6 samples × 1000 ms; the growth rate is taken over the steady tail only. It runs
 * through scripts/cdp.mjs like every other scenario, so verify-fixes.ps1 picks it up
 * automatically (it sorts under `i-…`).
 */
export default async function (cdp) {
  const BOUNDS = {
    documentsMax: 5,
    layoutObjectsMax: 400,
    heapPeakBytes: 30_000_000,
    nodeGrowthPerSecondMax: 10,
    liveElementsMax: 800,
  };

  await cdp.send("Performance.enable");
  // Two things must finish before sampling starts. (1) list_repositories — or the
  // growth rate measures the wall scan instead of idle cost. (2) The RELOADED-away
  // document — measured on this machine: after cdp.reload() reports mounted, the old
  // document (Documents=3, heap +3.3 MB) is still alive for ~7 s, and its disposal
  // mid-window would subtract ~55 nodes from the growth rate and mask a real leak.
  // 8 s covered it with margin in the verification run below.
  await new Promise((r) => setTimeout(r, 8000));

  const samples = [];
  const SAMPLES = 6;
  const INTERVAL_MS = 1000;
  for (let i = 0; i < SAMPLES; i++) {
    const { metrics } = await cdp.send("Performance.getMetrics");
    const pick = (name) => metrics.find((m) => m.name === name)?.value ?? null;
    const live = await cdp.evaluate(`
      return {
        elements: document.querySelectorAll('*').length,
        dialogs: document.querySelectorAll('[role="dialog"]').length,
        tiles: document.querySelectorAll('[data-layer="repo-tile"], .repo-grid > *').length,
      };
    `);
    samples.push({
      at: Date.now(),
      heap: pick("JSHeapUsedSize"),
      documents: pick("Documents"),
      nodes: pick("Nodes"),
      layoutObjects: pick("LayoutObjects"),
      ...live,
    });
    if (i < SAMPLES - 1) await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }

  const first = samples[0];
  const last = samples[samples.length - 1];
  // Steady tail: if the old document outlived the settle, rate is computed only over
  // the contiguous tail that shares the final Documents value — the pre-drop samples
  // measure teardown, not idle.
  let tailStart = samples.length - 1;
  while (tailStart > 0 && samples[tailStart - 1].documents === last.documents) tailStart--;
  const tail = samples.slice(tailStart);
  const tailFirst = tail[0];
  const seconds = (last.at - tailFirst.at) / 1000;
  const readings = {
    seconds,
    steadySamples: tail.length,
    heapStart: first.heap,
    heapPeak: Math.max(...samples.map((s) => s.heap)),
    documentsMax: Math.max(...samples.map((s) => s.documents)),
    layoutObjectsMax: Math.max(...samples.map((s) => s.layoutObjects)),
    nodesStart: tailFirst.nodes,
    nodesEnd: last.nodes,
    nodeGrowthPerSecond: seconds > 0 ? (last.nodes - tailFirst.nodes) / seconds : 0,
    liveElementsMax: Math.max(...samples.map((s) => s.elements)),
    dialogs: last.dialogs,
    tiles: last.tiles,
    consoleErrors: cdp.consoleErrors,
  };

  const failures = [];
  if (readings.steadySamples < 2) {
    failures.push(`steady tail ${readings.steadySamples} sample(s) — growth rate not measurable`);
  }
  if (readings.documentsMax > BOUNDS.documentsMax) {
    failures.push(`Documents ${readings.documentsMax} > ${BOUNDS.documentsMax}`);
  }
  if (readings.layoutObjectsMax > BOUNDS.layoutObjectsMax) {
    failures.push(`LayoutObjects ${readings.layoutObjectsMax} > ${BOUNDS.layoutObjectsMax}`);
  }
  if (readings.heapPeak > BOUNDS.heapPeakBytes) {
    failures.push(`heap peak ${readings.heapPeak} > ${BOUNDS.heapPeakBytes}`);
  }
  if (readings.nodeGrowthPerSecond > BOUNDS.nodeGrowthPerSecondMax) {
    failures.push(`node growth ${readings.nodeGrowthPerSecond.toFixed(1)}/s > ${BOUNDS.nodeGrowthPerSecondMax}/s`);
  }
  if (readings.liveElementsMax > BOUNDS.liveElementsMax) {
    failures.push(`live DOM ${readings.liveElementsMax} > ${BOUNDS.liveElementsMax}`);
  }
  // An idle baseline with page exceptions on screen is not a baseline.
  if (cdp.consoleErrors.length > 0) {
    failures.push(`${cdp.consoleErrors.length} console error(s) while idle`);
  }

  return {
    verdict: failures.length === 0 ? "PASS" : "FAIL",
    bounds: BOUNDS,
    readings,
    failures,
    samples: samples.map(({ at, ...rest }) => rest),
  };
}
