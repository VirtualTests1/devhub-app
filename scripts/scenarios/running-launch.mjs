/**
 * Item 9, first half: a running project has to be visible everywhere.
 *
 * Drives the real UI - tile, action panel, detected command, 确认并启动 - then
 * reads the four places the state is supposed to surface: the card, the 运行中
 * filter count, the status strip, and the sidebar badge. Nothing here asserts on
 * pixels; every value comes out of the document.
 *
 * `poll` uses `cdp.evaluate`, which wraps its argument as a *function body*.
 * `cdp.waitFor` prefixes `return`, so it only takes expressions - passing it a
 * `const` declaration throws a SyntaxError inside the page, and a `.catch` on the
 * caller's side turns that into a quiet false.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function poll(cdp, statements, { timeoutMs = 20000, everyMs = 300, label = "?" } = {}) {
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

const click = (needle) => `
  const b = [...document.querySelectorAll('button')].find((x) =>
    x.textContent.includes(${JSON.stringify(needle)}));
  if (!b) return false;
  b.click();
  return true;
`;

export default async function (cdp) {
  const out = { steps: [] };

  await cdp.send("Page.reload", { ignoreCache: true });
  await cdp.waitFor("document.querySelector('[data-skin]') !== null", { timeoutMs: 30000 });
  await sleep(1500);

  await cdp.evaluate(`
    const nav = [...document.querySelectorAll('.skin-nav')].find((b) => b.textContent.includes('项目'));
    nav?.click();
    await new Promise((r) => setTimeout(r, 600));
    const tile = [...document.querySelectorAll('.skin-card')].find((b) =>
      (b.getAttribute('title') ?? '').includes('testowner/zfixture'));
    tile?.click();
  `);
  out.steps.push({
    step: "打开 fixture 操作面板",
    ok: !!(await cdp.waitFor("!!document.querySelector('.fixed.inset-0')", { timeoutMs: 8000 })),
  });

  out.steps.push({
    step: "选中识别出的 npm run dev",
    ok: await poll(cdp, click("npm run dev"), { label: "candidate" }),
  });
  await sleep(800);

  out.steps.push({
    step: "点击确认并启动",
    ok: await poll(cdp, click("确认并启动"), { timeoutMs: 8000, label: "primary" }),
  });

  out.steps.push({
    step: "筛选计数变为 运行中 1",
    ok: await poll(cdp, `return document.body.innerText.includes('运行中 1');`, {
      timeoutMs: 30000,
      label: "running count",
    }),
  });

  await cdp.evaluate(`
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 600));
  `);

  out.after = await cdp.evaluate(`
    const tile = [...document.querySelectorAll('.skin-card')].find((b) =>
      (b.getAttribute('title') ?? '').includes('testowner/zfixture'));
    const strip = [...document.querySelectorAll('[role=button]')].find((b) => /运行中/.test(b.textContent));
    return {
      dialogStillOpen: !!document.querySelector('.fixed.inset-0'),
      tileText: tile ? tile.textContent.trim() : null,
      runningLabels: [...document.querySelectorAll('button')]
        .map((b) => b.textContent.trim())
        .filter((t) => /运行中/.test(t) && t.length < 24),
      stripText: strip ? strip.textContent.trim() : null,
      nav: [...document.querySelectorAll('.skin-nav')].map((b) => b.textContent.trim()),
    };
  `);

  out.consoleErrors = cdp.consoleErrors;
  return out;
}
