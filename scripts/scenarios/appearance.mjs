/**
 * Round-6 外观 verification: standalone page, the three dead switches now
 * wired, the scrollbar kill switch, Word-style typography, templates, and the
 * settings-page jump entry. Drives the real WebView2 over CDP and asserts on
 * real DOM state — no screenshots.
 */
import { NAV } from "../nav.mjs";

export default async function (cdp) {
  const errors = [];

  const sleep = (ms) => `await new Promise((r) => setTimeout(r, ${ms}));`;

  const clickNav = async (label) =>
    label === "外观"
      ? cdp.evaluate(`${NAV} await gotoAppearance(); return true;`)
      : cdp.evaluate(`
          ${NAV}
          await gotoView(${JSON.stringify({ 项目: "projects", 添加: "add", 记录: "records", 常用: "frequent", 设置: "settings" }[label] ?? label)});
          return true;
        `);

  /** Click the first clickable settings row whose text includes `text`. */
  const clickRow = async (text) =>
    cdp.evaluate(`
      const row = [...document.querySelectorAll('[role="button"]')].find((el) =>
        el.textContent.includes(${JSON.stringify(text)}),
      );
      if (!row) return false;
      row.click();
      ${sleep(250)}
      return true;
    `);

  const clickButtonWithText = async (text) =>
    cdp.evaluate(`
      const btn = [...document.querySelectorAll('button')].find(
        (b) => b.textContent.trim() === ${JSON.stringify(text)},
      );
      if (!btn) return false;
      btn.click();
      ${sleep(250)}
      return true;
    `);

  const bodyHas = (text) =>
    cdp.evaluate(`return document.body.innerText.includes(${JSON.stringify(text)});`);

  // ---- 1. 外观 is a page of the 设置 catalog (round 9 需求 10) ------------
  if (!(await clickNav("外观"))) errors.push("打不开「外观」页");
  const standalone = await cdp.evaluate(`
    return {
      header: [...document.querySelectorAll('h1')].map((h) => h.textContent.trim()).join('|'),
      activeTab: !!document.querySelector('[aria-label="设置目录"] button[aria-current="page"]'),
      hasFontRow: document.body.innerText.includes('字体'),
      hasPxRow: document.body.innerText.includes('精确字号'),
      hasWeightRow: document.body.innerText.includes('界面字重'),
      hasTemplates: document.body.innerText.includes('外观模版'),
      hasSettingsOnlyContent:
        document.body.innerText.includes('主目录') ||
        document.body.innerText.includes('搜索链路'),
    };
  `);
  if (!standalone.activeTab) errors.push('设置目录里「外观」不是当前页');
  if (standalone.hasSettingsOnlyContent) errors.push('外观页出现了设置页专属内容（仍是合并页）');
  if (!standalone.hasFontRow || !standalone.hasPxRow || !standalone.hasWeightRow || !standalone.hasTemplates) {
    errors.push('外观页缺少新增区块（字体/精确字号/字重/模版）');
  }

  // ---- 2. scrollbar kill switch actually kills it ------------------------
  // Put the switch in a known state first. The appearance is persisted, so a run
  // that ends mid-toggle leaves the next one measuring the opposite state — which
  // is how this scenario reported "关态 scrollbar-width 应为 none，实际 thin" while
  // the product was behaving correctly.
  await cdp.evaluate(`
    for (let i = 0; i < 3 && document.documentElement.getAttribute('data-scrollbar') !== 'off'; i++) {
      const row = document.querySelector('[data-reg-id="appearance-row-scrollbar"]');
      if (!row) break;
      row.click();
      await new Promise((r) => setTimeout(r, 300));
    }
    return document.documentElement.getAttribute('data-scrollbar');
  `);

  const scrollOff = await cdp.evaluate(`
    const scroller = document.querySelector('.app-main-pad');
    const cs = getComputedStyle(scroller);
    return {
      attr: document.documentElement.getAttribute('data-scrollbar'),
      width: cs.scrollbarWidth,
      color: cs.scrollbarColor,
      offset: scroller.offsetWidth - scroller.clientWidth,
    };
  `);
  if (scrollOff.attr !== 'off') errors.push(`data-scrollbar 默认应为 off，实际 ${scrollOff.attr}`);
  // What "关" actually means here is `scrollbar-width: none` — the second round of
  // the scrollbar fix chose that over a transparent thumb precisely because a
  // zero-width scrollbar cannot leave the reserved gutter that looked like a blank
  // strip at the window edge. Asserting the *painted colour* of a scrollbar that is
  // not painted tested nothing; the width and the occupied pixels are the claim.
  if (scrollOff.width !== 'none') {
    errors.push(`关态 scrollbar-width 应为 none，实际 ${scrollOff.width}`);
  }
  if (scrollOff.offset !== 0) {
    errors.push(`关态滚动条仍占据 ${scrollOff.offset}px 宽度`);
  }

  if (!(await clickRow('显示滚动条'))) errors.push('找不到「显示滚动条」行');
  const scrollOn = await cdp.evaluate(`
    const scroller = document.querySelector('.app-main-pad');
    return {
      attr: document.documentElement.getAttribute('data-scrollbar'),
      color: getComputedStyle(scroller).scrollbarColor,
      width: getComputedStyle(scroller).scrollbarWidth,
    };
  `);
  if (scrollOn.attr !== 'on') errors.push('打开开关后 data-scrollbar 应为 on');
  // On means the thumb has a colour (the track may stay clear). The previous form
  // (`includes('transparent') && !includes('rgb')`) could never fire, because every
  // rgba() contains "rgb" - it read as a passing check while asserting nothing. So
  // the whole two-colour value is matched, and Chromium's normalisation of
  // `transparent` into `rgba(0, 0, 0, 0)` is accepted as the same colour.
  const CLEAR = "(transparent|rgba\(0, 0, 0, 0\))";
  const thumbIsClear = new RegExp(`^${CLEAR}`);
  if (thumbIsClear.test((scrollOn.color ?? "").trim())) {
    errors.push(`开态滚动条 thumb 仍然透明：${scrollOn.color}`);
  }
  if (scrollOn.width === 'none') {
    errors.push(`开态 scrollbar-width 仍是 none，开关没有把滚动条画回来：${scrollOn.width}`);
  }
  await clickRow('显示滚动条'); // 关回去

  // ---- 3. the three formerly-dead chrome switches -------------------------
  if (!(await clickRow('左上角软件名称'))) errors.push('找不到「左上角软件名称」行');
  const brandGone = await cdp.evaluate(
    `return document.querySelector('[data-reg-id="sidebar-brand"]') === null;`,
  );
  if (!brandGone) errors.push('关闭「软件名称」后 sidebar-brand 仍然存在');
  await clickRow('左上角软件名称');
  const brandBack = await cdp.evaluate(
    `return document.querySelector('[data-reg-id="sidebar-brand"]') !== null;`,
  );
  if (!brandBack) errors.push('重新打开「软件名称」后 sidebar-brand 未恢复');

  if (!(await clickRow('版本号'))) errors.push('找不到「版本号」行');
  const versionGone = await cdp.evaluate(
    `return document.querySelector('[data-reg-id="sidebar-version"]') === null;`,
  );
  if (!versionGone) errors.push('关闭「版本号」后 sidebar-version 仍然存在');
  await clickRow('版本号');

  // ---- 4. precise font size ----------------------------------------------
  const px0 = await cdp.evaluate(`return document.documentElement.style.fontSize;`);
  await cdp.evaluate(`
    const plus = document.querySelector('button[aria-label="字号加 1"]');
    if (plus) { plus.click(); ${sleep(120)} plus.click(); }
  `);
  const px1 = await cdp.evaluate(`return document.documentElement.style.fontSize;`);
  if (px0 === px1) errors.push(`精确字号未生效（${px0} → ${px1}）`);

  // ---- 5. font weight -----------------------------------------------------
  if (!(await clickRow('界面字重'))) errors.push('找不到「界面字重」行');
  const weight = await cdp.evaluate(`return getComputedStyle(document.body).fontWeight;`);
  if (weight !== '500') errors.push(`字重档位未循环到适中（500），实际 ${weight}`);

  // ---- 6. font picker lists and applies a family --------------------------
  if (!(await clickRow('字体'))) errors.push('找不到「字体」行');
  // The panel's search text lives in a `placeholder`, which never shows up in
  // `innerText` - so the old assertion could not pass even with the dropdown open.
  // Look for the control instead.
  const pickerOpen = await cdp.evaluate(`
    const box = document.querySelector('[role="listbox"][aria-label="选择字体"]');
    return {
      open: !!box,
      search: !!box?.querySelector('input[placeholder^="搜索字体"]'),
      options: box ? box.querySelectorAll('button').length : 0,
    };
  `);
  if (!pickerOpen?.open || !pickerOpen?.search) errors.push('字体下拉未打开（面板或搜索框缺失）');
  await cdp.evaluate(`
    const opt = [...document.querySelectorAll('[role="option"]')].find((b) =>
      b.textContent.includes('微软雅黑') || b.textContent.includes('Microsoft YaHei'),
    );
    if (opt) { opt.click(); ${sleep(200)} }
  `);
  const fontApplied = await cdp.evaluate(
    `return (document.documentElement.style.getPropertyValue('--font-sans') || '').includes('Microsoft YaHei');`,
  );
  if (!fontApplied) errors.push('选择字体后 --font-sans 未包含所选字体族');
  await cdp.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));`);

  // ---- 7. template save ----------------------------------------------------
  if (!(await clickButtonWithText('新建模版'))) errors.push('找不到「新建模版」按钮');
  await cdp.evaluate(`
    const input = document.querySelector('input[placeholder^="模版名称"]');
    if (input) {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value',
      ).set;
      setter.call(input, '走查模版');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  `);
  if (!(await clickButtonWithText('保存'))) errors.push('模版保存按钮未找到');
  if (!(await bodyHas('走查模版'))) errors.push('保存后模版未出现在列表中');

  // ---- 8. reset to defaults (writes a revertible record) -------------------
  if (!(await clickButtonWithText('恢复默认'))) errors.push('找不到「恢复默认」按钮');
  const afterReset = await cdp.evaluate(
    `return document.documentElement.style.fontSize;`,
  );
  if (afterReset !== '16px') errors.push(`恢复默认后根字号应为 16px，实际 ${afterReset}`);

  // ---- 9. the catalog pages do not bleed into one another --------------------
  await clickNav('设置');
  // The app was already sitting on the 外观 page, so asking for 设置 is not enough
  // to leave it — the catalog keeps its page until another one is picked.
  await cdp.evaluate(`${NAV} await openSettingsPage('项目与目录'); return true;`);
  const settings = await cdp.evaluate(`
    return {
      // There is no "已独立成页" banner any more: 外观 is a page of this catalog,
      // so what has to exist is the directory entry itself.
      appearancePage: [...document.querySelectorAll('[aria-label="设置目录"] button')]
        .map((b) => b.textContent.trim())
        .includes('外观'),
      roots: document.body.innerText.includes('主目录'),
      duplicatedFontRow: [...document.querySelectorAll('[role="button"]')].filter(
        (el) => el.textContent.includes('界面字重'),
      ).length,
    };
  `);
  if (!settings.appearancePage) errors.push('设置目录里没有「外观」这一页');
  if (!settings.roots) errors.push('「项目与目录」页里找不到主目录分组');
  if (settings.duplicatedFontRow > 0) errors.push('外观控制行出现在非外观页（目录页之间没有隔离）');

  return {
    standalone,
    scrollOff,
    scrollOn,
    settings,
    errors,
    verdict: errors.length === 0 ? 'PASS' : 'FAIL',
  };
}
