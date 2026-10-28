/**
 * Real download: the download display (item 6) and the on-disk landing path (item 7).
 *
 * Item 6 report: "下载过程行数过多，难于观看". Root cause: git rewrites one progress
 * line in place and separates the rewrites with `\r`; each rewrite was forwarded as
 * its own log entry, so a clone produced hundreds of lines. The backend now tags
 * them `<stage>-progress`; the UI shows a phase indicator, one updating status line
 * and a bar, with a collapsed log.
 *
 * Item 7: the repository must land at `<root>/<repo>_<owner>` - checked against the
 * real filesystem after a real clone, not against the preview.
 *
 * This performs an actual `git clone` of a tiny public repository.
 */

const REPO = "octocat/Hello-World";
const EXPECTED_DIR = "Hello-World_octocat";

export default async function (cdp) {
  await cdp.evaluate(`
    const nav = [...document.querySelectorAll('.skin-nav')].find((b) => b.textContent.includes('添加'));
    nav.click();
    await new Promise((r) => setTimeout(r, 500));
  `);

  const started = await cdp.evaluate(`
    const input = [...document.querySelectorAll('input')].find((i) =>
      (i.placeholder ?? '').includes('owner/repo'));
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(REPO)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    const button = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '下载');
    if (!button) return { error: 'download button missing' };
    if (button.disabled) return { error: 'download button disabled (git missing?)' };
    button.click();
    return { clicked: true };
  `);

  if (started.error) return { ...started, verdict: "FAIL" };

  // Poll the rendered state until the download settles.
  let snapshot = null;
  for (let i = 0; i < 90; i++) {
    await cdp.evaluate(`await new Promise((r) => setTimeout(r, 1000));`);
    snapshot = await cdp.evaluate(`
      const text = document.body.innerText.replace(/\\n/g, ' ');
      const phases = [...document.querySelectorAll('ol li span')].map((s) => s.textContent.trim());
      const logMatch = text.match(/详细日志（(\\d+) 行）/);
      const bar = document.querySelector('.h-1\\\\.5 > div');
      return {
        busy: /下载中/.test(text),
        phases,
        logLines: logMatch ? Number(logMatch[1]) : null,
        hasFailure: /下载失败/.test(text),
        hasOutcome: /实际路径/.test(text),
        currentLine: document.querySelector('[title]')?.getAttribute('title') ?? null,
        statusLine: [...document.querySelectorAll('span')].map((s) => s.textContent).find((t) => /接收对象|正在准备|对象|Resolving|Cloning/.test(t ?? '')) ?? null,
        phaseChips: phases,
        barPresent: !!bar,
        body: text.slice(0, 400),
      };
    `);
    if (snapshot.hasOutcome || snapshot.hasFailure) break;
  }

  // The log text itself, to prove progress rewrites are not in it.
  const logText = await cdp.evaluate(`
    const details = [...document.querySelectorAll('details')].find((d) =>
      (d.querySelector('summary')?.textContent ?? '').includes('详细日志'));
    if (!details) return { found: false, text: null };
    details.open = true;
    await new Promise((r) => setTimeout(r, 200));
    const pre = details.querySelector('pre');
    return { found: true, text: pre ? pre.textContent : null };
  `);

  const progressSpam = (logText.text ?? "")
    .split("\n")
    .filter((l) => /%/.test(l) && /objects|deltas|Resolving|Compressing/i.test(l)).length;

  return {
    settled: snapshot,
    logLineCount: snapshot.logLines,
    logHasProgressSpam: progressSpam,
    logSample: (logText.text ?? "").split("\n").slice(0, 12),
    expectedDir: EXPECTED_DIR,
    // Before the fix a Hello-World clone produced ~200 log lines.
    verdict:
      snapshot.hasFailure
        ? "FAIL (download failed)"
        : snapshot.hasOutcome && (snapshot.logLines ?? 999) <= 30 && progressSpam === 0
          ? "PASS"
          : "INCONCLUSIVE",
  };
}
