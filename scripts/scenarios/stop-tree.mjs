/**
 * 停止 has to take the whole tree with it.
 *
 * Reads the PID out of the status strip's own row, clicks 停止, and hands the PID
 * back so the caller can ask Windows - not the app - whether anything survived.
 * The app's own counter going to zero proves nothing on its own; it is the thing
 * that was wrong last time.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const click = (needle) => `
  const b = [...document.querySelectorAll('button')].find((x) =>
    x.textContent.includes(${JSON.stringify(needle)}));
  if (!b) return false;
  b.click();
  return true;
`;

async function poll(cdp, statements, { timeoutMs = 25000, everyMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(statements)) return true;
    await sleep(everyMs);
  }
  return false;
}

export default async function (cdp) {
  const out = {};

  await cdp.send("Page.reload", { ignoreCache: true });
  await cdp.waitFor("document.querySelector('[data-skin]') !== null", { timeoutMs: 40000 });
  await cdp.evaluate(`
    [...document.querySelectorAll('.skin-nav')].find((b) => b.textContent.includes('项目'))?.click();
    await new Promise((s) => setTimeout(s, 900));
    [...document.querySelectorAll('.skin-card')].find((b) =>
      (b.getAttribute('title') ?? '').includes('testowner/zfixture'))?.click();
  `);
  await cdp.waitFor("!!document.querySelector('.fixed.inset-0')", { timeoutMs: 8000 });

  out.picked = await poll(cdp, click("npm run dev"), { timeoutMs: 25000 });
  await sleep(600);
  // Picking a recognised command confirms it, so the primary button is already
  // 一键启动 on a repository whose command was set by an earlier run.
  out.launched =
    (await poll(cdp, click("一键启动"), { timeoutMs: 4000 })) ||
    (await poll(cdp, click("确认并启动"), { timeoutMs: 8000 }));
  out.running = await poll(cdp, `return document.body.innerText.includes('运行中 1');`);

  await cdp.evaluate(`
    document.querySelector('[data-reg-id="status-seg-active"]')?.click();
    await new Promise((s) => setTimeout(s, 500));
  `);
  out.row = await cdp.evaluate(`
    return ([...document.querySelectorAll('div,span,p')]
      .map((e) => e.textContent.trim())
      .find((t) => /PID \\d+ · 已运行/.test(t) && t.length < 120)) ?? null;
  `);
  out.pid = out.row ? Number((out.row.match(/PID (\\d+)/) ?? [])[1]) : null;

  out.stopped = await poll(cdp, click("停止"), { timeoutMs: 8000 });
  await poll(cdp, `return !document.body.innerText.includes('运行中 1');`, { timeoutMs: 15000 });
  await sleep(1500);

  out.wallAfter = await cdp.evaluate(`
    return { labels: [...document.querySelectorAll('button')].map((b) => b.textContent.trim())
        .filter((t) => /运行中 \\d/.test(t) && t.length < 20) };
  `);
  out.consoleErrors = cdp.consoleErrors;
  return out;
}
