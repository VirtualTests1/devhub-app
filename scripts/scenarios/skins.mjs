/**
 * Skin check: are the three directions actually different?
 *
 * The report was "样式观感差距不大" - switching between them barely changed the
 * impression. Measuring is the only way to know whether that is still true, and
 * the measurement has to cover the axes that carry "feel", not just radius.
 *
 * Same markup for all three, so any difference measured here is the design
 * language, not the content.
 */

import { NAV } from "../nav.mjs";

const LABELS = ["柔和", "硬朗", "醒目"];

async function collect(cdp) {
  return cdp.evaluate(`
    const shell = document.querySelector('[data-skin]');
    const cs = getComputedStyle(shell);
    const v = (name) => cs.getPropertyValue(name).trim();
    const card = document.querySelector('.skin-card');
    const cardCs = card ? getComputedStyle(card) : null;
    const grid = document.querySelector('.repo-grid');
    const gridCs = grid ? getComputedStyle(grid) : null;
    const title = document.querySelector('.skin-title');
    const titleCs = title ? getComputedStyle(title) : null;
    const nav = document.querySelector('.skin-nav[data-active="true"]');
    const navCs = nav ? getComputedStyle(nav) : null;
    const label = document.querySelector('.skin-label');
    const labelCs = label ? getComputedStyle(label) : null;
    const cover = document.querySelector('.skin-cover');
    const coverCs = cover ? getComputedStyle(cover) : null;
    return {
      skin: shell.getAttribute('data-skin'),
      primary: v('--color-primary'),
      background: v('--color-background'),
      cardRadius: cardCs ? cardCs.borderRadius : null,
      cardShadow: cardCs ? cardCs.boxShadow : null,
      gridMin: v('--skin-grid-min'),
      gridGap: gridCs ? gridCs.gap : null,
      columns: gridCs ? gridCs.gridTemplateColumns.split(' ').length : null,
      columnWidth: gridCs ? Math.round(parseFloat(gridCs.gridTemplateColumns.split(' ')[0])) : null,
      titleWeight: titleCs ? titleCs.fontWeight : null,
      titleSize: titleCs ? titleCs.fontSize : null,
      titleTracking: titleCs ? titleCs.letterSpacing : null,
      labelTransform: labelCs ? labelCs.textTransform : null,
      labelTracking: labelCs ? labelCs.letterSpacing : null,
      navActiveBg: navCs ? navCs.backgroundColor : null,
      navActiveShadow: navCs ? navCs.boxShadow : null,
      navActiveColor: navCs ? navCs.color : null,
      coverFilter: coverCs ? coverCs.filter : null,
      duration: v('--skin-dur'),
      tileCount: document.querySelectorAll('.skin-card').length,
    };
  `);
}

export default async function (cdp) {
  const VIEW_ID = { 项目: "projects", 添加: "add", 记录: "records", 常用: "frequent" };
  const showView = async (label) =>
    cdp.evaluate(
      `${NAV}
      ${
        label === "外观"
          ? "await gotoAppearance();"
          : label === "设置"
            ? "await gotoSettings();"
            : `await gotoView(${JSON.stringify(VIEW_ID[label])});`
      }
    `,
    );

  const labelMetrics = () =>
    cdp.evaluate(`
      const label = document.querySelector('.skin-label');
      if (!label) return { labelText: null };
      const cs = getComputedStyle(label);
      return {
        labelText: label.textContent.trim().slice(0, 12),
        labelTransform: cs.textTransform,
        labelTracking: cs.letterSpacing,
      };
    `);

  await showView("项目");
  const results = [];
  const errors = [];

  for (const label of LABELS) {
    // The skin picker lives on the 外观 page since round 6; before that it was in
    // 设置. This loop searched wherever the previous step had left the app, so the
    // buttons were "not found" while the feature was intact.
    await showView("外观");
    const clicked = await cdp.evaluate(`
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)});
      if (!btn) return false;
      btn.click();
      // Two frames plus the transition duration: the attribute lands first, the
      // styles follow once React has re-rendered.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      await new Promise((r) => setTimeout(r, 350));
      return true;
    `);
    if (!clicked) {
      errors.push(`skin button "${label}" not found`);
      continue;
    }
    await showView("项目");
    const wall = await collect(cdp);
    // Panel headings only exist in the other two views; measure them there.
    await showView("设置");
    const panel = await labelMetrics();
    results.push({ ...wall, ...panel });
  }

  await showView("项目");

  // A skin switch that only changes colour is not a different direction — and
  // since 需求 1 a skin may not change colour AT ALL: hue belongs to the theme,
  // a skin owns density. So `primary` left the polarisation list and became an
  // invariance check below; the axes that must still differ are the density ones.
  const keys = [
    "cardRadius",
    "cardShadow",
    "gridMin",
    "columns",
    "titleWeight",
    "labelTransform",
    "navActiveBg",
    "navActiveShadow",
    "coverFilter",
    "duration",
  ];
  const distinct = {};
  for (const key of keys) {
    distinct[key] = new Set(results.map((r) => JSON.stringify(r[key]))).size;
  }

  const identical = Object.entries(distinct)
    .filter(([, n]) => n < results.length)
    .map(([k]) => k);

  const primaries = new Set(results.map((r) => JSON.stringify(r.primary)));
  if (primaries.size > 1) {
    errors.push(`皮肤仍在改色相：${[...primaries].join(" / ")}`);
  }

  return {
    skins: results,
    distinctValuesPerAxis: distinct,
    axesStillShared: identical,
    primariesShared: primaries.size === 1,
    // `polarised` = at most a third of the measured axes are identical across all
    // three skins. Before this round every axis except colour was shared.
    polarised: identical.length <= 3,
    errors,
    verdict: identical.length <= 3 && errors.length === 0 && results.length === LABELS.length ? "PASS" : "FAIL",
  };
}
