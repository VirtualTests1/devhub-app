/**
 * r21 O4-2: the 快捷键 panel (r20-N1-3) on a real WebView2.
 *
 * Nothing under scripts/scenarios/ ever opened this surface (`grep` for
 * 快捷键 / ShortcutHelp / F1 across the scenario folder came back empty when this
 * was written), so the panel's two jobs — show what a key does, let a person
 * rebind it — were pinned by unit tests only. This drives the shipped UI: F1
 * opens it, the row list carries the nine shipped chords, one row is rebound
 * through the capture flow with a real keydown, Escape cancels a capture
 * without changing the binding, 全部恢复默认 puts the defaults back, and the
 * dialog closes again.
 *
 * The pre-run `localStorage` binding value is restored in the `finally`, so a
 * machine with hand-made overrides keeps them (the same restoration discipline
 * r16-language uses). Nothing else is written: the only storage key this panel
 * touches is `devhub.shortcuts.v1`, and it is back to its original value before
 * the verdict is printed.
 */

const HELP_ID = '[data-reg-id="shell-shortcut-help"]';

export default async function (cdp) {
  const out = {};
  let passed = false;
  const beforeRaw = await cdp.evaluate(`return localStorage.getItem('devhub.shortcuts.v1');`);

  /** One snapshot of the panel: structure, the nine rows, and their chords. */
  const snap = () =>
    cdp.evaluate(`
      const d = document.querySelector('${HELP_ID}');
      if (!d) return null;
      const rows = [...d.querySelectorAll('li')].map((li) => {
        const chord = li.querySelector('[data-capturing]');
        const btn = li.querySelector('button');
        return {
          label: (btn?.textContent ?? '').trim(),
          chord: (chord?.textContent ?? '').trim(),
          capturing: chord?.getAttribute('data-capturing') ?? null,
          customized: li.textContent.includes('已自定义'),
        };
      });
      return {
        role: d.getAttribute('role'),
        ariaModal: d.getAttribute('aria-modal'),
        titled: (d.textContent ?? '').includes('快捷键'),
        subtitle: (d.textContent ?? '').includes('点击一行后按下新组合即可改绑'),
        groups: ['导航', '浮层', '帮助'].filter((g) =>
          [...d.querySelectorAll('h3')].some((h) => h.textContent.trim() === g),
        ),
        rowCount: rows.length,
        rebindButtons: d.querySelectorAll('button[aria-label="按下新组合"]').length,
        resetButtons: [...d.querySelectorAll('button')].filter((b) => b.textContent.trim() === '恢复默认').length,
        resetAll: [...d.querySelectorAll('button')].some((b) => b.textContent.trim() === '全部恢复默认'),
        rows,
      };
    `);

  const press = (init) =>
    cdp.evaluate(`
      window.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({ bubbles: true, cancelable: true, ...init })}));
    `);

  const clickRowRebind = (label) =>
    cdp.evaluate(`
      const d = document.querySelector('${HELP_ID}');
      const btn = [...(d?.querySelectorAll('button') ?? [])].find(
        (b) => b.getAttribute('aria-label') === '按下新组合' && b.textContent.includes(${JSON.stringify(label)}),
      );
      if (!btn) return 'no rebind button';
      btn.click();
      return 'clicked';
    `);

  try {
    out.before = await snap();

    // F1 — the shell's own capture-phase window listener decides, not a test hook.
    await press({ key: 'F1', code: 'F1' });
    try {
      await cdp.waitFor(`document.querySelector('${HELP_ID}') !== null`, {
        timeoutMs: 5000,
        label: 'help dialog opens on F1',
      });
      out.opened = true;
    } catch {
      out.opened = false;
    }
    out.open = await snap();

    // Rebind flow: click the 打开命令面板 row, then press Alt+Shift+P for real.
    out.captureClick = await clickRowRebind('打开命令面板');
    try {
      await cdp.waitFor(
        `(() => { const d = document.querySelector('${HELP_ID}');
           return !!d && [...d.querySelectorAll('[data-capturing]')].some(
             (x) => x.getAttribute('data-capturing') === 'true' && x.textContent.includes('等待按键')); })()`,
        { timeoutMs: 4000, label: 'capture state shows 等待按键' },
      );
      out.capturing = true;
    } catch {
      out.capturing = false;
    }

    await press({ key: 'P', code: 'KeyP', altKey: true, shiftKey: true });
    try {
      await cdp.waitFor(
        `(() => { const d = document.querySelector('${HELP_ID}');
           return !!d && [...d.querySelectorAll('[data-capturing]')].some((x) => x.textContent.trim() === 'Alt+Shift+P'); })()`,
        { timeoutMs: 4000, label: 'chord cell shows Alt+Shift+P' },
      );
      out.rebound = true;
    } catch {
      out.rebound = false;
    }
    out.stored = await cdp.evaluate(`
      try { return JSON.parse(localStorage.getItem('devhub.shortcuts.v1') || '{}'); } catch { return null; }
    `);
    out.afterRebind = await snap();

    // Escape cancels a capture: the second row must keep its shipped chord.
    out.escapeClick = await clickRowRebind('快捷键面板');
    try {
      await cdp.waitFor(
        `(() => { const d = document.querySelector('${HELP_ID}');
           return !!d && [...d.querySelectorAll('[data-capturing]')].some((x) => x.getAttribute('data-capturing') === 'true'); })()`,
        { timeoutMs: 4000, label: 'second capture starts' },
      );
      await press({ key: 'Escape', code: 'Escape' });
      await cdp.waitFor(
        `(() => { const d = document.querySelector('${HELP_ID}');
           if (!d) return false;
           const rows = [...d.querySelectorAll('li')].map((li) => ({
             label: (li.querySelector('button')?.textContent ?? '').trim(),
             chord: (li.querySelector('[data-capturing]')?.textContent ?? '').trim(),
             capturing: li.querySelector('[data-capturing]')?.getAttribute('data-capturing'),
           }));
           const help = rows.find((r) => r.label === '快捷键面板');
           return !!help && help.chord === 'F1' && rows.every((r) => r.capturing !== 'true'); })()`,
        { timeoutMs: 4000, label: 'Escape cancels the capture' },
      );
      out.escapeCancelled = true;
    } catch {
      out.escapeCancelled = false;
    }
    out.afterEscape = await snap();

    // 全部恢复默认: palette back to Ctrl+K, no 已自定义 left, storage cleared.
    out.resetClick = await cdp.evaluate(`
      const d = document.querySelector('${HELP_ID}');
      const b = [...(d?.querySelectorAll('button') ?? [])].find((x) => x.textContent.trim() === '全部恢复默认');
      if (!b) return 'no reset-all button';
      b.click();
      return 'clicked';
    `);
    try {
      await cdp.waitFor(
        `(() => { const d = document.querySelector('${HELP_ID}');
           if (!d) return false;
           const stored = JSON.parse(localStorage.getItem('devhub.shortcuts.v1') || '{}');
           const palette = [...d.querySelectorAll('li')].find(
             (li) => (li.querySelector('button')?.textContent ?? '').trim() === '打开命令面板');
           const chord = palette?.querySelector('[data-capturing]')?.textContent.trim();
           return Object.keys(stored).length === 0 && chord === 'Ctrl+K' &&
             !d.textContent.includes('已自定义'); })()`,
        { timeoutMs: 4000, label: 'reset-all restores the shipped chords' },
      );
      out.resetOk = true;
    } catch {
      out.resetOk = false;
    }
    out.afterReset = await snap();

    // Close (the dialog's own 关闭 button → useSelfClosing exit → unmount).
    out.closeClick = await cdp.evaluate(`
      const d = document.querySelector('${HELP_ID}');
      const b = d?.querySelector('button[aria-label="关闭"]');
      if (!b) return 'no close button';
      b.click();
      return 'clicked';
    `);
    try {
      await cdp.waitFor(`document.querySelector('${HELP_ID}') === null`, {
        timeoutMs: 5000,
        label: 'help dialog closes',
      });
      out.closed = true;
    } catch {
      out.closed = false;
    }
    out.afterClose = await cdp.evaluate(`
      const d = document.querySelector('${HELP_ID}');
      const view = document.querySelector('[data-reg-id="view-panel"]');
      return {
        present: !!d,
        inertCount: document.querySelectorAll('[inert]').length,
        viewBehindInert: view ? view.closest('[inert]') !== null : null,
      };
    `);

    const o = out.open;
    out.ok = {
      opened: out.opened === true,
      structure:
        !!o &&
        o.role === "dialog" &&
        o.ariaModal === "true" &&
        o.titled &&
        o.subtitle &&
        o.groups.length === 3 &&
        o.rowCount === 9 &&
        o.rebindButtons === 9 &&
        o.resetButtons === 9 &&
        o.resetAll &&
        o.rows.some((r) => r.label === "打开命令面板" && r.chord === "Ctrl+K") &&
        o.rows.some((r) => r.label === "快捷键面板" && r.chord === "F1"),
      capturing: out.capturing === true && out.captureClick === "clicked",
      rebound: out.rebound === true,
      stored: !!out.stored && out.stored.palette === "Alt+Shift+P",
      customizedShown:
        !!out.afterRebind && out.afterRebind.rows.some((r) => r.label === "打开命令面板" && r.customized),
      escapeCancelled: out.escapeCancelled === true && out.escapeClick === "clicked",
      reset: out.resetOk === true && out.resetClick === "clicked",
      closed: out.closed === true && out.closeClick === "clicked" && out.afterClose.present === false,
      // The panel must not leave the shell inert after it unmounts.
      noInertLeft: out.afterClose.inertCount === 0 && out.afterClose.viewBehindInert === false,
    };
    passed = Object.values(out.ok).every(Boolean);
  } finally {
    // Put the binding storage back exactly as it was found.
    try {
      await cdp.evaluate(
        beforeRaw === null
          ? `localStorage.removeItem('devhub.shortcuts.v1'); return true;`
          : `localStorage.setItem('devhub.shortcuts.v1', ${JSON.stringify(beforeRaw)}); return true;`,
      );
    } catch {
      /* restoring is best-effort; the verdict already carries the evidence */
    }
    out.beforeRaw = beforeRaw;
  }

  out.consoleErrors = cdp.consoleErrors;
  out.verdict = passed ? "PASS" : "FAIL";
  return out;
}
