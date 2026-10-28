/** Smoke test for the CDP harness itself. */
export default async function (cdp) {
  const info = await cdp.evaluate(`
    return {
      href: location.href,
      title: document.title,
      rootChildren: document.getElementById('root')?.childElementCount ?? -1,
      skin: document.querySelector('[data-skin]')?.getAttribute('data-skin') ?? null,
      tiles: document.querySelectorAll('.skin-card').length,
      bodyStart: document.body.innerText.slice(0, 120),
    };
  `);
  return { info, target: cdp.target };
}
