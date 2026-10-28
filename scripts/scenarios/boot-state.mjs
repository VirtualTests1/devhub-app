/**
 * What the webview actually holds.
 *
 * A dark, empty window has three distinct causes that look identical in a
 * screenshot: the page never loaded (WebView2 shows only the window background),
 * it loaded but the module graph failed (the boot panel stays up forever), and it
 * loaded and mounted but painted nothing (the boot panel is gone and `#root` is
 * empty or zero-sized). This reads the document and says which one it is.
 */
export default async function (cdp) {
  const state = await cdp.evaluate(`
    const root = document.getElementById('root');
    const boot = document.getElementById('boot');
    const rect = root ? root.getBoundingClientRect() : null;
    return {
      href: location.href,
      readyState: document.readyState,
      title: document.title,
      bootPresent: !!boot,
      bootLeaving: boot?.dataset?.leaving ?? null,
      bootPhase: window.__devhubBoot ? 'still running' : 'no boot object',
      rootChildren: root?.childElementCount ?? -1,
      rootHtmlLength: root?.innerHTML.length ?? -1,
      rootRect: rect ? { w: Math.round(rect.width), h: Math.round(rect.height) } : null,
      documentElements: document.querySelectorAll('*').length,
      viteClient: !!document.querySelector('script[src*="/@vite/client"]'),
      bodyText: document.body?.innerText.slice(0, 160) ?? null,
    };
  `);
  return { state, consoleErrors: cdp.consoleErrors };
}
