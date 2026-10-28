/**
 * Round 10 checkpoint — colour layer and motion layer, measured in the running
 * window rather than read out of the stylesheet.
 *
 * Every probe is isolated: a navigation, a toast auto-dismiss or a vite reload
 * that lands mid-probe must surface as a recorded error on that one line, not as
 * a dead run. Checks report the numbers they compared, because a probe that
 * cannot fail is worse than no probe.
 *
 *   node scripts/cdp.mjs scripts/scenarios/motion-colour-check.mjs --port 9223
 */

import { NAV } from "../nav.mjs";

const sleep = (ms) => `await new Promise((r) => setTimeout(r, ${ms}));`;

/** Colour → sRGB through a 1px canvas. `getComputedStyle` hands an authored
 *  `oklch()` back unchanged, so a regex on `rgb(` finds nothing and the probe
 *  would silently report null instead of a measured ratio. */
const COLOUR = `
  const parse = (css) => {
    if (!css || css === 'transparent') return null;
    const c = document.createElement('canvas');
    c.width = 1; c.height = 1;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.clearRect(0, 0, 1, 1);
    g.fillStyle = css;
    g.fillRect(0, 0, 1, 1);
    const d = g.getImageData(0, 0, 1, 1).data;
    return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
  };
  const lum = (v) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const over = (fg, bg) => (!fg || !bg ? null : fg.a >= 0.999 ? fg : {
    r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  const Y = (c) => 0.2126 * lum(c.r) + 0.7152 * lum(c.g) + 0.0722 * lum(c.b);
  const contrast = (a, b) => { if (!a || !b) return null; const x = Y(a) + 0.05, y = Y(b) + 0.05; return +(x > y ? x / y : y / x).toFixed(2); };
  const pair = (bgExpr, fgExpr) => {
    const t = document.createElement('div');
    t.style.cssText = 'position:fixed;left:-9999px;top:-9999px;background:' + bgExpr + ';color:' + fgExpr;
    document.body.appendChild(t);
    const cs = getComputedStyle(t);
    const bg = parse(cs.backgroundColor);
    const fg = parse(cs.color);
    t.remove();
    return contrast(over(fg, bg), bg);
  };
  const resolvedMs = (tok) => {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;left:-9999px;transition-duration:var(' + tok + ')';
    document.body.appendChild(d);
    const v = getComputedStyle(d).transitionDuration;
    d.remove();
    return v;
  };
`;

/** Navigation must address the nav itself. Text-matching every `button` on the
 *  page once made a scenario click a filter chip while meaning the status strip,
 *  and the persisted filter then emptied the wall for every later probe. */
/**
 * Round 9 moved 设置 into the rail's footer and 外观 into a page of the 设置
 * catalog, so clicking a rail item by visible text no longer reaches either.
 * `data-reg-id` is the handle the app itself uses to name a block.
 */
const VIEW_ID = { 项目: "projects", 添加: "add", 记录: "records", 常用: "frequent", 设置: "settings" };

const go = (label) => {
  if (label === "外观") {
    return `${NAV}
  await gotoAppearance();
  ${sleep(400)}
  return document.documentElement.dataset.theme;`;
  }
  return `${NAV}
  const n = document.querySelector('[data-reg-id="nav-item-${VIEW_ID[label]}"]');
  if (!n) return 'no ${label} nav item';
  n.click();
  ${sleep(700)}
  return document.documentElement.dataset.theme;`;
};

const clickTheme = (want) => `
  const t = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(want)});
  if (!t) return 'no ${want} control on this page';
  t.click();
  ${sleep(600)}
  return document.documentElement.dataset.theme;
`;

const setMotionFlag = (want) => `
  let flag = document.documentElement.dataset.motion;
  for (let i = 0; i < 3 && flag !== ${JSON.stringify(want)}; i++) {
    const row = document.querySelector('[data-reg-id="appearance-row-reduce-motion"]');
    if (!row) return 'no reduce-motion row (not on 外观?)';
    row.click();
    await new Promise((r) => setTimeout(r, 350));
    flag = document.documentElement.dataset.motion;
  }
  return flag;
`;

const ok = (label, pass, detail) => ({ label, pass, detail });

export default async function (cdp) {
  const checks = [];
  // The runner drives this file with `--reload`, so the first probe can land while
  // the webview is still replacing its document — which surfaces as
  // "Execution context was destroyed" rather than as a real failure. Wait for the
  // wall to exist before measuring anything.
  const ev = async (js, tag) => {
    try {
      return await cdp.evaluate(js);
    } catch (e) {
      const m = e && e.message ? String(e.message) : String(e);
      return { __error: tag + ": " + m.slice(0, 90) };
    }
  };

  // The runner drives this file with `--reload`, so the first probe can land while
  // the webview is still replacing its document — that surfaces as
  // "Execution context was destroyed" rather than as a real failure.
  const warm = async () => {
    for (let i = 0; i < 20; i++) {
      const r = await ev(
        `return { cards: document.querySelectorAll('.repo-grid > *').length, scale: document.documentElement.dataset.scale };`,
        "warm",
      );
      if (r && r.cards > 0) return r;
      await new Promise((r) => setTimeout(r, 500));
    }
    return { cards: 0 };
  };

  const measure = () =>
    ev(`
      ${COLOUR}
      const cs = getComputedStyle(document.documentElement);
      const p = (n) => cs.getPropertyValue(n).trim();
      const card = document.querySelector('.repo-grid > *');
      const painted = { cardText: null, cardBg: null };
      if (card) {
        const ccs = getComputedStyle(card);
        const bg = parse(ccs.backgroundColor);
        painted.cardBg = ccs.backgroundColor;
        painted.cardText = contrast(over(parse(ccs.color), bg), bg);
      }
      const steps = [p('--color-strip'), p('--color-background'), p('--color-sidebar'), p('--color-card'), p('--color-raised')];
      // Rank the surfaces by *measured* luminance rather than by parsing the
      // authored oklch string: the claim is about what a person sees, and a
      // regex on a colour notation breaks the moment a token is written another
      // way (including as a var() reference into the ramp).
      const relLum = (css) => { const c = parse(css); return c ? +Y(c).toFixed(5) : null; };
      const spread = (css) => { const c = parse(css); return c ? Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b) : 99; };
      const stepsL = steps.map(relLum);
      return {
        theme: document.documentElement.dataset.theme,
        skin: document.documentElement.dataset.skin,
        strip: steps[0], bg: steps[1], sidebar: steps[2], cardColor: steps[3], raised: steps[4],
        primary: p('--color-primary'),
        radius: card ? getComputedStyle(card).borderRadius : null,
        enter: resolvedMs('--motion-enter'), exit: resolvedMs('--motion-exit'),
        cards: document.querySelectorAll('.repo-grid > *').length,
        body: pair('var(--color-card)', 'var(--color-foreground)'),
        muted: pair('var(--color-card)', 'var(--color-muted-foreground)'),
        primaryPair: pair('var(--color-primary)', 'var(--color-primary-foreground)'),
        primaryAsText: pair('var(--color-background)', 'var(--color-primary)'),
        ladderMonotone: stepsL.every((v) => v !== null) &&
          stepsL[0] < stepsL[1] && stepsL[1] < stepsL[2] && stepsL[2] < stepsL[3] && stepsL[3] < stepsL[4],
        stepsL,
        // Every surface must sit on the one neutral ramp: no channel spread worth
        // calling a hue. This is the measurable form of "皮肤不再各自带底色".
        allNeutral: steps.every((s) => spread(s) <= 14),
        // Positive control: the blue must register as coloured by the same function,
        // otherwise "all surfaces are neutral" would pass on a broken sensor.
        primaryIsChromatic: spread(p('--color-primary')) > 30,
        painted,
      };
    `, "measure");

  const peak = (ms) => `
    // Only animations whose target is a card count: the document also carries chrome
    // animations, and a peak over all of them measured the shell rather than the claim.
    const onWall = () => document.getAnimations().filter((a) => {
      const t = a.effect && a.effect.target;
      return t && t.closest && t.closest('.repo-grid');
    }).length;
    const sample = async (n) => { let x = 0; for (let i = 0; i < Math.ceil(n / 15); i++) { x = Math.max(x, onWall()); await new Promise((r) => setTimeout(r, 15)); } return x; };
    const input = document.querySelector('input[aria-label="搜索项目"]');
    if (!input) return { __error: 'not on the project wall' };
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const idle = onWall();
    setter.call(input, 'z');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const during = await sample(${ms});
    setter.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const back = await sample(${ms});
    ${sleep(400)}
    return { idle, during, back, flag: document.documentElement.dataset.motion, cards: document.querySelectorAll('.repo-grid > *').length };
  `;

  // --- 1. both themes --------------------------------------------------------
  const warmed = await warm();
  await ev(go("外观"), "go-appearance");
  const lightSet = await ev(clickTheme("浅色"), "theme-light");
  await ev(go("项目"), "go-projects-1");
  const lightM = await measure();
  if (lightM.__error) {
    return {
      verdict: "FAIL",
      failed: 1,
      checks: [{ label: 'measure() failed', pass: false, detail: JSON.stringify(lightM) }],
      lightM,
    };
  }
  checks.push(
    ok('浅色：正文 / 次要 / primary 三对 token 全部 ≥ 4.5',
      lightSet === "light" && lightM.body >= 4.5 && lightM.muted >= 4.5 && lightM.primaryPair >= 4.5,
      `setTheme=${lightSet} body=${lightM.body} muted=${lightM.muted} primary=${lightM.primaryPair} (${lightM.primary})`),
    ok('浅色：painted 卡片文字与 token 一致（组件没有各自跑色）',
      lightM.painted.cardText !== null && lightM.painted.cardText >= 4.5,
      `paintedCardText=${lightM.painted.cardText} cardBg=${lightM.painted.cardBg}`),
    ok('浅色：五级表面全部落在同一条中性阶上，且抬升顺序正确',
      lightM.allNeutral === true && lightM.primaryIsChromatic === true &&
        lightM.stepsL[0] < lightM.stepsL[2] &&
        lightM.stepsL[2] < lightM.stepsL[1] &&
        lightM.stepsL[1] < lightM.stepsL[3] &&
        lightM.stepsL[4] >= lightM.stepsL[3],
      `strip=${lightM.strip} sidebar=${lightM.sidebar} bg=${lightM.bg} card=${lightM.cardColor} raised=${lightM.raised}`),
  );

  await ev(go("外观"), "go-appearance-2");
  const darkSet = await ev(clickTheme("深色"), "theme-dark");
  await ev(go("项目"), "go-projects-2");
  const darkM = await measure();
  checks.push(
    ok('深色：三对 token 同样达标，primary 与浅色同为 258 色相，明度阶梯仍单调',
      darkSet === "dark" && darkM.body >= 4.5 && darkM.muted >= 4.5 && darkM.primaryPair >= 4.5 &&
        /258/.test(String(darkM.primary)) && darkM.ladderMonotone === true && darkM.allNeutral === true,
      `setTheme=${darkSet} body=${darkM.body} muted=${darkM.muted} primary=${darkM.primaryPair} token=${darkM.primary} monotone=${darkM.ladderMonotone}`),
  );

  // --- 2. a skin moves density, never hue -----------------------------------
  await ev(go("外观"), "go-appearance-3");
  const skins = await ev(`
    ${NAV}
    ${COLOUR}
    const read = () => {
      const cs = getComputedStyle(document.documentElement);
      const card = document.querySelector('.repo-grid > *');
      return {
        skin: document.documentElement.dataset.skin,
        primary: cs.getPropertyValue('--color-primary').trim(),
        radius: card ? getComputedStyle(card).borderRadius : null,
        enter: resolvedMs('--motion-enter'),
        gridMin: cs.getPropertyValue('--skin-grid-min').trim(),
      };
    };
    const seen = [];
    const back = () => gotoView("projects", 500);
    const there = () => gotoAppearance();
    for (const w of ['柔和', '硬朗', '醒目']) {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === w);
      if (!b) { seen.push({ missing: w }); continue; }
      b.click();
      await new Promise((r) => setTimeout(r, 420));
      // Radius lives on the cards, and there are no cards on 外观 — reading it there
      // returned null and the check failed on an empty measurement.
      await back();
      const row = read();
      await there();
      await new Promise((r) => setTimeout(r, 450));
      seen.push(row);
    }
    return seen;
  `, "skins");
  const list = Array.isArray(skins) ? skins.filter((s) => s.skin) : [];
  checks.push(
    ok('三个皮肤：primary 完全相同，圆角 / 时长 / 网格密度三者互不相同',
      list.length === 3 &&
        new Set(list.map((s) => s.primary)).size === 1 &&
        new Set(list.map((s) => s.radius)).size === 3 &&
        new Set(list.map((s) => s.enter)).size === 3 &&
        new Set(list.map((s) => s.gridMin)).size === 3,
      JSON.stringify(skins)),
  );

  // --- 3. list motion, menu lifecycle, the switch over both ------------------
  await ev(go("项目"), "go-projects-3");
  const withMotion = await ev(peak(220), "peak-full");
  const menuLife = await ev(`
    const card = document.querySelector('.repo-grid > *');
    if (!card) return { __error: 'no card to right-click' };
    const r0 = card.getBoundingClientRect();
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r0.left + 20, clientY: r0.top + 20 }));
    ${sleep(160)}
    const opened = [...document.querySelectorAll('[data-layer]')].map((e) => e.dataset.layer + ':' + e.dataset.state);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    ${sleep(40)}
    const closing = [...document.querySelectorAll('[data-layer]')].map((e) => e.dataset.layer + ':' + e.dataset.state);
    ${sleep(420)}
    const gone = document.querySelectorAll('[data-layer]').length === 0;
    return { opened, closing, gone };
  `, "menu-lifecycle");
  checks.push(
    ok('过滤 / 还原触发真实 WAAPI 动画（auto-animate 已挂到墙上）',
      withMotion.during > withMotion.idle && withMotion.back > withMotion.idle,
      JSON.stringify(withMotion)),
    ok('菜单：打开 → Escape 后以 closed 留在 DOM 播消失 → 随后卸载',
      menuLife.opened?.some((s) => s === "menu:open") &&
        menuLife.closing?.some((s) => s === "menu:closed") &&
        menuLife.gone === true,
      JSON.stringify(menuLife)),
  );

  await ev(go("外观"), "go-appearance-4");
  const setReduced = await ev(setMotionFlag("reduced"), "set-reduced");
  await ev(go("项目"), "go-projects-4");
  const withoutMotion = await ev(peak(220), "peak-reduced");
  const reducedExit = await ev(`
    ${COLOUR}
    return { exit: resolvedMs('--motion-exit'), enter: resolvedMs('--motion-enter'), flag: document.documentElement.dataset.motion };
  `, "resolved-reduced");
  await ev(go("外观"), "go-appearance-5");
  const restored = await ev(setMotionFlag("full"), "restore-full");

  checks.push(
    ok('减弱动画开：动画峰值 ≤ 1 且 enter/exit 被压平（CSS 与 WAAPI 两条路同时归零）',
      setReduced === "reduced" && withoutMotion.during <= 1 &&
        Number.parseFloat(reducedExit.exit) < 0.02 && Number.parseFloat(reducedExit.enter) < 0.02,
      JSON.stringify({ setReduced, peak: withoutMotion, reducedExit })),
    ok('开关切回后动画恢复',
      restored === "full" && (withMotion.during ?? 0) > (withoutMotion.during ?? 0),
      `restored=${restored} full-peak=${withMotion.during} reduced-peak=${withoutMotion.during}`),
  );

  await ev(go("项目"), "go-projects-final");

  const failed = checks.filter((c) => !c.pass).length;
  return {
    // The runner parses `verdict`, so a scenario that only reports a count shows up as UNPARSEABLE.
    verdict: failed === 0 ? "PASS" : "FAIL",
    warmed,
    failed,
    checks,
    lightM,
    darkM,
    skins,
    withMotion,
    withoutMotion,
    reducedExit,
    menuLife,
  };
}
