/**
 * A running project has to come to the front of the wall, and go back after.
 *
 * Grouping is turned off first: in a grouped view a card can only float inside its
 * own owner section, which would make "is it first?" the wrong question.
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

const firstCard = `
  return ([...document.querySelectorAll('.skin-card')][0]?.getAttribute('title') ?? '')
    .split('\\n')[0];
`;

export default async function (cdp) {
  const out = {};

  await cdp.send("Page.reload", { ignoreCache: true });
  await cdp.waitFor("document.querySelector('[data-skin]') !== null", { timeoutMs: 40000 });
  await cdp.evaluate(`
    [...document.querySelectorAll('.skin-nav')].find((b) => b.textContent.includes('项目'))?.click();
    await new Promise((s) => setTimeout(s, 900));
  `);

  out.groupCleared = await poll(cdp, click("按拥有者分组"), { timeoutMs: 6000 });
  await sleep(700);
  out.before = await cdp.evaluate(firstCard);

  await cdp.evaluate(`
    [...document.querySelectorAll('.skin-card')].find((b) =>
      (b.getAttribute('title') ?? '').includes('testowner/zfixture'))?.click();
  `);
  await cdp.waitFor("!!document.querySelector('.fixed.inset-0')", { timeoutMs: 8000 });
  out.picked = await poll(cdp, click("npm run dev"), { timeoutMs: 25000 });
  await sleep(600);
  out.launched =
    (await poll(cdp, click("一键启动"), { timeoutMs: 4000 })) ||
    (await poll(cdp, click("确认并启动"), { timeoutMs: 8000 }));
  out.running = await poll(cdp, `return document.body.innerText.includes('运行中 1');`);
  await sleep(900);

  out.whileRunning = await cdp.evaluate(`
    const cards = [...document.querySelectorAll('.skin-card')];
    return {
      first: (cards[0]?.getAttribute('title') ?? '').split('\\n')[0],
      firstHasRunningMark: /运行中/.test(cards[0]?.textContent ?? ''),
      position: cards.findIndex((b) => (b.getAttribute('title') ?? '').includes('testowner/zfixture')),
      total: cards.length,
    };
  `);

  out.stopped = await poll(cdp, click("停止"), { timeoutMs: 8000 });
  await poll(cdp, `return !document.body.innerText.includes('运行中 1');`, { timeoutMs: 15000 });
  await sleep(900);
  out.afterStop = await cdp.evaluate(firstCard);

  await cdp.evaluate(`${click("按拥有者分组")}`);
  await sleep(500);
  out.regrouped = await cdp.evaluate(
    `return JSON.parse(localStorage.getItem('devhub.wall.v1')).prefs.grouped;`,
  );

  out.consoleErrors = cdp.consoleErrors;
  return out;
}
