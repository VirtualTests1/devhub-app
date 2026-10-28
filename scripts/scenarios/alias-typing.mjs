/**
 * Type into the alias field the way a user does.
 *
 * Setting `input.value` from `Runtime.evaluate` is not enough to prove anything
 * about a controlled React field: React only sees input that arrives as a real
 * trusted event. This uses the CDP Input domain - insertText plus a real Enter
 * keypress - so the field's own onChange/onKeyDown/onBlur handlers all run.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const key = (cdp, type, code, keyCode, text) =>
  cdp.send("Input.dispatchKeyEvent", {
    type,
    key: code,
    code: code === "Enter" ? "Enter" : code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
    text,
  });

export default async function (cdp) {
  const out = {};

  await cdp.send("Page.reload", { ignoreCache: true });
  await cdp.waitFor("document.querySelector('[data-skin]') !== null", { timeoutMs: 30000 });
  await cdp.evaluate(`
    [...document.querySelectorAll('.skin-nav')].find((b) => b.textContent.includes('项目'))?.click();
    await new Promise((s) => setTimeout(s, 900));
    const tile = [...document.querySelectorAll('.skin-card')].find((b) =>
      (b.getAttribute('title') ?? '').includes('testowner/zfixture'));
    const r = tile.getBoundingClientRect();
    tile.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: Math.round(r.left + 20), clientY: Math.round(r.top + 20),
    }));
    await new Promise((s) => setTimeout(s, 400));
    [...document.querySelectorAll('[role=menuitem]')].find((i) =>
      i.textContent.includes('项目设置'))?.click();
    await new Promise((s) => setTimeout(s, 900));
    const input = [...document.querySelectorAll('.fixed.inset-0')].pop().querySelector('input');
    input.focus();
    return document.activeElement === input;
  `);

  await cdp.send("Input.insertText", { text: "夹具·验证" });
  await sleep(300);
  out.valueAfterInsert = await cdp.evaluate(
    `return document.querySelector('.fixed.inset-0 input')?.value ?? null;`,
  );

  await key(cdp, "rawKeyDown", "Enter", 13, "");
  await key(cdp, "char", "Enter", 13, "\r");
  await key(cdp, "keyUp", "Enter", 13, "");
  await sleep(900);

  out.readback = await cdp.evaluate(`
    const parsed = JSON.parse(localStorage.getItem('devhub.wall.v1') || '{}');
    const tile = [...document.querySelectorAll('.skin-card')].find((b) =>
      (b.getAttribute('title') ?? '').includes('testowner/zfixture'));
    return {
      zfixture: parsed.repos?.['github.com/testowner/zfixture'] ?? null,
      tileText: tile ? tile.textContent.trim() : null,
      focused: document.activeElement?.tagName ?? null,
    };
  `);

  out.consoleErrors = cdp.consoleErrors;
  return out;
}
