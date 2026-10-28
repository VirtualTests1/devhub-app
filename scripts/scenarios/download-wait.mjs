/**
 * Waits for the in-flight download to settle and reports the final rendered state.
 *
 * Split out from download.mjs because this machine's link to GitHub is
 * intermittent (observed again during verification: "RPC failed; curl 28 Recv
 * failure: Connection was reset", then an automatic retry). The scenario that
 * asserts the *display* should not fail just because the network took longer than
 * one polling window.
 */

export default async function (cdp) {
  let last = null;
  for (let i = 0; i < 240; i++) {
    last = await cdp.evaluate(`
      const text = document.body.innerText.replace(/\\n/g, ' ');
      const logMatch = text.match(/详细日志（(\\d+) 行）/);
      const repos = await window.__TAURI_INTERNALS__.invoke('list_repositories');
      return {
        busy: /下载中/.test(text),
        hasOutcome: /实际路径/.test(text),
        hasFailure: /下载失败/.test(text),
        logLines: logMatch ? Number(logMatch[1]) : null,
        phases: [...document.querySelectorAll('ol li span')].map((s) => s.textContent.trim()),
        statusLine: [...document.querySelectorAll('span')]
          .map((s) => s.textContent)
          .find((t) => /接收对象|正在准备|对象|Resolving|Cloning|瞬时/.test(t ?? '')) ?? null,
        repos: repos.map((r) => r.host + '/' + r.owner + '/' + r.repo).sort(),
        excerpt: text.slice(-320),
      };
    `);
    if (last.hasOutcome || last.hasFailure) break;
    await cdp.evaluate(`await new Promise((r) => setTimeout(r, 2000));`);
  }

  const logText = await cdp.evaluate(`
    const details = [...document.querySelectorAll('details')].find((d) =>
      (d.querySelector('summary')?.textContent ?? '').includes('详细日志'));
    if (!details) return null;
    details.open = true;
    await new Promise((r) => setTimeout(r, 200));
    return details.querySelector('pre')?.textContent ?? null;
  `);
  const lines = (logText ?? "").split("\n").filter(Boolean);
  const progressSpam = lines.filter((l) => /%/.test(l) && /objects|deltas|Resolving|Compressing/i.test(l));

  return {
    settled: last,
    logLineCount: lines.length,
    progressSpamLines: progressSpam.length,
    logLines: lines,
    verdict: last.hasFailure ? "FAIL (download failed)" : last.hasOutcome ? "PASS" : "TIMEOUT",
  };
}
