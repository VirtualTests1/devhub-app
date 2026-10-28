/**
 * Item 3, first half: drag a card to a new position and make it stick.
 *
 * The pointer path is issued through the CDP Input domain because dnd-kit's
 * PointerSensor only arms after real pointer events cross its 6px activation
 * distance - a synthetic MouseEvent never starts a drag.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const order = `
  return [...document.querySelectorAll('.skin-card')].map((b) =>
    (b.getAttribute('title') ?? '').split('\\n')[0].replace(/^克隆地址：/, ''));
`;

const mouse = (cdp, type, x, y, buttons) =>
  cdp.send("Input.dispatchMouseEvent", {
    type,
    x,
    y,
    button: "left",
    buttons,
    clickCount: 1,
  });

export default async function (cdp) {
  const out = {};

  await cdp.send("Page.reload", { ignoreCache: true });
  await cdp.waitFor("document.querySelector('[data-skin]') !== null", { timeoutMs: 30000 });
  await cdp.evaluate(`
    [...document.querySelectorAll('.skin-nav')].find((b) => b.textContent.includes('项目'))?.click();
    await new Promise((s) => setTimeout(s, 1200));
  `);

  out.before = await cdp.evaluate(order);

  // Dragging is switched off while 按拥有者分组 is on, and the view says so in
  // plain text. Both halves are checked: the notice, and the toggle that clears it.
  out.groupNotice = await cdp.evaluate(`
    return [...document.querySelectorAll('p')].map((p) => p.textContent.trim())
      .find((t) => t.startsWith('分组视图下不能拖动排序')) ?? null;
  `);
  out.ungrouped = await cdp.evaluate(`
    const b = [...document.querySelectorAll('button')].find((x) =>
      x.textContent.includes('按拥有者分组'));
    if (!b) return false;
    b.click();
    return true;
  `);
  await sleep(900);
  out.noticeGone = await cdp.evaluate(`
    return ![...document.querySelectorAll('p')].some((p) =>
      p.textContent.trim().startsWith('分组视图下不能拖动排序'));
  `);

  const boxes = await cdp.evaluate(`
    return [...document.querySelectorAll('.skin-card')].slice(0, 4).map((b) => {
      const r = b.getBoundingClientRect();
      // Press in the cover band: the tile is one big button, and a press on the text
      // rows at its vertical middle never arms the PointerSensor (measured both ways).
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 40) };
    });
  `);
  out.boxes = boxes;

  // The last card rather than a hard-coded fourth: the fixture root can hold three
  // repositories, and `boxes[3]` was undefined then - the crash read as a broken drag.
  const from = boxes[boxes.length - 1];
  const to = boxes[0];
  await mouse(cdp, "mousePressed", from.x, from.y, 1);
  const steps = 20;
  for (let i = 1; i <= steps; i += 1) {
    const x = Math.round(from.x + ((to.x - from.x) * i) / steps);
    const y = Math.round(from.y + ((to.y - from.y) * i) / steps);
    await mouse(cdp, "mouseMoved", x, y, 1);
    await sleep(60);
  }
  await sleep(200);
  out.midDrag = await cdp.evaluate(`
    return { draggingClass: !!document.querySelector('.z-30'),
      transforms: [...document.querySelectorAll('.skin-card')].slice(0, 4).map((b) => b.style.transform) };
  `);
  await mouse(cdp, "mouseReleased", to.x, to.y, 0);
  await sleep(1200);

  out.after = await cdp.evaluate(order);
  out.stored = await cdp.evaluate(`
    const parsed = JSON.parse(localStorage.getItem('devhub.wall.v1') || '{}');
    const short = (k) => k.split('/').slice(-1)[0];
    return {
      order: Object.entries(parsed.repos ?? {})
        .filter(([, v]) => v.index !== undefined)
        .sort((a, b) => a[1].index - b[1].index)
        .map(([k, v]) => v.index + ':' + short(k)),
      alias: parsed.repos?.['github.com/testowner/zfixture']?.alias ?? null,
    };
  `);
  out.dragging = await cdp.evaluate(
    `return [...document.querySelectorAll('.skin-card')].some((b) => b.style.transform !== '' || b.style.transition !== '');`,
  );

  out.consoleErrors = cdp.consoleErrors;
  return out;
}
