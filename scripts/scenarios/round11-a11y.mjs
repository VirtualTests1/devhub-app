/**
 * Round 11 — the accessibility layer, measured in the real WebView2.
 *
 * `pnpm build` proves the markup compiles; it does not prove a keyboard user can
 * operate a modal. This scenario asks the live DOM the five questions this round
 * changed the answers to:
 *
 *   1. the shared dialog frame carries dialog semantics and its label resolves;
 *   2. opening it puts focus inside the panel, and Tab cannot walk out;
 *   3. Escape closes it;
 *   4. the right-click menu is a menu with a resolvable active descendant;
 *   5. a toast has a real, focusable close button.
 *
 * Check 5 is reported as `skipped` when no toast happens to be on screen — the
 * scenario will not fail the run for an element it could not summon, and it will
 * not pretend to have seen it either. Everything else must hold.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default async function (cdp) {
  const out = { checks: {} };

  await cdp.waitFor("document.querySelector('[data-skin]') !== null", { timeoutMs: 30000 });
  await cdp.evaluate(`
    [...document.querySelectorAll('.skin-nav')].find((b) => b.textContent.includes('项目'))?.click();
    await new Promise((s) => setTimeout(s, 1200));
  `);

  out.checks.tileCount = await cdp.evaluate(
    `return document.querySelectorAll('.skin-card').length;`,
  );

  // --- 1 + 2 + 3: the launch dialog ------------------------------------------
  await cdp.evaluate(`
    [...document.querySelectorAll('.skin-card')][0]?.click();
    await new Promise((s) => setTimeout(s, 1200));
  `);

  const dialog = await cdp.evaluate(`
    const panel = document.querySelector('[data-layer="dialog"]');
    if (!panel) return { present: false };
    const labelId = panel.getAttribute('aria-labelledby') || '';
    const titleEl = labelId ? document.getElementById(labelId) : null;
    return {
      present: true,
      role: panel.getAttribute('role'),
      modal: panel.getAttribute('aria-modal'),
      labelId,
      labelResolves: !!titleEl,
      labelText: titleEl ? titleEl.textContent.trim().slice(0, 40) : null,
      focusInside: panel.contains(document.activeElement),
      focusTag: document.activeElement ? document.activeElement.tagName : null,
    };
  `);
  out.checks.dialog = dialog;

  // Twenty synthetic Tabs. The frame's own handler is what moves focus across the
  // boundary, so a stop that lands outside the panel is an escape, not a no-op.
  const trap = await cdp.evaluate(`
    const panel = document.querySelector('[data-layer="dialog"]');
    if (!panel) return { ok: false, reason: 'no dialog to trap', escapes: [], focusables: 0 };
    const escapes = [];
    const seen = [];
    for (let i = 0; i < 20; i++) {
      panel.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Tab', bubbles: true, cancelable: true,
      }));
      const a = document.activeElement;
      seen.push(a ? a.tagName : null);
      if (!panel.contains(a)) {
        escapes.push(a ? (a.tagName + '.' + (a.className || '')).slice(0, 60) : 'null');
        break;
      }
    }
    return {
      ok: escapes.length === 0,
      escapes,
      focusables: panel.querySelectorAll(${JSON.stringify(FOCUSABLE)}).length,
      distinctStops: new Set(seen.filter(Boolean)).size,
    };
  `);
  out.checks.tabTrap = trap;

  const esc = await cdp.evaluate(`
    const panel = document.querySelector('[data-layer="dialog"]');
    (panel || document.body).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await new Promise((s) => setTimeout(s, 900));
    return {
      stillOpen: !!document.querySelector('[data-layer="dialog"]'),
      scrimState: (document.querySelector('[data-layer="scrim"]')
        || { getAttribute: () => null }).getAttribute('data-state'),
    };
  `);
  out.checks.escapeCloses = esc;

  // --- 4: the right-click menu ------------------------------------------------
  await cdp.evaluate(`
    const tile = [...document.querySelectorAll('.skin-card')][0];
    if (!tile) return;
    const r = tile.getBoundingClientRect();
    tile.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: r.x + 8, clientY: r.y + 8,
    }));
    await new Promise((s) => setTimeout(s, 500));
  `);

  const menu = await cdp.evaluate(`
    const m = document.querySelector('[role="menu"]');
    if (!m) return { present: false };
    const items = [...m.querySelectorAll('[role="menuitem"]')];
    const activeId = m.getAttribute('aria-activedescendant');
    const active = activeId ? document.getElementById(activeId) : null;
    return {
      present: true,
      items: items.length,
      everyItemHasId: items.length > 0 && items.every((el) => !!el.id),
      activeDescendant: activeId,
      activeResolves: !!active,
      activeIsMenuItem: !!active && active.matches('[role="menuitem"]'),
    };
  `);
  out.checks.menu = menu;

  await cdp.evaluate(`
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((s) => setTimeout(s, 400));
  `);

  // --- 5: toast dismiss --------------------------------------------------------
  // No toast is summoned on purpose: the app's only dev-mode page handle is
  // `__devhubUI` (src/main.tsx:138) and the toast queue has none. So this reads
  // whatever is on screen and reports `skipped` when there is nothing to read.
  const toast = await cdp.evaluate(`
    const btns = [...document.querySelectorAll('button')].filter((b) =>
      (b.getAttribute('aria-label') || '').includes('关闭通知'));
    return {
      onScreen: btns.length,
      dismissTag: btns[0] ? btns[0].tagName : null,
      dismissFocusable: btns[0]
        ? btns[0].matches(${JSON.stringify(FOCUSABLE)})
        : null,
    };
  `);
  out.checks.toast = toast.onScreen > 0 ? toast : { skipped: true, reason: '没有可见通知' };

  out.consoleErrors = cdp.consoleErrors || [];

  const failures = [];
  if (!(dialog.present && dialog.role === "dialog" && dialog.modal === "true")) {
    failures.push("dialog 语义缺失");
  }
  if (dialog.present && !dialog.labelResolves) failures.push("aria-labelledby 指向不存在的元素");
  if (dialog.present && !dialog.focusInside) failures.push("初始焦点不在面板内");
  if (trap.ok !== true) failures.push("Tab 走出了模态面板");
  if (esc.stillOpen !== false) failures.push("Escape 没有关掉对话框");
  if (!(menu.present && menu.items > 0 && menu.everyItemHasId && menu.activeResolves)) {
    failures.push("右键菜单缺少 menu 语义或 activedescendant");
  }
  if (toast.onScreen > 0 && !(toast.dismissTag === "BUTTON" && toast.dismissFocusable)) {
    failures.push("通知的关闭入口不是可聚焦按钮");
  }
  if (out.consoleErrors.length > 0) failures.push("控制台报错");

  out.failed = failures;
  out.verdict = failures.length === 0 ? "PASS" : "FAIL";

  await sleep(200);
  return out;
}
