/**
 * Item 7, the half that is not about size: the boot surface must already be in the
 * saved theme.
 *
 * `tauri.conf.json` gives the window a fixed background, and the inline script in
 * `index.html` reads the appearance key from `localStorage` before the first paint.
 * If that read fails - wrong key, a corrupt value, an exception swallowed by the
 * try/catch - a light-theme user gets a dark rectangle first and a light app after,
 * which is the same class of flash the rest of this file exists to remove.
 *
 * What is asserted is the `data-boot-theme` attribute and the `--boot-bg` the page
 * ends up with, sampled as early as the protocol allows. The attribute is set by the
 * inline script and never removed afterwards, so a sample taken after React mounted
 * still proves the read happened; whether the boot panel was still on screen at that
 * moment is recorded separately rather than silently assumed.
 *
 * The theme is restored at the end: this scenario writes to the user's own storage.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sample = `
  const boot = document.getElementById('boot');
  const html = document.documentElement;
  const name = boot ? (boot.innerText || '').replace(/\\s+/g, ' ').trim() : '';
  return {
    t: Math.round(performance.now()),
    bootTheme: html.getAttribute('data-boot-theme'),
    htmlBg: getComputedStyle(html).backgroundColor,
    bootBgVar: getComputedStyle(html).getPropertyValue('--boot-bg').trim(),
    bootPresent: !!boot,
    bootVisible: !!boot && getComputedStyle(boot).opacity !== '0',
    // The panel's own text, to show which phase the sample landed in.
    bootPhase: name.slice(0, 46),
    readyState: document.readyState,
  };
`;

async function earliestSample(cdp) {
  const deadline = Date.now() + 6000;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const s = await cdp.evaluate(sample);
      if (s.bootTheme) return s; // the inline script has already run
      last = s;
    } catch {
      /* context replaced by the reload */
    }
    await sleep(50);
  }
  return last;
}

export default async function (cdp) {
  const out = { verdict: "FAIL", steps: [] };

  out.saved = await cdp.evaluate(`
    return localStorage.getItem('devhub.appearance.v1');
  `);

  const withTheme = async (theme) => {
    await cdp.evaluate(`
      const raw = localStorage.getItem('devhub.appearance.v1');
      const parsed = raw ? JSON.parse(raw) : {};
      parsed.theme = ${JSON.stringify(theme)};
      localStorage.setItem('devhub.appearance.v1', JSON.stringify(parsed));
      return parsed.theme;
    `);
    await cdp.send("Page.reload", { ignoreCache: true });
    return earliestSample(cdp);
  };

  out.light = await withTheme("light");
  out.dark = await withTheme("dark");

  // Restore whatever the person had, including "no stored value at all".
  out.restored = await cdp.evaluate(`
    const saved = ${JSON.stringify(out.saved ?? null)};
    if (saved === null) localStorage.removeItem('devhub.appearance.v1');
    else localStorage.setItem('devhub.appearance.v1', saved);
    return localStorage.getItem('devhub.appearance.v1') === saved;
  `);

  out.steps.push({
    step: "浅色：inline 脚本把 data-boot-theme 设成 light",
    ok: out.light?.bootTheme === "light",
  });
  out.steps.push({
    step: "深色：同一脚本给出 dark",
    ok: out.dark?.bootTheme === "dark",
  });
  out.steps.push({
    step: "两种主题的 boot 底色真的不同（不是一个值套两层皮）",
    ok:
      !!out.light && !!out.dark && !!out.light.bootBgVar &&
      out.light.bootBgVar !== out.dark.bootBgVar,
  });
  out.bootPanelStillUp = { light: !!out.light?.bootVisible, dark: !!out.dark?.bootVisible };
  out.verdict = out.steps.every((s) => s.ok) && out.restored ? "PASS" : "FAIL";
  out.consoleErrors = cdp.consoleErrors;
  return out;
}
