/**
 * Item 1, second layer: per-project settings.
 *
 * Opens 项目设置… from the real right-click menu and drives every field the layer
 * owns: the alias (localStorage side), 逐步确认, 端口段, 虚拟环境 (all three written
 * into the repository's own `.devhub.json`) and 封面 (localStorage, but the app must
 * copy the chosen image into the cover cache and the card must serve it from there).
 * The disk half is checked outside this script, because a file the app wrote is
 * stronger evidence than what the app says it wrote.
 *
 * The port block is tried twice on purpose: once with a number another fixture
 * repository already holds, which has to come back refused and name the holder, and
 * once with a free one. Same for the venv row: the repository directory itself is not
 * an environment and must be refused, the fixture's `venvs/<repo>_<owner>` is.
 */
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function (cdp) {
  const out = {};

  await cdp.send("Page.reload", { ignoreCache: true });
  await cdp.waitFor("document.querySelector('[data-skin]') !== null", { timeoutMs: 30000 });
  await cdp.evaluate(`
    const nav = [...document.querySelectorAll('.skin-nav')].find((b) => b.textContent.includes('项目'));
    nav?.click();
    await new Promise((s) => setTimeout(s, 900));
  `);

  out.menu = await cdp.evaluate(`
    const tile = [...document.querySelectorAll('.skin-card')].find((b) =>
      (b.getAttribute('title') ?? '').includes('testowner/zfixture'));
    const r = tile.getBoundingClientRect();
    tile.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true,
      clientX: Math.round(r.left + 20), clientY: Math.round(r.top + 20),
    }));
    await new Promise((s) => setTimeout(s, 400));
    const menu = document.querySelector('[role=menu]');
    return menu ? [...menu.querySelectorAll('[role=menuitem]')].map((i) => i.textContent.trim()) : null;
  `);

  out.opened = await cdp.evaluate(`
    const item = [...document.querySelectorAll('[role=menuitem]')].find((i) =>
      i.textContent.includes('项目设置'));
    if (!item) return false;
    item.click();
    await new Promise((s) => setTimeout(s, 900));
    const dlg = [...document.querySelectorAll('.fixed.inset-0')].pop();
    return dlg ? dlg.textContent.replace(/\\s+/g, ' ').trim().slice(0, 400) : null;
  `);
  if (!out.opened) return { ...out, consoleErrors: cdp.consoleErrors };

  // The alias half is covered by alias-typing.mjs, which types through the CDP
  // Input domain. Writing `input.value` from here never reaches React's onChange,
  // so an assertion here would only ever measure the harness.
  out.stepwise = await cdp.evaluate(`
    const dlg = [...document.querySelectorAll('.fixed.inset-0')].pop();
    const b = [...dlg.querySelectorAll('button')].find((x) => x.textContent.trim() === '开');
    if (!b) return null;
    b.click();
    await new Promise((s) => setTimeout(s, 1200));
    return b.getAttribute('aria-pressed') ?? b.className.includes('primary');
  `);

  // ---- 封面 / 端口段 / 虚拟环境 -------------------------------------------
  // These three rows are the part of item 1 that the first pass left read-only.
  // Nothing here trusts the app's own word for a write: the fields are driven with
  // real value changes, and the marker file and the cover copy are then read off the
  // disk outside this script.
  const fixtures = process.env.DEVHUB_FIXTURE_ROOT ?? path.join(process.cwd(), ".cdpfixtures");
  const coverFile = path.join(process.cwd(), "src-tauri", "icons", "32x32.png");

  out.rows = await cdp.evaluate(`
    const dlg = [...document.querySelectorAll('.fixed.inset-0')].pop();
    const found = (n) => !!dlg?.querySelector('input[name="' + n + '"]');
    return {
      cover: found('cover'),
      venv: found('venv'),
      portBase: found('portBase'),
      pickers: [...dlg.querySelectorAll('button')].filter((b) =>
        b.textContent.includes('浏览')).length,
    };
  `);

  const toastExpr = `
    const host = document.querySelector('[data-reg-id="toast-host"]');
    return host ? host.innerText.replace(/\\s+/g, ' ').trim() : null;
  `;

  const setField = async (name, value) => {
    return cdp.evaluate(`
      const dlg = [...document.querySelectorAll('.fixed.inset-0')].pop();
      const input = dlg.querySelector('input[name="${name}"]');
      if (!input) return "no field";
      // Written through the native setter: assigning input.value directly changes the
      // DOM but leaves React's state untouched, which would make every assertion below
      // a measurement of the harness rather than of the app.
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      input.focus();
      setter.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((s) => setTimeout(s, 200));
      return input.value;
    `);
  };

  const pressEnter = (name) => `
    const dlg = [...document.querySelectorAll('.fixed.inset-0')].pop();
    const input = dlg.querySelector('input[name="${name}"]');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    return true;
  `;

  // Committed with the field's Enter handler, not `blur()`: while the window is not
  // the foreground window, input.focus() and input.blur() produce no events at all, so
  // a blur-driven commit silently never runs and the row looks broken. PathInput routes
  // Enter and blur into the same onCommit, so this is the same code path a user takes.
  const commitField = (name) => `
    const dlg = [...document.querySelectorAll('.fixed.inset-0')].pop();
    const input = dlg.querySelector('input[name="${name}"]');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((s) => setTimeout(s, 300));
    return true;
  `;

  // A block another repository already holds has to be refused, naming the holder.
  out.portTypedCollision = await setField("portBase", "20000");
  await cdp.evaluate(pressEnter("portBase"));
  await sleep(1600);
  out.portCollisionToast = await cdp.evaluate(toastExpr);

  // A free, grid-aligned block is accepted.
  out.portTypedFree = await setField("portBase", "29960");
  await cdp.evaluate(pressEnter("portBase"));
  await sleep(1600);
  out.portFreeToast = await cdp.evaluate(toastExpr);

  // The venv row refuses the repository itself and takes the venv-shaped directory.
  await setField("venv", path.join(fixtures, "testowner_zfixture"));
  await cdp.evaluate(commitField("venv"));
  await sleep(1600);
  out.venvRejectToast = await cdp.evaluate(toastExpr);

  await setField("venv", path.join(fixtures, "venvs", "testowner_zfixture"));
  await cdp.evaluate(commitField("venv"));
  await sleep(1600);
  out.venvAcceptToast = await cdp.evaluate(toastExpr);
  // A successful write has no toast by design (only 端口段 announces itself), so the
  // accept path is read back from the marker through the same command the dialog uses.
  out.venvAcceptReadback = await cdp.evaluate(`
    const d = await window.__TAURI_INTERNALS__.invoke("repo_detail", {
      slug: "github.com/testowner/zfixture" });
    return { venvPath: d.venvPath, portBase: d.portBase };
  `);

  // The chosen cover must reach the card. Reading the <img> src is the point: it
  // proves the asset protocol served the copy, not that the app believes it did.
  await setField("cover", coverFile);
  await cdp.evaluate(commitField("cover"));
  await sleep(2200);
  out.coverOnTile = await cdp.evaluate(`
    const tile = [...document.querySelectorAll('.skin-card')].find((b) =>
      (b.getAttribute('title') ?? '').includes('testowner/zfixture'));
    const img = tile?.querySelector('img');
    const tip = (tile?.getAttribute('title') ?? '').split('\\n').find((l) => l.startsWith('封面')) ?? null;
    return { src: img ? decodeURIComponent(img.getAttribute('src') ?? '') : null, tip };
  `);

  out.stored = await cdp.evaluate(`
    const parsed = JSON.parse(localStorage.getItem('devhub.wall.v1') || '{}');
    return { zfixture: parsed.repos?.['github.com/testowner/zfixture'] ?? null };
  `);

  out.tileAfter = await cdp.evaluate(`
    const dlg = [...document.querySelectorAll('.fixed.inset-0')].pop();
    const close = [...dlg.querySelectorAll('button')].find((b) =>
      b.querySelector('svg') && b.textContent.trim() === '');
    close?.click();
    await new Promise((s) => setTimeout(s, 500));
    const tile = [...document.querySelectorAll('.skin-card')].find((b) =>
      (b.getAttribute('title') ?? '').includes('testowner/zfixture'));
    return tile ? tile.textContent.trim() : null;
  `);

  out.consoleErrors = cdp.consoleErrors;
  return out;
}
