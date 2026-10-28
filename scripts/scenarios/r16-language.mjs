/**
 * Round 16, N2-2: the 界面语言 ChoiceRow (设置 → 界面 → 语言).
 *
 * Two locales only (简体中文 / English); the row is a segmented control whose
 * choice lives in localStorage (`devhub.i18n.locale.v1`) and must (a) flip the
 * live chrome both ways and (b) survive a full reload on its own.
 *
 * The scenario ends in zh-CN unconditionally (click-back asserted first, then a
 * storage-level force + reload in `finally`): a scenario that leaves the app in
 * English would fail every later scenario that reads a Chinese label, i.e. it
 * would manufacture failures it did not cause. The force in `finally` is
 * restoration, not an assertion — the asserted round-trips are the clicks above.
 */
import { NAV } from "../nav.mjs";

const LOCALE_KEY = "devhub.i18n.locale.v1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** localStorage holds JSON (`'"en"'`); tolerate a raw string too. */
function parseStored(raw) {
  if (raw === null || raw === undefined) return null;
  try {
    const v = JSON.parse(raw);
    return typeof v === "string" ? v : raw;
  } catch {
    return raw;
  }
}

export default async function (cdp) {
  const out = {};
  let passed = false;

  // The nav label carries a live count badge (`项目14`), so compare the title
  // part only — stripping digits keeps `Projects` and `项目` as the truth.
  const navProjects = () =>
    cdp.evaluate(
      `return (document.querySelector('[data-reg-id="nav-item-projects"]')?.textContent ?? '').replace(/\\d+/g, '').trim()`,
    );

  const grab = () => cdp.evaluate(`
    const group = document.querySelector('[data-section="language"]');
    if (!group) return null;
    return {
      buttons: [...group.querySelectorAll('button[aria-pressed]')].map((b) => ({
        text: b.textContent.trim(),
        pressed: b.getAttribute('aria-pressed') === 'true',
      })),
      stored: localStorage.getItem(${JSON.stringify(LOCALE_KEY)}),
      rowTitle: (group.textContent ?? '').replace(/\\s+/g, ' ').slice(0, 80),
    };
  `);

  const clickLocale = (needle) => cdp.evaluate(`
    const group = document.querySelector('[data-section="language"]');
    if (!group) return 'no language group';
    const b = [...group.querySelectorAll('button[aria-pressed]')].find((x) =>
      x.textContent.includes(${JSON.stringify(needle)}));
    if (!b) return 'no button ${needle}';
    b.click();
    await new Promise((s) => setTimeout(s, 700));
    return 'clicked';
  `);

  try {
    out.initialNav = await navProjects();
    await cdp.evaluate(NAV + "await gotoSettings(700); await openSettingsPage('界面', 800);");
    out.initial = await grab();

    out.toEnglish = await clickLocale("English");
    await sleep(300);
    out.en = await grab();
    out.enNav = await navProjects();

    out.backToChinese = await clickLocale("简体中文");
    await sleep(300);
    out.zh = await grab();
    out.zhNav = await navProjects();

    // Boot-read: switch again and reload — the locale has to come back from
    // localStorage alone, with no click to help it.
    out.toEnglish2 = await clickLocale("English");
    await cdp.reload();
    await cdp.waitFor("document.querySelector('[data-skin]') !== null", { timeoutMs: 45000 });
    out.bootStored = await cdp.evaluate(`return localStorage.getItem(${JSON.stringify(LOCALE_KEY)})`);
    out.bootNav = await navProjects();

    const bi = out.initial?.buttons ?? [];
    const idx = (needle) => bi.findIndex((b) => b.text.includes(needle));
    const zhIdx = idx("简体中文");
    const enIdx = idx("English");
    const pressedOf = (g, needle) => g?.buttons?.find((b) => b.text.includes(needle))?.pressed ?? null;
    const zhRow = (g) => (g?.rowTitle ?? "").includes("语言");
    const enRow = (g) => (g?.rowTitle ?? "").includes("Language");

    const structureOk =
      out.initial !== null && bi.length === 2 && zhIdx >= 0 && enIdx >= 0 && zhIdx < enIdx;
    const initialOk =
      structureOk &&
      pressedOf(out.initial, "简体中文") === true &&
      pressedOf(out.initial, "English") === false &&
      parseStored(out.initial.stored) !== "en" &&
      out.initialNav === "项目" &&
      zhRow(out.initial);
    const enOk =
      out.toEnglish === "clicked" &&
      parseStored(out.en?.stored) === "en" &&
      pressedOf(out.en, "English") === true &&
      pressedOf(out.en, "简体中文") === false &&
      out.enNav === "Projects" &&
      enRow(out.en);
    const zhOk =
      out.backToChinese === "clicked" &&
      parseStored(out.zh?.stored) === "zh-CN" &&
      pressedOf(out.zh, "简体中文") === true &&
      out.zhNav === "项目" &&
      zhRow(out.zh);
    const bootOk =
      out.toEnglish2 === "clicked" && parseStored(out.bootStored) === "en" && out.bootNav === "Projects";
    passed = structureOk && initialOk && enOk && zhOk && bootOk;
    out.ok = { structureOk, initialOk, enOk, zhOk, bootOk };
  } finally {
    try {
      const raw = await cdp.evaluate(`return localStorage.getItem(${JSON.stringify(LOCALE_KEY)})`);
      if (parseStored(raw) === "zh-CN") {
        out.restored = "already zh-CN";
      } else {
        await cdp.evaluate(`
          localStorage.setItem(${JSON.stringify(LOCALE_KEY)}, JSON.stringify('zh-CN'));
          location.reload();
        `);
        out.restored = "forced via storage + reload";
        await cdp.waitFor("document.querySelector('[data-skin]') !== null", { timeoutMs: 45000 });
      }
      out.restoredCheck =
        parseStored(await cdp.evaluate(`return localStorage.getItem(${JSON.stringify(LOCALE_KEY)})`)) ===
        "zh-CN";
    } catch (e) {
      out.restoredCheck = false;
      out.restoredError = String(e?.message ?? e);
    }
  }

  out.consoleErrors = cdp.consoleErrors;
  out.verdict = passed && out.restoredCheck === true ? "PASS" : "FAIL";
  return out;
}
