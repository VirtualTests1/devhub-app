/**
 * Item 3 × item 9: dragging while something is running must not freeze the
 * floating position.
 *
 * The wall floats running projects to the front (置顶 > 运行中 > 手动位置 > rest).
 * That tier only exists while the process lives, so if a drag writes the *displayed*
 * sequence into the manual-order index, the running card inherits a permanent slot at
 * the front and stays there after it stops - which is the opposite of 停下后回到原位.
 *
 * This scenario is the regression test for that. It records where the fixture card
 * actually lives, starts it, drags a *different* card onto it, stops it through the
 * status strip's 运行中 popover (which also exercises item 9's popover and 停止), and
 * then asks the only question that matters: is the card back where it started, and did
 * its stored index survive the drag unchanged?
 *
 * Drop-target note: dropping onto a floating card puts the dragged card at the
 * floating card's real position. The front of the wall while something is running is
 * not a place anybody can own, so it is not what gets stored.
 *
 * Needs the `testowner/zfixture` repository (a Node project with a real `npm run
 * dev`), which `scripts/verify-fixes.ps1` creates.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const click = (needle) => `
  const b = [...document.querySelectorAll('button')].find((x) =>
    x.textContent.includes(${JSON.stringify(needle)}));
  if (!b) return false;
  b.click();
  return true;
`;

async function poll(cdp, statements, { timeoutMs = 20000, everyMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdp.evaluate(statements)) return true;
    await sleep(everyMs);
  }
  return false;
}

const FIXTURE = "testowner/zfixture";

const orderExpr = `
  return [...document.querySelectorAll('.skin-card')].map((b) =>
    (b.getAttribute('title') ?? '').split('\\n')[0]);
`;

const positionExpr = `
  const cards = [...document.querySelectorAll('.skin-card')];
  return cards.findIndex((b) => (b.getAttribute('title') ?? '').includes(${JSON.stringify(FIXTURE)}));
`;

const storedIndexExpr = `
  const parsed = JSON.parse(localStorage.getItem('devhub.wall.v1') || '{}');
  return parsed.repos?.[${JSON.stringify("github.com/" + FIXTURE)}]?.index ?? null;
`;

const mouse = (cdp, type, x, y, buttons) =>
  cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons, clickCount: 1 });

async function dragCard(cdp, fromIndex, toIndex) {
  // Scroll the source card fully into view first: with 宽松 density (or a short window)
  // the last card sits below the viewport, and a press at its coordinates lands on
  // nothing - the drag then "never arms" and the assertion below would pass vacuously.
  await cdp.evaluate(`
    const cards = [...document.querySelectorAll('.skin-card')];
    cards[${fromIndex}]?.scrollIntoView({ block: 'center' });
    await new Promise((s) => setTimeout(s, 400));
    return cards.length;
  `);
  const boxes = await cdp.evaluate(`
    return [...document.querySelectorAll('.skin-card')].slice(0, 6).map((b) => {
      const r = b.getBoundingClientRect();
      // Press in the cover band, not the card's middle: the tile is one big button and
      // a press that lands on the text rows below does not arm dnd-kit's PointerSensor.
      // Measured both ways: this press point reports the sensor's start event and the
      // dragging class, the vertical centre reports neither and nothing moves.
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 40),
               inside: r.top >= 0 && r.bottom <= innerHeight };
    });
  `);
  const from = boxes[fromIndex];
  const to = boxes[toIndex];
  if (!from || !to) return "no card";
  if (!from.inside || !to.inside) return "outside viewport";
  await mouse(cdp, "mousePressed", from.x, from.y, 1);
  await sleep(120);
  for (let i = 1; i <= 20; i += 1) {
    const x = Math.round(from.x + ((to.x - from.x) * i) / 20);
    const y = Math.round(from.y + ((to.y - from.y) * i) / 20);
    await mouse(cdp, "mouseMoved", x, y, 1);
    await sleep(60);
  }
  await sleep(250);
  const engaged = await cdp.evaluate(`return !!document.querySelector('.z-30');`);
  await mouse(cdp, "mouseReleased", to.x, to.y, 0);
  await sleep(1500);
  return engaged ? "engaged" : "no drag state";
}

export default async function (cdp) {
  const out = { verdict: "FAIL", notes: [] };

  await cdp.send("Page.reload", { ignoreCache: true });
  await cdp.waitFor("document.querySelector('[data-skin]') !== null", { timeoutMs: 40000 });
  await cdp.evaluate(`
    [...document.querySelectorAll('.skin-nav')].find((b) => b.textContent.includes('项目'))?.click();
    await new Promise((s) => setTimeout(s, 1200));
  `);

  // Grouping would confine the float to one owner section, and it disables dragging.
  await poll(cdp, click("按拥有者分组"), { timeoutMs: 6000 });
  await sleep(600);

  // Seed a base order in which the fixture is LAST, so the floating slot it occupies
  // while running is provably different from the slot it owns in the manual order.
  // Without this the two coincide and "the index did not move" means nothing.
  out.seeded = await cdp.evaluate(`
    const parsed = JSON.parse(localStorage.getItem('devhub.wall.v1') || '{}');
    parsed.prefs = { ...(parsed.prefs ?? {}), filter: 'all', grouped: false,
      sort: 'name', density: 'compact' };
    parsed.repos = {
      ...(parsed.repos ?? {}),
      'github.com/joeseesun/opus-video-prompts': { ...(parsed.repos?.['github.com/joeseesun/opus-video-prompts'] ?? {}), index: 0 },
      'github.com/alice/tool': { ...(parsed.repos?.['github.com/alice/tool'] ?? {}), index: 1 },
      'github.com/testowner/zfixture': { ...(parsed.repos?.['github.com/testowner/zfixture'] ?? {}), index: 2 },
    };
    localStorage.setItem('devhub.wall.v1', JSON.stringify(parsed));
    return true;
  `);
  await cdp.send("Page.reload", { ignoreCache: true });
  await cdp.waitFor("document.querySelector('[data-skin]') !== null", { timeoutMs: 40000 });
  await cdp.evaluate(`
    [...document.querySelectorAll('.skin-nav')].find((b) => b.textContent.includes('项目'))?.click();
    await new Promise((s) => setTimeout(s, 1200));
  `);
  if (await cdp.evaluate(`
    return JSON.parse(localStorage.getItem('devhub.wall.v1')||'{}').prefs?.grouped === true;
  `)) {
    await cdp.evaluate(`
      [...document.querySelectorAll('button')].find((x) =>
        x.textContent.includes('按拥有者分组'))?.click();
    `);
    await sleep(700);
  }

  out.beforeRun = {
    position: await cdp.evaluate(positionExpr),
    index: await cdp.evaluate(storedIndexExpr),
    order: await cdp.evaluate(orderExpr),
  };
  if (out.beforeRun.position < 0) {
    out.notes.push("fixture 不在墙上，后面的断言都无意义");
    out.verdict = "SKIP";
    return out;
  }

  // Start it: tile → candidate → launch.
  await cdp.evaluate(`
    [...document.querySelectorAll('.skin-card')].find((b) =>
      (b.getAttribute('title') ?? '').includes(${JSON.stringify(FIXTURE)}))?.click();
  `);
  out.panelOpened = !!(await cdp.waitFor("!!document.querySelector('.fixed.inset-0')", {
    timeoutMs: 8000,
  }));
  out.candidatePicked = await poll(cdp, click("npm run dev"), { timeoutMs: 25000 });
  await sleep(600);
  out.launched =
    (await poll(cdp, click("一键启动"), { timeoutMs: 4000 })) ||
    (await poll(cdp, click("确认并启动"), { timeoutMs: 8000 }));
  out.running = await poll(cdp, `return document.body.innerText.includes('运行中 1');`, {
    timeoutMs: 25000,
  });
  await sleep(900);

  out.whileRunning = {
    position: await cdp.evaluate(positionExpr),
    firstIsRunning: await cdp.evaluate(`
      const b = [...document.querySelectorAll('.skin-card')].find((x) =>
        (x.getAttribute('title') ?? '').includes(${JSON.stringify(FIXTURE)}));
      return /运行中/.test(b?.textContent ?? '');
    `),
  };

  // Close the launch panel first: it is a modal over the wall, and a press on a card
  // coordinate hits the panel instead, so the drag would never arm.
  out.panelClosed = await cdp.evaluate(`
    const dlg = [...document.querySelectorAll('.fixed.inset-0')].pop();
    const close = dlg && [...dlg.querySelectorAll('button')].find((b) =>
      b.querySelector('svg') && b.textContent.trim() === '');
    close?.click();
    await new Promise((s) => setTimeout(s, 600));
    return !document.querySelector('.fixed.inset-0');
  `);

  // Drag a different card onto the floating one. Card 0 is the fixture while it runs,
  // so pick the last of the first four that is not the fixture.
  // Drag the first NON-running card onto the second one: the drop never targets the
  // floating card's slot, so nothing about the running card's own position was asked
  // for. Writing the floated sequence here is exactly what used to happen.
  const pair = await cdp.evaluate(`
    const cards = [...document.querySelectorAll('.skin-card')];
    const isFixture = (b) => (b.getAttribute('title') ?? '').includes(${JSON.stringify(FIXTURE)});
    const visible = cards
      .map((b, i) => ({ i, b, r: b.getBoundingClientRect() }))
      .filter((e) => e.r.top >= 0 && e.r.bottom <= innerHeight && !isFixture(e.b))
      .map((e) => e.i);
    return visible.length >= 2 ? { from: visible[visible.length - 1], to: visible[0] } : null;
  `);
  out.dragged = pair ? await dragCard(cdp, pair.from, pair.to) : "no pair";
  out.dragPair = pair;

  out.afterDrag = {
    index: await cdp.evaluate(storedIndexExpr),
    position: await cdp.evaluate(positionExpr),
  };

  // Stop through the status strip's 运行中 popover - the same control item 9 added.
  //
  // Targeted by its registry id, not by its text: the 项目页 toolbar has a filter chip
  // whose label is `运行中 1` too, and a text search hits the chip first. Clicking the
  // chip filters the wall down to running projects, which empties it the moment the
  // process stops - and every scenario after this one then finds no cards at all.
  out.stripOpened = await poll(
    cdp,
    `
    const b = document.querySelector('[data-reg-id="status-seg-active"]');
    if (!b) return false;
    b.click();
    return true;
  `,
    { timeoutMs: 8000 },
  );
  out.stopClicked = await poll(cdp, click("停止"), { timeoutMs: 8000 });
  out.stopped = await poll(
    cdp,
    `return !document.body.innerText.includes('运行中 1');`,
    { timeoutMs: 25000 },
  );
  await sleep(1200);

  out.afterStop = {
    position: await cdp.evaluate(positionExpr),
    index: await cdp.evaluate(storedIndexExpr),
    order: await cdp.evaluate(orderExpr),
  };

  const indexUntouched = out.afterDrag.index === out.beforeRun.index;
  const backWhereItStarted = out.afterStop.position === out.beforeRun.position;
  // Guard for the scenario itself: a drag that never engaged leaves `index` untouched
  // for the wrong reason, and the assertion below would pass while proving nothing.
  const dragEngaged = out.dragged === "engaged";
  // Guard for the scenario itself: a stray click on the 运行中 *filter chip* empties
  // the wall and poisons every later scenario, which is how one bad selector here once
  // looked like eight broken features.
  out.filterStill = await cdp.evaluate(`
    return JSON.parse(localStorage.getItem('devhub.wall.v1') || '{}').prefs?.filter ?? null;
  `);
  out.verdict =
    out.running && dragEngaged && indexUntouched && backWhereItStarted && out.stopped &&
    out.filterStill === "all"
      ? "PASS"
      : "FAIL";
  if (!dragEngaged) out.notes.push("指针拖拽没有进入拖拽态，索引断言在此条件下不成立");
  if (!indexUntouched) {
    out.notes.push(
      `拖动把浮起位置写进了索引：${out.beforeRun.index} → ${out.afterDrag.index}`,
    );
  }
  if (indexUntouched && !backWhereItStarted) {
    out.notes.push(
      `索引没变但位置没回去（${out.beforeRun.position} → ${out.afterStop.position}），说明排序档本身被拖动改了`,
    );
  }
  out.consoleErrors = cdp.consoleErrors;
  return out;
}
