/**
 * Round 18, N3-2/N3-3: the 从星标导入 panel on the 添加 view.
 *
 * The panel's contract in one scenario: it exists, it starts collapsed, expanding
 * shows the explicit 「载入我的星标」 button (nothing loads on its own), and that
 * button ends in one of exactly four honest states — a selectable row list, an
 * empty-but-loaded page, a missing-token error with the 去设置 Token jump, or a
 * transient error with the retry button. All four are PASS here: the token may
 * or may not be configured on this machine and GitHub may or may not be
 * reachable, and a scenario that only passes with a token would manufacture
 * failures it did not cause (the same reasoning as r16-language's restoration
 * step).
 *
 * Deliberately NOT exercised: clicking 下载选中. With a live token that would
 * start real downloads; the selection/queue interplay is pinned deterministically
 * in `tests/star-import-ui.test.ts` instead.
 */
import { NAV } from "../nav.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function (cdp) {
  const out = {};
  let passed = false;
  // No state to restore: the panel writes nothing (no localStorage keys, no
  // settings), and collapsing it below puts the DOM back the way we found it.

  /**
   * One snapshot of the panel. Text-matching for buttons, class-matching for
   * the error paragraph — both are how the surrounding scenarios read surfaces
   * that carry no `data-reg-id` of their own.
   */
  const snap = () =>
    cdp.evaluate(`
      const panel = document.querySelector('[data-reg-id="add-stars-panel"]');
      if (!panel) return null;
      const bar = panel.querySelector('button[aria-expanded]');
      const err = panel.querySelector('[class*="text-danger"]');
      const buttons = [...panel.querySelectorAll('button')].map((b) => b.textContent.trim());
      const rows = [...panel.querySelectorAll('li')].map((li) =>
        li.textContent.replace(/\\s+/g, ' ').trim().slice(0, 90));
      return {
        titlePresent: (panel.textContent ?? '').includes('从星标导入'),
        hintPresent: (panel.textContent ?? '').includes('读取你 GitHub 账号的 Star'),
        expanded: bar ? bar.getAttribute('aria-expanded') : null,
        loadButton: buttons.some((b) => b.includes('载入我的星标')),
        goToken: buttons.some((b) => b.includes('去设置 Token')),
        errorText: err ? err.textContent.trim().slice(0, 160) : null,
        loaded: (panel.textContent ?? '').includes('已载入'),
        rowCount: rows.length,
        firstRow: rows[0] ?? null,
        checkboxCount: panel.querySelectorAll('input[type=checkbox]').length,
      };
    `);

  try {
    await cdp.evaluate(NAV + "await gotoView('add', 800);");
    out.collapsed = await snap();

    // Expand the panel — the collapse header is the only toggle.
    out.expandClick = await cdp.evaluate(`
      const panel = document.querySelector('[data-reg-id="add-stars-panel"]');
      const bar = panel?.querySelector('button[aria-expanded]');
      if (!bar) return 'no toggle';
      bar.click();
      return 'clicked';
    `);
    await sleep(350);
    out.expanded = await snap();

    // Click 载入我的星标 and wait for whichever honest end state arrives.
    out.loadClick = await cdp.evaluate(`
      const panel = document.querySelector('[data-reg-id="add-stars-panel"]');
      const b = [...(panel?.querySelectorAll('button') ?? [])].find((x) =>
        x.textContent.includes('载入我的星标'));
      if (!b) return 'no load button';
      b.click();
      return 'clicked';
    `);
    if (out.loadClick === "clicked") {
      try {
        await cdp.waitFor(
          `(() => {
            const p = document.querySelector('[data-reg-id="add-stars-panel"]');
            if (!p) return false;
            if (p.querySelectorAll('li').length > 0) return true;
            if (p.querySelector('[class*="text-danger"]') !== null) return true;
            return (p.textContent ?? '').includes('已载入');
          })()`,
          { timeoutMs: 30000 },
        );
        out.settled = true;
      } catch {
        out.settled = false;
      }
      out.result = await snap();
    }

    // Collapse again — the body (and therefore the rows/error) must leave the DOM.
    out.collapseClick = await cdp.evaluate(`
      const panel = document.querySelector('[data-reg-id="add-stars-panel"]');
      const bar = panel?.querySelector('button[aria-expanded]');
      if (!bar) return 'no toggle';
      bar.click();
      return 'clicked';
    `);
    await sleep(350);
    out.collapsedAgain = await snap();

    const c = out.collapsed;
    const e = out.expanded;
    const r = out.result;
    const collapsedOk =
      !!c && c.titlePresent && c.hintPresent && c.expanded === "false" && !c.loadButton;
    const expandedOk =
      out.expandClick === "clicked" &&
      !!e &&
      e.expanded === "true" &&
      e.loadButton &&
      e.rowCount === 0 &&
      e.errorText === null;
    const rowsOk =
      !!r && r.rowCount > 0 && r.checkboxCount === r.rowCount && r.errorText === null;
    const emptyOk = !!r && r.loaded && r.rowCount === 0 && r.errorText === null;
    const tokenErrorOk = !!r && !!r.errorText && r.errorText.includes("GitHub Token") && r.goToken;
    const transientErrorOk = !!r && !!r.errorText && !r.errorText.includes("GitHub Token") && !r.goToken;
    const outcome = rowsOk
      ? "rows"
      : emptyOk
        ? "empty"
        : tokenErrorOk
          ? "token-missing"
          : transientErrorOk
            ? "error"
            : "pending";
    const resultOk = out.settled === true && outcome !== "pending";
    const reCollapsedOk =
      out.collapseClick === "clicked" &&
      !!out.collapsedAgain &&
      out.collapsedAgain.expanded === "false" &&
      out.collapsedAgain.rowCount === 0 &&
      out.collapsedAgain.errorText === null;

    passed = collapsedOk && expandedOk && resultOk && reCollapsedOk;
    out.ok = { collapsedOk, expandedOk, resultOk, reCollapsedOk };
    out.outcome = outcome;
  } finally {
    // No state to restore: the panel writes nothing (no localStorage keys, no
    // settings), and collapsing it above puts the DOM back the way we found it.
  }

  out.consoleErrors = cdp.consoleErrors;
  out.verdict = passed ? "PASS" : "FAIL";
  return out;
}
