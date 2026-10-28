/**
 * Not a test: a barrier the runner calls between scenarios.
 *
 * Every scenario shares one app process and one fixture root, and some of them
 * create repositories (`local-download` clones into the container). Once an extra
 * directory exists, the tile index shifts by one for every later scenario that
 * asserts on position arithmetic — which looks exactly like a product bug (this
 * cost a false "S4 broke dragging" report once already).
 *
 * The runner deletes the download targets before each scenario, then runs this to
 * refresh the wall and wait until what is on screen matches what is on disk. It is
 * named `debug-*` so the scenario glob skips it during a normal run.
 */
export default async function (cdp) {
  return cdp.evaluate(`
    const nav = [...document.querySelectorAll('.skin-nav')].find((b) =>
      b.textContent.trim().startsWith('项目'));
    nav?.click();
    await new Promise((r) => setTimeout(r, 400));
    const btn = [...document.querySelectorAll('button')].find((b) =>
      (b.getAttribute('title') || '').includes('刷新') || b.textContent.includes('刷新'));
    btn?.click();
    let last = -1, stable = 0;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 300));
      const disk = await window.__TAURI_INTERNALS__.invoke('list_repositories');
      const dom = document.querySelectorAll('.repo-grid > *').length;
      if (dom > 0 && dom === disk.length) {
        if (dom === last && ++stable >= 2) return { tiles: dom, tries: i + 1, settled: true };
      } else {
        stable = 0;
      }
      last = dom;
    }
    const disk = await window.__TAURI_INTERNALS__.invoke('list_repositories');
    return { tiles: document.querySelectorAll('.repo-grid > *').length, disk: disk.length, settled: false };
  `);
}
