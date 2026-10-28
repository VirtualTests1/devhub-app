/**
 * Does the 外观 font picker now read the registry?
 *
 * The fallback list is 11 curated families; a registry enumeration on this
 * machine is far larger and carries families the curated list has never heard
 * of. The picker's own hint text also flips, so both signals are read.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

import { NAV } from "../nav.mjs";

const FALLBACK = [
  "Microsoft YaHei", "SimSun", "SimHei", "KaiTi", "FangSong", "DengXian",
  "Cascadia Mono", "Consolas", "Segoe UI", "Arial", "Times New Roman",
];

export default async function (cdp) {
  await cdp.send("Page.reload", { ignoreCache: true });
  await cdp.waitFor("document.querySelector('[data-skin]') !== null", { timeoutMs: 60000 });
  await cdp.evaluate(`
    ${NAV}
    await gotoAppearance();
    await new Promise((s) => setTimeout(s, 1200));
  `);

  const opened = await cdp.evaluate(`
    const b = document.querySelector('button[aria-haspopup="listbox"]');
    if (!b) return false;
    b.click();
    return true;
  `);
  await sleep(2500);

  const read = await cdp.evaluate(`
    const box = document.querySelector('[role="listbox"]');
    const hint = ([...document.querySelectorAll('p,span,div')]
      .map((e) => e.textContent.trim())
      .find((t) => t.includes('字体') && (t.includes('已安装') || t.includes('未就绪')))) ?? null;
    return {
      hint,
      options: box ? box.querySelectorAll('button,[role=option]').length : -1,
      sample: box ? [...box.querySelectorAll('button,[role=option]')]
        .slice(0, 8).map((o) => o.textContent.trim()) : null,
    };
  `);

  const outsideFallback = (read.sample ?? []).filter((s) => !FALLBACK.some((f) => s.startsWith(f)));
  return { opened, ...read, outsideFallback, consoleErrors: cdp.consoleErrors };
}
