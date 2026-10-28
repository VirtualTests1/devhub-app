/**
 * Round 16, N3-2: the tag editor (right-click → 标签…) and the filter chips row
 * it creates on the project wall.
 *
 * Tags live in localStorage (`devhub.wall.v1`) only, so nothing here can leak
 * into the repo — but it CAN leak into the next scenario's wall, so the tag is
 * added, filtered on, cleared, and removed again before this returns. The filter
 * assertions read which cards are actually visible (offsetParent), never which
 * are in the DOM: a card kept in the tree but hidden is still filtered out for
 * the user, and a card removed from the tree is too — visibility is the contract
 * either way.
 */
import { NAV } from "../nav.mjs";

const TAG = "r16x17";
const SLUG = "github.com/testowner/zfixture";

const visibleCardsJs = `
  const wall = JSON.parse(localStorage.getItem('devhub.wall.v1') || '{}');
  const cards = [...document.querySelectorAll('.skin-card')];
  const info = cards.filter((c) => c.offsetParent !== null).map((c) => {
    const title = c.getAttribute('title') ?? '';
    const entry = Object.entries(wall.repos ?? {}).find(([slug]) => title.includes(slug));
    return { title: title.split('\\n')[0], slug: entry?.[0] ?? null, tags: entry?.[1]?.tags ?? [] };
  });
  return info;
`;

export default async function (cdp) {
  const out = {};

  await cdp.evaluate(NAV + "await gotoView('projects', 900);");
  out.visibleBefore = await cdp.evaluate(visibleCardsJs);

  const openEditor = () => cdp.evaluate(`
    const tile = [...document.querySelectorAll('.skin-card')].find((b) =>
      (b.getAttribute('title') ?? '').includes('testowner/zfixture'));
    if (!tile) return 'no tile';
    const r = tile.getBoundingClientRect();
    tile.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true,
      clientX: Math.round(r.left + 20), clientY: Math.round(r.top + 20),
    }));
    await new Promise((s) => setTimeout(s, 400));
    const item = [...document.querySelectorAll('[role=menuitem]')].find((i) =>
      i.textContent.trim().startsWith('标签'));
    if (!item) return 'no menu item';
    item.click();
    await new Promise((s) => setTimeout(s, 700));
    return document.querySelector('[data-reg-id="repo-tags-dialog"]') ? 'dialog' : 'no dialog';
  `);

  const closeDialog = () => cdp.evaluate(`
    const dlg = document.querySelector('[data-reg-id="repo-tags-dialog"]');
    const close = dlg?.querySelector('button[aria-label="关闭"]')
      ?? [...(dlg?.querySelectorAll('button') ?? [])].find((b) => b.querySelector('svg') && b.textContent.trim() === '');
    close?.click();
    await new Promise((s) => setTimeout(s, 500));
    return !document.querySelector('[data-reg-id="repo-tags-dialog"]');
  `);

  out.opened = await openEditor();
  if (out.opened !== "dialog") {
    out.consoleErrors = cdp.consoleErrors;
    return { ...out, verdict: "FAIL" };
  }

  // A tag left by an interrupted earlier run is removed first, so "added" below
  // measures this run's click and not a previous one's residue.
  out.leftoverRemoved = await cdp.evaluate(`
    const dlg = document.querySelector('[data-reg-id="repo-tags-dialog"]');
    const rm = dlg.querySelector('button[aria-label="移除标签 ${TAG}"]');
    if (rm) { rm.click(); await new Promise((s) => setTimeout(s, 500)); }
    return !!rm;
  `);

  out.added = await cdp.evaluate(`
    const dlg = document.querySelector('[data-reg-id="repo-tags-dialog"]');
    const input = dlg.querySelector('input[aria-label="新标签名称"]');
    if (!input) return 'no input';
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    input.focus();
    setter.call(input, ${JSON.stringify(TAG)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((s) => setTimeout(s, 300));
    const add = [...dlg.querySelectorAll('button')].find((b) => b.textContent.trim() === '添加');
    if (!add) return 'no 添加';
    if (add.disabled) return '添加 disabled';
    add.click();
    await new Promise((s) => setTimeout(s, 600));
    return 'added';
  `);

  out.inDialog = await cdp.evaluate(`
    const dlg = document.querySelector('[data-reg-id="repo-tags-dialog"]');
    return {
      removeShown: !!dlg.querySelector('button[aria-label="移除标签 ${TAG}"]'),
      counter: [...dlg.querySelectorAll('p')].map((p) => p.textContent.replace(/\\s+/g, ' '))
        .find((t) => /\\/\\s*8/.test(t)) ?? null,
      subtitle: (dlg.textContent ?? '').replace(/\\s+/g, ' ').includes('testowner/zfixture'),
    };
  `);
  out.closedAfterAdd = await closeDialog();

  out.chips = await cdp.evaluate(`
    const bar = document.querySelector('[data-reg-id="projects-tag-chips"]');
    if (!bar) return null;
    const chip = [...bar.querySelectorAll('button[aria-pressed]')].find((b) => b.textContent.includes('${TAG}'));
    return {
      groupLabel: bar.getAttribute('aria-label'),
      chip: chip ? { text: chip.textContent.trim(), pressed: chip.getAttribute('aria-pressed') === 'true' } : null,
      clear: !!bar.querySelector('button[aria-label="清除标签筛选"]'),
    };
  `);

  out.filtered = await cdp.evaluate(`
    const bar = document.querySelector('[data-reg-id="projects-tag-chips"]');
    const chip = bar ? [...bar.querySelectorAll('button[aria-pressed]')].find((b) => b.textContent.includes('${TAG}')) : null;
    if (!chip) return 'no chip';
    chip.click();
    await new Promise((s) => setTimeout(s, 500));
    return 'clicked';
  `);
  out.filteredVisible = await cdp.evaluate(visibleCardsJs);
  out.filteredState = await cdp.evaluate(`
    const bar = document.querySelector('[data-reg-id="projects-tag-chips"]');
    const chip = [...bar.querySelectorAll('button[aria-pressed]')].find((b) => b.textContent.includes('${TAG}'));
    return {
      pressed: chip?.getAttribute('aria-pressed') === 'true',
      clear: !!bar.querySelector('button[aria-label="清除标签筛选"]'),
    };
  `);

  out.cleared = await cdp.evaluate(`
    const bar = document.querySelector('[data-reg-id="projects-tag-chips"]');
    const clear = bar?.querySelector('button[aria-label="清除标签筛选"]');
    if (!clear) return 'no clear button';
    clear.click();
    await new Promise((s) => setTimeout(s, 500));
    return 'cleared';
  `);
  out.clearedVisible = await cdp.evaluate(visibleCardsJs);
  out.clearedState = await cdp.evaluate(`
    const bar = document.querySelector('[data-reg-id="projects-tag-chips"]');
    if (!bar) return { barGone: true };
    const chip = [...bar.querySelectorAll('button[aria-pressed]')].find((b) => b.textContent.includes('${TAG}'));
    return {
      barGone: false,
      chipPressed: chip?.getAttribute('aria-pressed') ?? null,
      clear: !!bar.querySelector('button[aria-label="清除标签筛选"]'),
    };
  `);

  // ---- remove the tag again --------------------------------------------------
  out.reopened = await openEditor();
  out.removed = await cdp.evaluate(`
    const dlg = document.querySelector('[data-reg-id="repo-tags-dialog"]');
    const rm = dlg?.querySelector('button[aria-label="移除标签 ${TAG}"]');
    if (!rm) return 'tag already gone';
    rm.click();
    await new Promise((s) => setTimeout(s, 500));
    return 'removed';
  `);
  out.closedAfterRemove = await closeDialog();
  out.final = await cdp.evaluate(`
    const bar = document.querySelector('[data-reg-id="projects-tag-chips"]');
    const chip = bar ? [...bar.querySelectorAll('button[aria-pressed]')].find((b) => b.textContent.includes('${TAG}')) : null;
    const wall = JSON.parse(localStorage.getItem('devhub.wall.v1') || '{}');
    return {
      chipGone: !chip,
      wallTags: wall.repos?.[${JSON.stringify(SLUG)}]?.tags ?? null,
      clearGone: bar ? !bar.querySelector('button[aria-label="清除标签筛选"]') : true,
    };
  `);

  out.consoleErrors = cdp.consoleErrors;
  const addOk =
    out.added === "added" &&
    out.inDialog?.removeShown === true &&
    out.inDialog?.subtitle === true &&
    out.closedAfterAdd === true;
  const chipsOk =
    out.chips !== null &&
    out.chips?.chip !== null &&
    out.chips?.chip?.pressed === false &&
    out.chips?.groupLabel === "按标签筛选项目";
  const filterOk =
    out.filtered === "clicked" &&
    out.filteredState?.pressed === true &&
    out.filteredState?.clear === true &&
    out.filteredVisible?.length >= 1 &&
    out.filteredVisible?.every((c) => c.tags.includes(TAG)) &&
    out.filteredVisible?.some((c) => (c.slug ?? "").includes("testowner/zfixture"));
  const clearOk =
    out.cleared === "cleared" &&
    out.clearedState?.clear === false &&
    out.clearedVisible?.length >= (out.visibleBefore?.length ?? 0);
  const removeOk =
    out.reopened === "dialog" &&
    out.removed === "removed" &&
    out.closedAfterRemove === true &&
    out.final?.chipGone === true &&
    out.final?.clearGone === true &&
    !(out.final?.wallTags ?? []).includes(TAG);
  out.ok = { addOk, chipsOk, filterOk, clearOk, removeOk };
  out.verdict = addOk && chipsOk && filterOk && clearOk && removeOk ? "PASS" : "FAIL";
  return out;
}
