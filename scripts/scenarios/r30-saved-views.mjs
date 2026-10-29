/**
 * r30-N1 real-window evidence: save the current wall filter as a named view.
 *
 * The unit tests pin validation, rotation and the palette hand-off; this scenario
 * checks the part only a real WebView can show: the toolbar control exists, the
 * dialog opens with a focused name box, saving writes the view into the live
 * store, and the view menu then offers it.
 */
const SET_INPUT = (selector, value) => `
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
`;

export default async function (cdp) {
  const out = {};

  // Start from a clean page: a previous aborted run may have left the naming
  // dialog open, and a reload also re-reads the fixture wall.
  await cdp.reload(1800);

  await cdp.evaluate(`
    await new Promise((r) => setTimeout(r, 1500));
    const nav = [...document.querySelectorAll('button, a')].find((b) => (b.textContent || '').includes('项目'));
    if (nav) nav.click();
    await new Promise((r) => setTimeout(r, 600));
    return true;
  `);

  out.before = await cdp.evaluate(`
    const { useWallViews } = await import('/src/store/wall-views.ts');
    const toolbar = document.querySelector('[data-reg-id="projects-toolbar"]');
    const save = document.querySelector('[aria-label="保存当前筛选为视图"]');
    return {
      toolbar: !!toolbar,
      saveButton: !!save,
      disabled: save ? save.disabled : null,
      viewCount: useWallViews.getState().views.length,
    };
  `);

  out.typed = await cdp.evaluate(SET_INPUT('[data-reg-id="projects-toolbar"] input', 'r30e2e'));
  await cdp.evaluate(`await new Promise((r) => setTimeout(r, 350)); return true;`);

  out.enabled = await cdp.evaluate(`
    const save = document.querySelector('[aria-label="保存当前筛选为视图"]');
    return { disabled: save ? save.disabled : null };
  `);

  out.opened = await cdp.evaluate(`
    const save = document.querySelector('[aria-label="保存当前筛选为视图"]');
    if (!save || save.disabled) return false;
    save.click();
    await new Promise((r) => setTimeout(r, 1800));
    const dialog = document.querySelector('[data-reg-id="wall-view-dialog"]');
    const input = dialog?.querySelector('input');
    return { dialog: !!dialog, input: !!input, focused: document.activeElement === input };
  `);

  out.saved = await cdp.evaluate(`
    const dialog = document.querySelector('[data-reg-id="wall-view-dialog"]');
    const input = dialog?.querySelector('input');
    if (!input) return { ok: false, reason: 'no dialog input' };
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'R30 E2E');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 120));
    const button = [...dialog.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '保存');
    if (!button) return { ok: false, reason: 'no save button' };
    button.click();
    await new Promise((r) => setTimeout(r, 300));
    const { useWallViews } = await import('/src/store/wall-views.ts');
    const views = useWallViews.getState().views;
    const view = views.find((v) => v.name === 'R30 E2E');
    const select = document.querySelector('[aria-label="项目墙视图"]');
    return {
      ok: !!view,
      query: view?.query ?? null,
      active: useWallViews.getState().activeId === view?.id,
      optionCount: select ? (select.closest('[data-reg-id="projects-toolbar"]')?.querySelectorAll('[role="option"]').length ?? 0) : 0,
      viewCount: views.length,
    };
  `);

  // Remove the probe view through the same store so a repeated run starts clean.
  out.cleaned = await cdp.evaluate(`
    const { useWallViews } = await import('/src/store/wall-views.ts');
    const v = useWallViews.getState().views.find((x) => x.name === 'R30 E2E');
    if (v) useWallViews.getState().remove(v.id);
    return { remaining: useWallViews.getState().views.filter((x) => x.name === 'R30 E2E').length };
  `);

  out.verdict =
    out.before.toolbar &&
    out.before.saveButton &&
    out.before.disabled === true &&
    out.typed &&
    out.enabled.disabled === false &&
    out.opened &&
    out.opened.dialog &&
    out.opened.focused &&
    out.saved.ok &&
    out.saved.query === 'r30e2e' &&
    out.saved.active &&
    out.cleaned.remaining === 0
      ? 'PASS'
      : 'FAIL';
  return out;
}
