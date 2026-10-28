/**
 * Download display (item 6), proven without the network.
 *
 * `try_git` passes `git clone --progress`, and git emits one in-place rewrite per
 * percent. Measured locally: the same clone prints **1 line** without `--progress`
 * and **77 lines** with it - so a large repository produced hundreds of log entries.
 * That is the "下载过程行数过多" report.
 *
 * The backend now routes those rewrites to a `<stage>-progress` channel; they update
 * one status line and a bar and never enter the log. This scenario clones a real
 * local repository (so it does not depend on github.com being reachable, which it
 * was not during verification) and counts both streams separately:
 *
 *   logLines      - entries in the collapsed 详细日志
 *   progressTicks - distinct percentage readings observed while it ran
 *
 * Expected shape: a handful of log lines, many progress ticks.
 */

import { join } from "node:path";

const SOURCE = join(process.cwd(), ".pack", "项目", "code", "github.com", "HRuiCcc", "RuiC-motion-reel");
const EXPECTED_DIR = "RuiC-motion-reel_HRuiCcc";

export default async function (cdp) {
  await cdp.evaluate(`
    const nav = [...document.querySelectorAll('.skin-nav')].find((b) => b.textContent.includes('添加'));
    nav.click();
    await new Promise((r) => setTimeout(r, 500));
  `);

  const preview = await cdp.evaluate(`
    const input = [...document.querySelectorAll('input')].find((i) =>
      (i.placeholder ?? '').includes('owner/repo'));
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(SOURCE)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 900));
    const m = document.body.innerText.replace(/\\s+/g, ' ').match(/落位\\s*(\\S+)/);
    return m ? m[1] : null;
  `);

  const started = await cdp.evaluate(`
    const button = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '下载');
    if (!button || button.disabled) return { error: 'download button unavailable' };
    button.click();
    return { clicked: true };
  `);
  if (started.error) return { preview, ...started, verdict: "FAIL" };

  // Sample while it runs: which percentages appear on the status line, and how
  // many log entries the log is accumulating.
  let ticks = [];
  let logPeak = 0;
  let settled = null;
  for (let i = 0; i < 120; i++) {
    const snap = await cdp.evaluate(`
      const text = document.body.innerText.replace(/\\n/g, ' ');
      const logMatch = text.match(/详细日志（(\\d+) 行）/);
      const pctMatch = text.match(/(\\d{1,3})%/);
      return {
        busy: /下载中/.test(text),
        hasOutcome: /实际路径/.test(text),
        hasFailure: /下载失败/.test(text),
        logLines: logMatch ? Number(logMatch[1]) : 0,
        visiblePercent: pctMatch ? Number(pctMatch[1]) : null,
        phases: [...document.querySelectorAll('ol li span')].map((s) => s.textContent.trim()),
        statusLine: [...document.querySelectorAll('span')]
          .map((s) => s.textContent)
          .find((t) => /对象|Receiving|Resolving|正在准备/.test(t ?? '')) ?? null,
      };
    `);
    if (snap.visiblePercent !== null) ticks.push(snap.visiblePercent);
    if (snap.statusLine && /%/.test(snap.statusLine)) ticks = ticks.concat(
      (snap.statusLine.match(/(\d{1,3})%/g) ?? []).map((s) => Number(s.replace("%", ""))),
    );
    logPeak = Math.max(logPeak, snap.logLines);
    settled = snap;
    if (snap.hasOutcome || snap.hasFailure) break;
    await cdp.evaluate(`await new Promise((r) => setTimeout(r, 250));`);
  }

  const logText = await cdp.evaluate(`
    const details = [...document.querySelectorAll('details')].find((d) =>
      (d.querySelector('summary')?.textContent ?? '').includes('详细日志'));
    if (!details) return null;
    details.open = true;
    await new Promise((r) => setTimeout(r, 200));
    return details.querySelector('pre')?.textContent ?? null;
  `);
  const logLines = (logText ?? "").split("\n").filter(Boolean);

  const uniqueTicks = [...new Set(ticks)].sort((a, b) => a - b);

  return {
    preview,
    expectedDir: EXPECTED_DIR,
    previewIsFlat: (preview ?? "").endsWith(EXPECTED_DIR),
    settled,
    logLineCount: logLines.length,
    logLines,
    progressTicksSeen: uniqueTicks.length,
    progressTickSample: uniqueTicks.slice(0, 8),
    // The heart of the fix: many progress rewrites, few log entries.
    logHasNoProgressRewrites: !logLines.some((l) => /%/.test(l) && /objects|deltas|Resolving/i.test(l)),
    verdict:
      settled?.hasFailure
        ? "FAIL (clone failed)"
        : settled?.hasOutcome && uniqueTicks.length > 5 && logLines.length <= 12
          ? "PASS"
          : "INCONCLUSIVE",
  };
}
