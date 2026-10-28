/**
 * The single native-context-menu rule.
 *
 * WebView2's own right-click menu offers 刷新 / 查看源代码 / 检查 - the first two
 * lose state on a desktop app that has no page to reload, and 检查 opens DevTools
 * against a production build. The app ships its own context menus
 * (`components/ContextMenu.tsx`, RepoTile's 操作菜单), so the native one is noise.
 *
 * Editable fields stay exempt: 剪切/复制/粘贴 inside a text field is a different
 * menu from the page one and is genuinely wanted - the 深度审计报告 complaint was
 * about the *page* menu appearing over inputs, not about inputs having a menu.
 *
 * Installed in the **capture** phase so a component's own `onContextMenu` (which
 * calls `preventDefault` and opens a custom menu) still wins: this listener only
 * decides whether the *browser* gets to answer, and `preventDefault` never stops
 * propagation, so the two coexist.
 */

/** Kept in sync with the boot guard in `index.html`, which cannot import this file. */
const EDITABLE_SELECTOR =
  "input, textarea, [contenteditable='true'], [contenteditable=''], [contenteditable='plaintext-only']";

/**
 * The pre-React guard `index.html` installs so the boot surface is covered before
 * this module is even parsed. Its removal is handled here rather than there:
 * `index.html` hands this key a single `unregister` callback, so exactly one place
 * owns the rule.
 */
declare global {
  interface Window {
    __devhubContextMenuGuard?: () => void;
  }
}

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el?.closest?.(EDITABLE_SELECTOR);
}

function suppressNativeMenu(e: MouseEvent) {
  if (!isEditable(e.target)) e.preventDefault();
}

/**
 * Installs the rule. Idempotent, and called once from `main.tsx`.
 *
 * The boot guard is retired on the way in, so the selector lives in this file only.
 * Until now the two copies had to agree by comment alone - and because a capture
 * listener on `window` runs before one on `document`, the React-side copy would
 * have lost any future disagreement.
 */
export function installContextMenuGuard(): void {
  window.removeEventListener("contextmenu", suppressNativeMenu, true);
  window.addEventListener("contextmenu", suppressNativeMenu, true);
  window.__devhubContextMenuGuard?.();
  delete window.__devhubContextMenuGuard;
}
