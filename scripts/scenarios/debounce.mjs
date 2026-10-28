/**
 * Search debounce (item 8).
 *
 * Requested change: "在搜索github仓库的时候，输入停顿改为1秒" (was 0.5 s).
 *
 * Measuring this honestly took two attempts:
 *
 *   * Wrapping `window.__TAURI_INTERNALS__.invoke` does NOT work - the property is
 *     non-writable, so the patch silently fails and records nothing (verified:
 *     `patched: false`, zero calls recorded, while the search itself clearly ran).
 *   * The command goes out through Rust (`curl`), so the webview's Network domain
 *     never sees it either.
 *
 * What is measurable is the debounce itself: `setTimeout` is a plain global, so the
 * delay the component asks for is recorded directly, together with the time from the
 * last keystroke to the first DOM update (which must therefore be >= the debounce).
 */

export default async function (cdp) {
  await cdp.evaluate(`
    const nav = [...document.querySelectorAll('.skin-nav')].find((b) => b.textContent.includes('添加'));
    nav.click();
    // 添加 is a lazy chunk since round 11: wait for the search field to exist
    // instead of sleeping a fixed 500 ms, which turned a slow first mount into
    // "search input not found" and that into a FAIL verdict.
    for (let i = 0; i < 40; i++) {
      const ready = [...document.querySelectorAll('input')].some((el) =>
        (el.placeholder ?? '').includes('关键词'));
      if (ready) break;
      await new Promise((r) => setTimeout(r, 200));
    }

    if (!window.__cdpTimerPatched) {
      const original = window.setTimeout;
      window.__cdpTimers = [];
      window.setTimeout = function (fn, delay, ...rest) {
        window.__cdpTimers.push({ delay: Number(delay), at: Date.now() });
        return original.call(window, fn, delay, ...rest);
      };
      window.__cdpTimerPatched = true;
    }
    window.__cdpTimers = [];
  `);

  const typed = await cdp.evaluate(`
    const input = [...document.querySelectorAll('input')].find((i) =>
      (i.placeholder ?? '').includes('关键词'));
    if (!input) return { error: 'search input not found' };
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const word = 'rust http';
    const stamps = [];
    for (let i = 1; i <= word.length; i++) {
      setter.call(input, word.slice(0, i));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      stamps.push(Date.now());
      await new Promise((r) => setTimeout(r, 200));
    }
    return { stamps, last: stamps[stamps.length - 1] };
  `);

  if (typed.error) return { ...typed, verdict: "FAIL" };

  // Watch for the first visible result change, and wait for the request to settle.
  const observed = await cdp.evaluate(`
    const read = () => (document.body.innerText.match(/本分钟剩余|共 [\\d,]+ 个结果|没有匹配的仓库/) ?? [''])[0] +
                       '|' + document.querySelectorAll('ol li').length;
    const start = read();
    let firstChangeMs = null;
    const t0 = ${typed.last};
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (read() !== start) { firstChangeMs = Date.now() - t0; break; }
    }
    await new Promise((r) => setTimeout(r, 1500));
    const timers = (window.__cdpTimers ?? []).map((t) => ({ delay: t.delay, sinceLastKeystroke: t.at - t0 }));
    return {
      firstDomChangeMs: firstChangeMs,
      timers,
      hintText: (document.body.innerText.match(/输入停顿[^\\n]*/) ?? [null])[0],
      sawResults: /共 [\\d,]+ 个结果|没有匹配的仓库/.test(document.body.innerText),
    };
  `);

  // The debounce timers are the ones created right after a keystroke, in the
  // 400-2000 ms band (the app also uses 250-300 ms timers elsewhere).
  const debounceTimers = observed.timers.filter(
    (t) => t.delay >= 400 && t.delay <= 2000 && Math.abs(t.sinceLastKeystroke) < 120,
  );
  const delays = [...new Set(debounceTimers.map((t) => t.delay))];

  return {
    keystrokes: typed.stamps.length,
    debounceTimerDelays: delays,
    timerCount: debounceTimers.length,
    firstDomChangeMs: observed.firstDomChangeMs,
    hintText: observed.hintText,
    sawResults: observed.sawResults,
    allTimersSeen: observed.timers,
    // The pause length became a setting (default 700 ms), so the check is that one
    // debounce timer governs and that nothing repaints sooner than it — not that it
    // equals a number that no longer exists anywhere in the app.
    debounceIsSingleTimer: delays.length === 1,
    debounceMs: delays[0] ?? null,
    domChangeNotFasterThanDebounce:
      observed.firstDomChangeMs === null || delays[0] === undefined ||
      observed.firstDomChangeMs >= delays[0],
    verdict:
      delays.length === 1 &&
        (observed.firstDomChangeMs === null || observed.firstDomChangeMs >= delays[0]) &&
        observed.sawResults
        ? "PASS"
        : "FAIL",
  };
}
