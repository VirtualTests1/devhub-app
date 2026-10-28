/**
 * Item 3 + item 1: hide a project without touching the disk, and get it back
 * through 设置 → 项目页.
 *
 * The wall's 已隐藏 button is a deep link into settings, so this walks the whole
 * round trip: hide → jump → restore → back on the wall.
 */

const wallCounts = `
  return {
    tiles: document.querySelectorAll('.skin-card').length,
    counter: ([...document.querySelectorAll('p,span,div')]
      .map((e) => e.textContent.trim())
      .find((t) => /^显示 \\d+ \\/ \\d+$/.test(t))) ?? null,
    hiddenButton: ([...document.querySelectorAll('button')]
      .map((b) => b.textContent.trim())
      .find((t) => /^已隐藏 \\d+$/.test(t))) ?? null,
    zfixture: [...document.querySelectorAll('.skin-card')].some((b) =>
      (b.getAttribute('title') ?? '').includes('testowner/zfixture')),
  };
`;

export default async function (cdp) {
  const out = {};

  await cdp.send("Page.reload", { ignoreCache: true });
  await cdp.waitFor("document.querySelector('[data-skin]') !== null", { timeoutMs: 30000 });
  await cdp.evaluate(`
    [...document.querySelectorAll('.skin-nav')].find((b) => b.textContent.includes('项目'))?.click();
    await new Promise((s) => setTimeout(s, 1200));
  `);

  out.before = await cdp.evaluate(wallCounts);

  out.menu = await cdp.evaluate(`
    const tile = [...document.querySelectorAll('.skin-card')].find((b) =>
      (b.getAttribute('title') ?? '').includes('testowner/zfixture'));
    const r = tile.getBoundingClientRect();
    tile.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: Math.round(r.left + 20), clientY: Math.round(r.top + 20),
    }));
    await new Promise((s) => setTimeout(s, 400));
    const item = [...document.querySelectorAll('[role=menuitem]')].find((i) =>
      i.textContent.includes('从项目墙隐藏'));
    if (!item) return null;
    item.click();
    await new Promise((s) => setTimeout(s, 900));
    return [...document.querySelectorAll('[role=menuitem]')].length === 0;
  `);

  out.afterHide = await cdp.evaluate(wallCounts);
  out.storedHidden = await cdp.evaluate(`
    const p = JSON.parse(localStorage.getItem('devhub.wall.v1') || '{}');
    return p.repos?.['github.com/testowner/zfixture'] ?? null;
  `);
  out.diskStillThere = await cdp.evaluate(
    `return document.body.innerText.includes('显示') ;`,
  );

  // The wall's own entry point into settings.
  await cdp.evaluate(`
    const b = [...document.querySelectorAll('button')].find((x) => /^已隐藏 \\d+$/.test(x.textContent.trim()));
    b?.click();
    await new Promise((s) => setTimeout(s, 1200));
  `);

  out.settingsSection = await cdp.evaluate(`
    const sec = document.querySelector('[data-section="projects"]') ??
      [...document.querySelectorAll('section,div')].find((d) =>
        d.querySelector('h2,h3') && /项目页|卡片密度|默认筛选/.test(d.textContent));
    return sec ? {
      found: true,
      text: sec.textContent.replace(/\\s+/g, ' ').trim().slice(0, 420),
      controls: [...sec.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean).slice(0, 16),
    } : { found: false, body: document.body.innerText.slice(0, 200) };
  `);

  out.restored = await cdp.evaluate(`
    const btn = [...document.querySelectorAll('button')].find((b) =>
      /全部恢复|恢复显示|恢复全部/.test(b.textContent));
    if (!btn) return null;
    btn.click();
    await new Promise((s) => setTimeout(s, 600));
    return btn.textContent.trim();
  `);

  await cdp.evaluate(`
    [...document.querySelectorAll('.skin-nav')].find((b) => b.textContent.includes('项目'))?.click();
    await new Promise((s) => setTimeout(s, 900));
  `);
  out.afterRestore = await cdp.evaluate(wallCounts);

  out.consoleErrors = cdp.consoleErrors;
  return out;
}
