/**
 * Settings persistence (item 3).
 *
 * Reported: "项目目录更改之后没有生效，刷新之后又回归默认了".
 *
 * Two causes were found in the source:
 *   1. typing a path did nothing until 保存 was clicked, while the header claimed
 *      everything applied immediately - so the change genuinely did not take effect;
 *   2. `useEffect(..., [settings])` re-adopted the server value on every refresh,
 *      overwriting whatever was being typed.
 *
 * This scenario reproduces the user's exact sequence: type a new directory, click
 * 刷新 in the sidebar, and check that the field still holds the new value. It then
 * checks the value the backend reports, which is what proves the change is live
 * rather than merely displayed.
 */

import { join } from "node:path";

import { NAV } from "../nav.mjs";

export default async function (cdp) {
  const NEW_ROOT = join(process.cwd(), ".cdpfixtures", "newroot");

  await cdp.evaluate(`
    ${NAV}
    await gotoSettings();
  `);

  const before = await cdp.evaluate(`
    const input = [...document.querySelectorAll('input')].find((i) => (i.placeholder ?? '').includes('D:'));
    return input ? input.value : null;
  `);

  // Type it the way a user does: native setter + input event, then commit.
  //
  // A programmatic `element.blur()` is not enough - when the window does not have
  // focus (it does not, during an automated run) it fires nothing, which is what
  // made the first attempt look like a failure. React listens for `focusout` and
  // `keydown`, so those are dispatched instead; the fallback is the 保存 button.
  const committed = await cdp.evaluate(`
    const input = [...document.querySelectorAll('input')].find((i) => (i.placeholder ?? '').includes('D:'));
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(NEW_ROOT)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));

    const state = () => document.body.innerText.includes('已保存并立即生效') ||
      !document.body.innerText.includes('有未保存的改动');

    // 1) Enter
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 1200));
    let via = state() ? 'enter' : null;

    // 2) focusout (what a real blur produces)
    if (!via) {
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 1200));
      via = state() ? 'focusout' : null;
    }

    // 3) the explicit 保存 button
    if (!via) {
      const save = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '保存');
      if (save && !save.disabled) {
        save.click();
        await new Promise((r) => setTimeout(r, 1200));
        via = state() ? 'save-button' : null;
      }
    }
    return { via, buttonDisabled: [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '保存')?.disabled ?? null };
  `);

  const afterBlur = await cdp.evaluate(`
    const input = [...document.querySelectorAll('input')].find((i) => (i.placeholder ?? '').includes('D:'));
    const text = document.body.innerText.replace(/\\s+/g, ' ');
    const m = text.match(/配置文件：\\s*(\\S+)/);
    const errEl = [...document.querySelectorAll('div')].find((d) =>
      d.className && typeof d.className === 'string' && d.className.includes('red-500') && d.textContent.trim());
    return {
      value: input ? input.value : null,
      saysSaved: text.includes('已保存并立即生效'),
      saysUnsaved: text.includes('有未保存的改动'),
      configPath: m ? m[1] : null,
      errorText: errEl ? errEl.textContent.replace(/\\s+/g, ' ').trim() : null,
    };
  `);

  // The regression: click 刷新 and see whether the field keeps the new value.
  await cdp.evaluate(`
    const refresh = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('刷新'));
    refresh.click();
    await new Promise((r) => setTimeout(r, 2500));
  `);

  const afterRefresh = await cdp.evaluate(`
    const input = [...document.querySelectorAll('input')].find((i) => (i.placeholder ?? '').includes('D:'));
    return { value: input ? input.value : null };
  `);

  // And what the backend believes, through the same command the UI uses.
  const backend = await cdp.evaluate(`
    const s = await window.__TAURI_INTERNALS__.invoke('get_settings');
    return { projectRoot: s.projectRoot, projectRootIsDefault: s.projectRootIsDefault, configPath: s.configPath };
  `);

  const normalise = (p) => (p ?? "").replace(/[/\\\\]+/g, "\\\\").replace(/\\\\+$/, "").toLowerCase();
  const target = normalise(NEW_ROOT);

  return {
    before,
    committedVia: committed.via,
    saveButtonDisabled: committed.buttonDisabled,
    afterBlur,
    afterRefresh,
    backend,
    typedValueHeldAfterRefresh: normalise(afterRefresh.value) === target,
    backendUsesNewRoot: normalise(backend.projectRoot) === target,
    savedFlagShown: afterBlur.saysSaved === true,
    verdict:
      normalise(afterRefresh.value) === target && normalise(backend.projectRoot) === target
        ? "PASS"
        : "FAIL",
  };
}
