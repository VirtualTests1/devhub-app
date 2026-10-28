/**
 * Watch the boot surface across a real reload.
 *
 * Item 7 of the brief is about what the window shows while the app starts. The
 * only honest way to check it is to reload and sample the document: the panel
 * must be there before React mounts, its phase text must advance, and it must
 * dissolve after the first painted frame - not before it.
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function (cdp) {
  await cdp.send("Page.reload", { ignoreCache: true });

  const samples = [];
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    let s;
    try {
      s = await cdp.evaluate(`
        const boot = document.getElementById('boot');
        const root = document.getElementById('root');
        const bar = document.querySelector("#boot .track > i");
        return {
          t: Math.round(performance.now()),
          boot: boot ? (boot.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 70) : null,
          leaving: boot ? (boot.dataset.leaving ?? null) : null,
          barVisible: !!bar && getComputedStyle(bar).display !== 'none',
          barAnim: bar ? getComputedStyle(bar).animationName : null,
          rootKids: root ? root.childElementCount : -1,
          painted: root ? Math.round(root.getBoundingClientRect().height) : -1,
        };
      `);
    } catch {
      s = null; // context replaced by the reload
    }
    if (s) {
      const prev = samples[samples.length - 1];
      if (!prev || prev.boot !== s.boot || prev.rootKids !== s.rootKids || prev.leaving !== s.leaving) {
        samples.push(s);
      }
      if (!s.boot && s.rootKids > 0) break;
    }
    await sleep(60);
  }

  return { samples, consoleErrors: cdp.consoleErrors };
}
