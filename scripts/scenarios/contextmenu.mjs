/**
 * Context-menu check (item 2).
 *
 * Reported: right-clicking "随意处" showed WebView2's own page menu (返回 / 刷新 /
 * 另存为 / 打印), which belongs to a browser page. `刷新` there reloads the webview
 * and throws away application state.
 *
 * What can be asserted from inside the page: the `contextmenu` event is cancelled
 * on non-editable surfaces and NOT cancelled inside text fields (where the edit
 * menu - 剪切/复制/粘贴 - is genuinely useful). Whether Chromium then decides to
 * draw its native menu is not observable from the page; what is observable is that
 * the default action is prevented, which is the documented way to suppress it.
 */

export default async function (cdp) {
  return cdp.evaluate(`
    const probe = (selector) => {
      const el = selector
        ? document.querySelector(selector)
        : document.querySelector('.repo-grid') ?? document.querySelector('main') ?? document.body;
      if (!el) return { selector, found: false };
      const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
      el.dispatchEvent(ev);
      return { selector, found: true, defaultPrevented: ev.defaultPrevented, tag: el.tagName };
    };

    // Make sure the wall is on screen, so the primary surfaces exist.
    const nav = [...document.querySelectorAll('.skin-nav')].find((b) => b.textContent.includes('项目'));
    if (nav) nav.click();
    await new Promise((r) => setTimeout(r, 300));

    const cases = {
      repositoryWall: probe('.repo-grid'),
      card: probe('.skin-card'),
      sidebar: probe('aside'),
      body: probe('body'),
    };

    // An editable field must keep its menu. 添加 is a lazily-loaded view since
    // round 11 (bundle split), so a fixed sleep after the click is a race: the
    // chunk may not have arrived and querySelector('input') then returns null,
    // which this scenario reports as FAIL — a false accusation against the code.
    // Wait for the field to exist, and only then probe it.
    const addNav = [...document.querySelectorAll('.skin-nav')].find((b) => b.textContent.includes('添加'));
    if (addNav) addNav.click();
    let input = null;
    for (let i = 0; i < 40 && !(input = document.querySelector('input')); i++) {
      await new Promise((r) => setTimeout(r, 200));
    }
    cases.textInput = probe('input');
    cases.textInputFound = !!input;

    const suppressed = ['repositoryWall', 'card', 'sidebar', 'body'].every(
      (k) => cases[k].defaultPrevented === true,
    );

    return {
      cases,
      suppressedOnChrome: suppressed,
      editableKeepsMenu: cases.textInput.defaultPrevented === false,
      verdict: suppressed && cases.textInput.defaultPrevented === false ? 'PASS' : 'FAIL',
    };
  `);
}
