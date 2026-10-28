/**
 * In-page navigation, shared by the scenarios.
 *
 * Round 9 moved 设置 out of the sidebar rail into the rail's footer and turned
 * 外观 into a page inside the 设置 catalog. Scenarios that clicked a rail item by
 * its visible text stopped finding either one, and — worse — failed *silently*:
 * `nav?.click()` on nothing leaves the page where it was and the assertions then
 * measure the wrong surface. A stale navigation is not a skipped test, it is a
 * test that lies.
 *
 * The element registry ids (`data-reg-id`) are the stable handles: every block in
 * the app already carries one so that 界面区块 can name what it toggles, and they
 * do not change when the markup around them does.
 *
 * Usage: `cdp.evaluate(NAV + \`...code using gotoView/gotoSettings/openPage...\`)`
 */
export const NAV = `
  const __sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const __click = async (el, ms) => {
    if (!el) throw new Error('navigation target not found');
    el.click();
    await __sleep(ms ?? 500);
  };
  const gotoView = async (id, ms) =>
    __click(document.querySelector('[data-reg-id="nav-item-' + id + '"]'), ms);
  const gotoSettings = async (ms) => gotoView('settings', ms);
  /**
   * Open a page of the 设置 catalog by its visible label (外观, 界面, 网络 …).
   *
   * The catalog renders *after* the view switch, so a fixed settle before looking
   * for the button is a bet against the machine — on a loaded box that bet lost
   * twice (appearance, wall-reset: 'navigation target not found' at 400-600ms).
   * Poll for the button up to 3s instead, then click and settle for 'ms' as
   * before; if it never appears, still throw — a missing page must stay a
   * failure, not a silently wrong surface.
   */
  const openSettingsPage = async (label, ms) => {
    let el = null;
    for (let i = 0; i < 20 && !el; i++) {
      el = [...document.querySelectorAll('[aria-label="设置目录"] button')].find(
        (b) => b.textContent.trim() === label,
      );
      if (!el) await __sleep(150);
    }
    await __click(el, ms);
  };
  /** The 外观 page, from anywhere — it is no longer a view of its own. */
  const gotoAppearance = async () => {
    await gotoSettings(400);
    await openSettingsPage('外观', 400);
  };
`;
