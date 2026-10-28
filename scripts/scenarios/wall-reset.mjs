/**
 * Reset the project wall to factory defaults and prove it took.
 *
 * The verification runs left aliases, a manual order and a hidden flag behind on
 * this machine; 重置 is the control that is supposed to clear exactly that, so it
 * doubles as the check.
 */
import { NAV } from "../nav.mjs";

export default async function (cdp) {
  await cdp.evaluate(`
    ${NAV}
    await gotoSettings(600);
    // 项目页 is its own catalog page since round 9 — the section only exists once
    // that page is open, so asking for 重置 without it measured nothing at all.
    await openSettingsPage('项目页', 600);
    const sec = document.querySelector('[data-section="projects"]');
    const btn = [...sec.querySelectorAll('button')].find((b) => b.textContent.trim() === '重置');
    btn?.click();
    await new Promise((s) => setTimeout(s, 700));
  `);

  const stored = await cdp.evaluate(
    `return localStorage.getItem('devhub.wall.v1');`,
  );

  await cdp.evaluate(`
    ${NAV}
    await gotoView('projects', 1200);
  `);

  const wall = await cdp.evaluate(`
    return {
      tiles: document.querySelectorAll('.skin-card').length,
      first: ([...document.querySelectorAll('.skin-card')]
        .map((b) => (b.getAttribute('title') ?? '').split('\\n')[0])[0]) ?? null,
      counter: ([...document.querySelectorAll('span,div,p')]
        .map((e) => e.textContent.trim())
        .find((t) => /^显示 \\d+ \\/ \\d+$/.test(t))) ?? null,
      toast: ([...document.querySelectorAll('div')]
        .map((d) => d.textContent.trim())
        .find((t) => t.includes('项目页设置已重置'))) ? 'seen' : null,
    };
  `);

  // Evidence without a verdict reads as "nothing happened" in the summary table,
  // which is how a broken scenario hides. What 重置 promises is exactly three
  // things: no per-repository display facts left, nothing hidden, and a toast.
  let parsed = null;
  try {
    parsed = stored ? JSON.parse(stored) : {};
  } catch {
    parsed = null;
  }
  const perRepo = parsed ? Object.keys(parsed.repos ?? {}) : null;
  const frac = (wall.counter ?? '').match(/(\d+)\s*\/\s*(\d+)/);

  return {
    storedAfterReset: stored,
    perRepoCount: perRepo ? perRepo.length : null,
    wall,
    consoleErrors: cdp.consoleErrors,
    verdict:
      parsed &&
      perRepo.length === 0 &&
      frac &&
      frac[1] === frac[2] &&
      wall.toast === 'seen' &&
      cdp.consoleErrors.length === 0
        ? 'PASS'
        : 'FAIL',
  };
}
