/**
 * r21 O4-2: the command palette's inert background (r20-O4-1/-3) on a real
 * WebView2.
 *
 * `applyModalInert` (src/lib/modal-inert.ts) promises that what an open modal
 * covers leaves the accessibility tree *and* stops being focusable, and that
 * the promise is revoked on close. The palette got that treatment in
 * r20-O4-3 (`CommandPalette.tsx`), but no scenario under scripts/scenarios/
 * opened the palette at all when this was written (`grep` for CommandPalette /
 * palette / Ctrl+K came back empty), so the inert behaviour was unit-tested
 * against structural objects only.
 *
 * This drives the real surface: Ctrl+K opens the palette from the shell's own
 * key map, every sibling of the scrim is asserted inert while it is open (with
 * the 项目墙 behind it unreachable), the keyboard path (ArrowDown moves
 * `aria-activedescendant`, typing narrows the list) runs on the real DOM, and
 * Escape closes it — after which the background must be exactly as reachable as
 * it was before.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PALETTE = '[data-reg-id="command-palette"]';

export default async function (cdp) {
  const out = {};
  let passed = false;

  /** Everything this scenario asserts, in one read. */
  const snap = () =>
    cdp.evaluate(`
      const p = document.querySelector('${PALETTE}');
      const view = document.querySelector('[data-reg-id="view-panel"]');
      const before = {
        inertOnPage: document.querySelectorAll('[inert]').length,
        viewBehindInert: view ? view.closest('[inert]') !== null : null,
        palettePresent: !!p,
      };
      if (!p) return before;
      const scrim = document.querySelector('[data-layer="scrim"]');
      const siblings =
        scrim && scrim.parentElement ? [...scrim.parentElement.children].filter((el) => el !== scrim) : [];
      const input = p.querySelector('input[role="combobox"]');
      const options = [...p.querySelectorAll('[role="option"]')];
      const active = options.findIndex((o) => o.getAttribute('data-active') === 'true');
      return {
        ...before,
        role: p.getAttribute('role'),
        ariaModal: p.getAttribute('aria-modal'),
        dataState: p.getAttribute('data-state'),
        scrimPresent: !!scrim,
        scrimInert: scrim ? !!scrim.inert : null,
        siblingCount: siblings.length,
        inertSiblings: siblings.filter((el) => el.inert === true && el.getAttribute('aria-hidden') === 'true').length,
        viewBehindInert: view ? view.closest('[inert]') !== null : null,
        focusIsInput: document.activeElement === input,
        inputLabel: input ? input.getAttribute('aria-label') : null,
        activedescendant: input ? input.getAttribute('aria-activedescendant') : null,
        optionCount: options.length,
        activeIndex: active,
        activeLabel: active >= 0 ? options[active].getAttribute('aria-label') : null,
        activeMatchesDescendant:
          active >= 0 && input ? input.getAttribute('aria-activedescendant') === options[active].id : false,
      };
    `);

  try {
    out.before = await snap();

    // Ctrl+K through the shell's key map (AppShell's capture-phase listener).
    await cdp.evaluate(`
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'k', code: 'KeyK', ctrlKey: true, bubbles: true, cancelable: true,
      }));
    `);
    try {
      await cdp.waitFor(`document.querySelector('${PALETTE}') !== null`, {
        timeoutMs: 5000,
        label: 'palette opens on Ctrl+K',
      });
      out.opened = true;
    } catch {
      out.opened = false;
    }
    await sleep(300); // focus effect + first ranked list
    out.open = await snap();

    // ArrowDown walks the list: the active row and aria-activedescendant move together.
    const beforeCount = out.open?.optionCount ?? 0;
    await cdp.evaluate(`
      const input = document.querySelector('${PALETTE}')?.querySelector('input[role="combobox"]');
      if (input) input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    `);
    try {
      await cdp.waitFor(
        `(() => { const p = document.querySelector('${PALETTE}'); if (!p) return false;
           const opts = [...p.querySelectorAll('[role="option"]')];
           const i = opts.findIndex((o) => o.getAttribute('data-active') === 'true');
           const input = p.querySelector('input[role="combobox"]');
           return i === 1 && input.getAttribute('aria-activedescendant') === opts[1]?.id; })()`,
        { timeoutMs: 4000, label: 'ArrowDown moves the active option' },
      );
      out.arrowDown = true;
    } catch {
      out.arrowDown = false;
    }
    out.afterArrow = await snap();

    // Typing narrows the list the way a user's typing does (native setter + input event).
    await cdp.evaluate(`
      const input = document.querySelector('${PALETTE}')?.querySelector('input[role="combobox"]');
      if (input) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, '刷新');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    `);
    try {
      await cdp.waitFor(
        `(() => { const p = document.querySelector('${PALETTE}'); if (!p) return false;
           const opts = [...p.querySelectorAll('[role="option"]')];
           if (opts.length === 0 || opts.length >= ${beforeCount}) return false;
           const input = p.querySelector('input[role="combobox"]');
           const i = opts.findIndex((o) => o.getAttribute('data-active') === 'true');
           return i === 0 && input.getAttribute('aria-activedescendant') === opts[0].id &&
             opts[0].getAttribute('aria-label').includes('刷新'); })()`,
        { timeoutMs: 4000, label: 'typing narrows the list' },
      );
      out.typed = true;
    } catch {
      out.typed = false;
    }
    out.afterType = await snap();

    // Escape closes the palette (its own document-level listener).
    await cdp.evaluate(`
      const input = document.querySelector('${PALETTE}')?.querySelector('input[role="combobox"]');
      if (input) input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
    `);
    try {
      await cdp.waitFor(`document.querySelector('${PALETTE}') === null`, {
        timeoutMs: 6000,
        label: 'palette closes on Escape',
      });
      out.closed = true;
    } catch {
      out.closed = false;
    }
    await sleep(200);
    out.afterClose = await snap();

    const open = out.open;
    out.ok = {
      opened: out.opened === true,
      structure:
        !!open &&
        open.role === "dialog" &&
        open.ariaModal === "true" &&
        open.dataState === "open" &&
        open.scrimPresent &&
        open.focusIsInput &&
        open.inputLabel === "全局搜索" &&
        open.optionCount > 0 &&
        open.activeIndex === 0 &&
        open.activeMatchesDescendant,
      // The whole promise of r20-O4-3: every sibling of the scrim is inert +
      // aria-hidden, the scrim itself is not, and the wall behind is unreachable.
      inertApplied:
        !!open &&
        open.scrimInert === false &&
        open.siblingCount >= 2 &&
        open.inertSiblings === open.siblingCount &&
        open.viewBehindInert === true &&
        out.before.viewBehindInert === false,
      keyboard: out.arrowDown === true && out.afterArrow.activeIndex === 1,
      typing: out.typed === true,
      closed:
        out.closed === true && out.afterClose.palettePresent === false,
      // …and revoked: back to the exact pre-open reachability.
      inertRevoked:
        out.afterClose.inertOnPage === out.before.inertOnPage &&
        out.afterClose.viewBehindInert === false,
    };
    passed = Object.values(out.ok).every(Boolean);
  } finally {
    // Nothing was written; the palette only reads lists. If a run dies mid-way
    // with the palette still open, close it so the next scenario starts clean.
    try {
      const stillOpen = await cdp.evaluate(
        `return document.querySelector('${PALETTE}') !== null;`,
      );
      if (stillOpen) {
        await cdp.evaluate(`
          const input = document.querySelector('${PALETTE}')?.querySelector('input[role="combobox"]');
          if (input) input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
        `);
        await sleep(600);
      }
    } catch {
      /* best-effort cleanup */
    }
  }

  out.consoleErrors = cdp.consoleErrors;
  out.verdict = passed ? "PASS" : "FAIL";
  return out;
}
