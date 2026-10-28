/**
 * Project wall + landing path (items 4 and 7).
 *
 * Item 4, reported as: "下载仓库之后，在项目中打开对应项目之后，显示未找到仓库".
 *   Root cause found in the source: `RepoTile` handed the backend `owner/repo`
 *   (host dropped) while every command resolves repositories by `host/owner/repo`,
 *   so opening any downloaded project failed. This scenario clicks the tile like a
 *   user would and asserts the dialog resolves.
 *
 * Item 7: the landing path must be `<root>/<repo>_<owner>`. The composer previews
 *   the real target path before any network call, which is what is checked here -
 *   the actual on-disk result is checked separately by the download scenario.
 *
 * The fixture root holds both layouts on purpose: the flat one written by the new
 * code, and a legacy `code/<host>/<owner>/<repo>` one written by 0.2.0. Both must
 * still be listed and openable, because repositories already downloaded must not
 * break when the layout changes.
 */

export default async function (cdp) {
  const out = {};

  await cdp.evaluate(`
    const nav = [...document.querySelectorAll('.skin-nav')].find((b) => b.textContent.includes('项目'));
    if (nav) nav.click();
    await new Promise((r) => setTimeout(r, 400));
  `);

  out.tiles = await cdp.evaluate(`
    return [...document.querySelectorAll('.skin-card')].map((b) => ({
      title: b.getAttribute('title'),
      text: b.textContent.replace(/\\s+/g, ' ').trim(),
    }));
  `);
  out.tileCount = out.tiles.length;
  out.hasFlatRepo = out.tiles.some((t) => (t.title ?? "").includes("github.com/joeseesun/opus-video-prompts"));
  out.hasLegacyRepo = out.tiles.some((t) => (t.title ?? "").includes("github.com/alice/tool"));

  // --- item 4: open the flat (new-layout) repository ------------------------
  const openDialog = async (match) => {
    const clicked = await cdp.evaluate(`
      const tile = [...document.querySelectorAll('.skin-card')].find((b) =>
        (b.getAttribute('title') ?? '').includes(${JSON.stringify(match)}));
      if (!tile) return false;
      tile.click();
      await new Promise((r) => setTimeout(r, 1500));
      return true;
    `);
    if (!clicked) return { clicked: false };
    const state = await cdp.evaluate(`
      const dialog = document.querySelector('.fixed.inset-0');
      const text = dialog ? dialog.textContent.replace(/\\s+/g, ' ').trim() : null;
      const notFound = text ? text.includes('未找到仓库') : null;
      return {
        dialogOpen: !!dialog,
        notFound,
        heading: dialog ? (dialog.querySelector('h2')?.textContent ?? null) : null,
        hasPath: text ? /[A-Za-z]:\\\\/.test(text) : null,
        excerpt: text ? text.slice(0, 260) : null,
      };
    `);
    // Close it again (backdrop click), so the next step sees a clean view.
    await cdp.evaluate(`
      const backdrop = document.querySelector('.fixed.inset-0');
      if (backdrop) backdrop.click();
      await new Promise((r) => setTimeout(r, 400));
    `);
    return { clicked: true, ...state };
  };

  out.flatRepoDialog = await openDialog("github.com/joeseesun/opus-video-prompts");
  out.legacyRepoDialog = await openDialog("github.com/alice/tool");

  // --- item 7: previewed landing path --------------------------------------
  await cdp.evaluate(`
    const nav = [...document.querySelectorAll('.skin-nav')].find((b) => b.textContent.includes('添加'));
    if (nav) nav.click();
    await new Promise((r) => setTimeout(r, 400));
  `);

  out.preview = await cdp.evaluate(`
    const input = [...document.querySelectorAll('input')].find((i) =>
      (i.placeholder ?? '').includes('owner/repo'));
    if (!input) return { error: 'composer input not found' };
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'joeseesun/opus-video-prompts2');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 900));
    const text = document.body.innerText.replace(/\\s+/g, ' ');
    const m = text.match(/落位\\s*(\\S+)/);
    return { shown: m ? m[1] : null, hasPreviewBlock: /slug/.test(text) };
  `);

  out.landingIsFlat = (out.preview.shown ?? "").endsWith("opus-video-prompts2_joeseesun");
  out.landingHasNoCodeDir = !(out.preview.shown ?? "").includes("code\\github.com");
  out.verdict =
    out.hasFlatRepo &&
    out.hasLegacyRepo &&
    out.flatRepoDialog.dialogOpen === true &&
    out.flatRepoDialog.notFound === false &&
    out.legacyRepoDialog.dialogOpen === true &&
    out.legacyRepoDialog.notFound === false &&
    out.landingIsFlat
      ? "PASS"
      : "FAIL";

  return out;
}
