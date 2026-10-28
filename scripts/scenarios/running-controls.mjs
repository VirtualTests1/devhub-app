/**
 * Item 9, second half: the status strip has to answer "which one is running,
 * and what can I do about it".
 *
 * Opens the 运行中 segment, then exercises 挂起 → 恢复 → 停止 for real and reads
 * the process state back from the document each time.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function poll(cdp, statements, { timeoutMs = 12000, everyMs = 300, label = "?" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = await cdp.evaluate(statements).catch((e) => {
      throw new Error(`${label}: ${e.message}`);
    });
    if (hit) return hit;
    await sleep(everyMs);
  }
  return false;
}

const popover = `
  const p = document.querySelector('[data-reg-id="status-seg-active"]')?.closest('div.relative');
  const box = [...document.querySelectorAll('div')].find((d) =>
    d.textContent.includes('挂起会冻结整个进程树') || d.querySelector('button')?.textContent.includes('挂起'));
  return {
    triggerText: document.querySelector('[data-reg-id="status-seg-active"]')?.textContent.trim() ?? null,
    expanded: document.querySelector('[data-reg-id="status-seg-active"]')?.getAttribute('aria-expanded') ?? null,
    open: !!box,
    text: box ? box.textContent.trim().slice(0, 260) : null,
    buttons: box ? [...box.querySelectorAll('button')].map((b) => b.textContent.trim()).slice(0, 10) : null,
  };
`;

export default async function (cdp) {
  const out = {};

  out.before = await cdp.evaluate(popover);

  await cdp.evaluate(`
    document.querySelector('[data-reg-id="status-seg-active"]')?.click();
    await new Promise((r) => setTimeout(r, 500));
  `);
  out.opened = await cdp.evaluate(popover);

  // --- 挂起 ---------------------------------------------------------------
  await poll(cdp, `
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '挂起');
    if (!b) return false;
    b.click();
    return true;
  `, { label: "挂起" });
  await sleep(1200);
  out.suspended = await cdp.evaluate(popover);

  // --- 恢复 ---------------------------------------------------------------
  await poll(cdp, `
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '恢复');
    if (!b) return false;
    b.click();
    return true;
  `, { label: "恢复" });
  await sleep(1200);
  out.resumed = await cdp.evaluate(popover);

  // --- 停止 ---------------------------------------------------------------
  await poll(cdp, `
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '停止');
    if (!b) return false;
    b.click();
    return true;
  `, { label: "停止" });
  await poll(cdp, `return !document.body.innerText.includes('运行中 1');`, {
    timeoutMs: 15000,
    label: "count back to 0",
  });

  out.afterStop = await cdp.evaluate(`
    const tile = [...document.querySelectorAll('.skin-card')].find((b) =>
      (b.getAttribute('title') ?? '').includes('testowner/zfixture'));
    return {
      trigger: document.querySelector('[data-reg-id="status-seg-active"]')?.textContent.trim() ?? null,
      tileText: tile ? tile.textContent.trim() : null,
      runningLabels: [...document.querySelectorAll('button')]
        .map((b) => b.textContent.trim())
        .filter((t) => /运行中/.test(t) && t.length < 24),
      nav: [...document.querySelectorAll('.skin-nav')].map((b) => b.textContent.trim()),
    };
  `);

  out.consoleErrors = cdp.consoleErrors;
  return out;
}
