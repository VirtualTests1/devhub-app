/**
 * r35 real-window checks: language/html lang, sidebar keyboard reorder, IME
 * guard in the command palette, and the StatusCard Enter/Space path.
 *
 * This scenario mutates two persisted preferences (locale and nav order) and
 * restores both before returning, so it is safe to run in the shared chain.
 */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function clickText(cdp, text) {
  return await cdp.evaluate(`
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)});
    if (!btn) return false;
    btn.click();
    return true;
  `);
}

export default async function (cdp) {
  const ready = await cdp.evaluate(`
    return await new Promise((resolve) => {
      const t = setInterval(() => {
        if (document.querySelector('[data-reg-id="nav-item-settings"]')) { clearInterval(t); resolve(true); }
      }, 100);
      setTimeout(() => { clearInterval(t); resolve(false); }, 15000);
    });
  `);
  if (!ready) return { verdict: "FAIL", reason: "settings nav entry never appeared" };

  const version = await cdp.evaluate(`return await window.__TAURI_INTERNALS__.invoke('app_version')`);

  // Normalize to Chinese first; the chain may run after an English scenario.
  const initialLang = await cdp.evaluate(`return document.documentElement.lang`);
  if (initialLang !== "zh-CN") {
    await cdp.evaluate(`document.querySelector('[data-reg-id="nav-item-settings"]')?.click(); return true;`);
    await wait(600);
    await clickText(cdp, "Interface");
    await wait(200);
    await clickText(cdp, "简体中文");
    await wait(500);
  }

  // Chinese -> English -> Chinese, with html lang checked at each step.
  await cdp.evaluate(`document.querySelector('[data-reg-id="nav-item-settings"]')?.click(); return true;`);
  await wait(700);
  const interfaceOpened = await clickText(cdp, "界面");
  await wait(300);
  const switched = await clickText(cdp, "English");
  await wait(600);
  const english = await cdp.evaluate(`return {
    lang: document.documentElement.lang,
    interfaceLanguage: document.body.innerText.includes('Interface language'),
  };`);
  const restored = await clickText(cdp, "简体中文");
  await wait(600);
  const chinese = await cdp.evaluate(`return {
    lang: document.documentElement.lang,
    settingsTitle: document.body.innerText.includes('设置'),
  };`);

  // Sidebar keyboard reorder: second item up, then back down.
  const before = await cdp.evaluate(`
    return [...document.querySelectorAll('aside button[aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"]')]
      .map((b) => b.getAttribute('data-reg-id'));
  `);
  const moved = await cdp.evaluate(`
    const btns = [...document.querySelectorAll('aside button[aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"]')];
    if (btns.length < 2) return null;
    btns[1].focus();
    btns[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true, cancelable: true }));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return [...document.querySelectorAll('aside button[aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"]')]
      .map((b) => b.getAttribute('data-reg-id'));
  `);
  const movedId = Array.isArray(moved) ? moved[0] : null;
  const restoredOrder = await cdp.evaluate(`
    const target = [...document.querySelectorAll('aside button[aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"]')]
      .find((b) => b.getAttribute('data-reg-id') === ${JSON.stringify(movedId)});
    if (!target) return null;
    target.focus();
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true }));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return [...document.querySelectorAll('aside button[aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"]')]
      .map((b) => b.getAttribute('data-reg-id'));
  `);

  // Command palette: Escape during an IME composition must not close it.
  await cdp.evaluate(`
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
    return true;
  `);
  await wait(400);
  const paletteOpen = await cdp.evaluate(`return !!document.querySelector('[data-layer="dialog"]')`);
  const imeEscape = await cdp.evaluate(`
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 150));
    return !!document.querySelector('[data-layer="dialog"]');
  `);
  const normalEscape = await cdp.evaluate(`
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 500));
    return !!document.querySelector('[data-layer="dialog"]');
  `);

  // StatusCard: the git card must be a real keyboard button; Enter jumps to
  // the editors section and closes the popover.
  await cdp.evaluate(`document.querySelector('[data-reg-id="status-seg-link"]')?.click(); return true;`);
  await wait(400);
  const card = await cdp.evaluate(`
    const el = document.querySelector('[data-reg-id="status-card-git"]');
    if (!el) return null;
    return {
      role: el.getAttribute('role'),
      tabIndex: el.getAttribute('tabindex'),
      keys: el.getAttribute('aria-keyshortcuts'),
    };
  `);
  const statusJump = await cdp.evaluate(`
    const el = document.querySelector('[data-reg-id="status-card-git"]');
    if (!el) return false;
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 600));
    return document.body.innerText.includes('编辑器') || document.body.innerText.includes('Editors');
  `);

  const checks = {
    ipcVersion: typeof version === "string" && version.length > 0,
    interfaceSection: interfaceOpened,
    englishSwitched: switched && english.lang === "en" && english.interfaceLanguage,
    chineseRestored: restored && chinese.lang === "zh-CN" && chinese.settingsTitle,
    reorderMoved: Array.isArray(moved) && moved[0] === before?.[1] && moved[1] === before?.[0],
    reorderRestored: Array.isArray(restoredOrder) && JSON.stringify(restoredOrder) === JSON.stringify(before),
    paletteOpened: paletteOpen,
    imeEscapeKeptPalette: imeEscape === true,
    normalEscapeClosed: normalEscape === false,
    statusCardKeyboard: card?.role === "button" && card?.tabIndex === "0" && card?.keys === "Enter Space" && statusJump,
  };
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  return {
    verdict: failed.length === 0 ? "PASS" : "FAIL",
    failed,
    version,
    english,
    chinese,
    before,
    moved,
    restoredOrder,
    paletteOpen,
    imeEscape,
    normalEscape,
    card,
    statusJump,
  };
}
