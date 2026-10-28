import { create } from "zustand";
import { toast } from "./toast";

/**
 * UI-only state.
 *
 * The shell is a small state machine: which view is showing, whether the
 * environment popover over the status strip is open, and — since 需求 3 — where the
 * user has been. Keeping it here (rather than threading props through
 * App → Shell → Sidebar) is why `zustand` is in the dependency list.
 *
 * Data loading stays in `App.tsx`: it is async, has error handling, and only one
 * component needs to own it.
 */
/**
 * The shell's views.
 *
 * Round 9 (需求 10) removed `appearance`: 外观 is a settings catalog page now,
 * not a destination of its own. The standalone route and its sidebar entry
 * went with it — a view nothing can reach is a view that cannot be tested.
 */
export type ViewId = "projects" | "add" | "settings" | "records" | "frequent";

/**
 * Visual direction under evaluation.
 *
 * `soft` is the consumer direction that was chosen. `crisp` and `bold` exist so
 * that direction can be tested against real, polarised alternatives instead of
 * being described in the abstract - the target style could not be named, and all
 * three named references had been rejected. Exposed in development builds only.
 */
export type SkinId = "soft" | "crisp" | "bold";

export const SKINS: { id: SkinId; label: string; note: string }[] = [
  { id: "soft", label: "柔和", note: "消费级：大圆角、柔和阴影、宽松网格" },
  { id: "crisp", label: "硬朗", note: "工具感：小圆角、以描边代替阴影、密集网格" },
  { id: "bold", label: "醒目", note: "高对比：加重阴影、加粗标题、大位移" },
];

/**
 * A place the user can go back to.
 *
 * A destination is a view plus that view's own context — the 项目 page's filter,
 * sort and grouping are part of *where you were*, not incidental state. Context is
 * captured when you leave and re-applied when you come back, which is what makes
 * 后退 feel like a browser rather than like a nav bar reset.
 *
 * The invariant every mutator keeps: `history[pointer]` names the view that is on
 * screen, and its `ctx` belongs to that view. Context keys collide across views
 * (`sort`, `filter`, `section`), so an entry that pairs one view's name with
 * another's context does not look broken — it silently re-arranges the page.
 *
 * Dialogs and popovers deliberately do NOT go in the stack: 后退 and 前进 both
 * close an open layer first (see [`UIState.closeTopLayer`]) and only then move,
 * because a stack entry for a modal is a promise the shell cannot keep after the
 * modal's own Esc handling.
 */
export type Destination = { view: ViewId; ctx?: Record<string, unknown> };

type ContextBridge = {
  get: () => Record<string, unknown>;
  apply: (ctx: Record<string, unknown>) => void;
};

/**
 * Views publish how to snapshot and restore themselves by mounting a bridge.
 *
 * The store cannot import a view (circular), and a view that never registers simply
 * keeps no context — so history works for all six views the day it lands and gets
 * richer as each one opts in.
 */
const bridges = new Map<ViewId, ContextBridge>();
let pending: { view: ViewId; ctx: Record<string, unknown> } | null = null;

export function registerViewContext(view: ViewId, bridge: ContextBridge): () => void {
  bridges.set(view, bridge);
  // A restore can arrive before the view is mounted (the shell swaps the view on the
  // same tick it applies the destination). Hand the snapshot over as soon as it gets here.
  if (pending && pending.view === view) {
    bridge.apply(pending.ctx);
    pending = null;
  }
  return () => {
    if (bridges.get(view) === bridge) bridges.delete(view);
  };
}

const snapshot = (view: ViewId): Record<string, unknown> | undefined =>
  bridges.get(view)?.get();

/**
 * The five view ids as **zh-CN literals** — the key list this store validates
 * stored ids against (`KNOWN_VIEWS`, `in VIEW_LABEL`), and the pre-wiring
 * wording `tests/i18n.test.ts` pins the dictionary's `view.*` entries to.
 *
 * r16-n2-2 rendered these through `viewTitle(t, id)` in every component instead
 * of reading this table, so a *live-getter* variant of this table (each value
 * resolving through the module-level `t` on access) was tried and removed. The
 * getters only benefit a reader that does **not** subscribe to the locale, and
 * every reader of a view name now takes `t` from `useI18n()` — the subscription
 * is what makes a language switch repaint, at which point `viewTitle(t, id)`
 * answers just as freshly. The one remaining consumer that never re-renders is
 * the unknown-view toast below, whose surrounding sentence is unwired Chinese;
 * a live getter would have put an English view name inside it, which is worse
 * than a consistently-Chinese unwired string.
 *
 * So: this table stays plain data, the dictionary (`lib/i18n.ts`) is the single
 * vocabulary, and the two agree byte for byte — `tests/i18n.test.ts` fails the
 * gate if they ever don't.
 */
export const VIEW_LABEL: Record<ViewId, string> = {
  projects: "项目",
  add: "添加",
  settings: "设置",
  records: "记录",
  frequent: "常用",
};

/**
 * Navigation persistence (round 11, D4-8).
 *
 * `wall.ts` / `customize.ts` persist their arrangements, but 视图与历史 never
 * did — every restart landed on 项目页 with an empty history, throwing away the
 * one piece of state that says *where you were*. Same local pattern as those
 * two stores: a versioned key, a defensive read, and writes from the mutators
 * themselves.
 *
 * `openSlug` deliberately stays out of the snapshot: a dialog that re-opens
 * itself on launch is not a restored view, it is the app clicking its own
 * buttons. Restored destinations carry view ids plus each view's own ctx; a ctx
 * naming state that no longer exists (a deleted repository) is ignored by the
 * view that reads it — the views re-validate their context through their
 * bridges, and the wall filter/sort values are re-checked in `wall.ts` on read.
 */
const NAV_KEY = "devhub.ui.nav.v1";

/** Same authority as the type: a stored id nothing renders must fall back. */
const KNOWN_VIEWS: string[] = Object.keys(VIEW_LABEL);

/** Where navigation lands when the name does not answer: the landing page. */
const DEFAULT_VIEW: ViewId = "projects";

type NavSnapshot = { view: ViewId; history: Destination[]; pointer: number };

function isViewId(v: unknown): v is ViewId {
  return typeof v === "string" && KNOWN_VIEWS.includes(v);
}

/**
 * `isViewId` applied at the door, not only to persisted history.
 *
 * `go` / `setView` are typed `ViewId`, but the 常用 page's pinned `view:` entries
 * arrive from imported or persisted JSON and arrive *asserted* — `openEntry` in
 * `FrequentView` writes `go(entry.id as ViewId)` because the store cannot know
 * which id names a live view. An id like `projects-v2` (round 9 deleted the
 * standalone `appearance` route, and any imported list can carry worse) used to
 * blank the main area: `App.tsx` renders one branch per known view with no
 * default, so nothing drew and nothing said why. The rule `readNav` already
 * keeps — "a stored id nothing renders must fall back" — now runs on every
 * navigation, once, where the history invariant lives, and reports the landing
 * instead of failing silently.
 */
function coerceView(view: ViewId): ViewId {
  if (isViewId(view)) return view;
  toast.error(`没有叫「${view}」的界面，已回到「${VIEW_LABEL[DEFAULT_VIEW]}」`);
  return DEFAULT_VIEW;
}

function readNav(): NavSnapshot {
  const fallback: NavSnapshot = {
    view: DEFAULT_VIEW,
    history: [{ view: DEFAULT_VIEW }],
    pointer: 0,
  };
  try {
    const raw = localStorage.getItem(NAV_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<NavSnapshot>;
    if (!Array.isArray(parsed.history)) return fallback;
    // 一个不再存在的视图 id（删掉的路由）或损坏的条目直接丢弃，而不是抛错——
    // 历史恢复失败不该让整个应用启动失败。
    const history = parsed.history
      .filter(
        (d): d is Destination =>
          !!d && typeof d === "object" && isViewId((d as Destination).view),
      )
      .map((d) =>
        d.ctx && typeof d.ctx === "object"
          ? { view: d.view, ctx: d.ctx as Record<string, unknown> }
          : { view: d.view },
      )
      .slice(-50);
    if (history.length === 0) return fallback;
    const pointer =
      Number.isInteger(parsed.pointer) && (parsed.pointer as number) >= 0
        ? Math.min(parsed.pointer as number, history.length - 1)
        : history.length - 1;
    const view = isViewId(parsed.view) ? parsed.view : (history[pointer]?.view ?? DEFAULT_VIEW);
    return { view, history, pointer };
  } catch {
    return fallback;
  }
}

function persistNav(nav: NavSnapshot) {
  try {
    localStorage.setItem(
      NAV_KEY,
      JSON.stringify({ view: nav.view, history: nav.history, pointer: nav.pointer }),
    );
  } catch {
    /* quota or private mode: the session still navigates, like the other stores */
  }
}

type UIState = {
  view: ViewId;
  history: Destination[];
  pointer: number;
  /** Navigate as a *user* action: pushes a destination. */
  go: (view: ViewId, ctx?: Record<string, unknown>) => void;
  back: () => void;
  forward: () => void;
  /**
   * Close whatever floats above the page, reporting whether there was anything
   * to close. Both history directions go through this — moving the page under an
   * open panel is what left 前进 able to navigate away while a dialog was still
   * pointing at the project that just disappeared.
   */
  closeTopLayer: () => boolean;
  /**
   * Legacy setter for code that changes the view as a side effect of something else
   * (the status strip jumping to the setting that owns a card). It does not push a
   * destination, so it cannot be used to fake your way into the history stack — but
   * it does rewrite the entry under the pointer to name the page it puts on screen,
   * which is the invariant `go` / `back` / `forward` all depend on.
   */
  setView: (v: ViewId) => void;
  /**
   * A settings section to scroll to and flash, consumed by 设置 on mount.
   *
   * This is how the status strip's "double-click a card → the setting that owns
   * it" works: the strip knows which card it is, 设置 knows which section that
   * is, and neither has to import the other.
   */
  settingsSection: string | null;
  setSettingsSection: (id: string | null) => void;
  /** Environment detail popover, opened from the status strip. */
  envOpen: boolean;
  setEnvOpen: (open: boolean) => void;
  /**
   * 网络诊断 dialog (r18 N2), opened from the strip popover, the palette, or
   * 设置 → 网络. It is store state rather than a local `useState` because three
   * unrelated components open it and two of them (palette, strip) have no prop
   * line to the composition root.
   */
  netDiagOpen: boolean;
  setNetDiagOpen: (open: boolean) => void;
  /** Project currently opened in the launch dialog, or null. */
  openSlug: string | null;
  setOpenSlug: (slug: string | null) => void;
  /** Prefills the add-view composer, e.g. from a search result. */
  composerSeed: string;
  setComposerSeed: (v: string) => void;
  /** Global command palette (Ctrl+K). */
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  /**
   * A search string for 记录, set when a palette result points at a past operation.
   * The records view consumes it on mount and clears it, so it is a one-shot handoff
   * rather than a second copy of that page's filter state.
   */
  recordsSeed: string;
  setRecordsSeed: (v: string) => void;
};

const initialNav = readNav();

export const useUI = create<UIState>((set, get) => ({
  view: initialNav.view,
  history: initialNav.history,
  pointer: initialNav.pointer,

  go: (view, ctx) => {
    // Coerced before the state machine runs, so an unknown name cannot become a
    // history entry the way a raw `as ViewId` from a pinned list would.
    const target = coerceView(view);
    set((s) => {
      // noUncheckedIndexedAccess：`history[s.pointer]` 的元素类型带 `| undefined`。
      // 持久化/序列化保证 pointer 落在界内，但「读不到」是类型层面的事实；
      // 缺席时退回当前视图自身的空条目——老代码的展开会落入 `{view: undefined}`
      // 这种破坏不变量的条目，这里显式给出一个合法的。
      const current = s.history[s.pointer] ?? { view: s.view };
      // Capture where we are before leaving it, so the entry we are about to move
      // off describes the page as the user actually had it. The snapshot REPLACES
      // the current entry — appending it instead is what made every navigation leave
      // a duplicate behind, so 后退 had to be pressed twice to move one page.
      const updated = [...s.history];
      updated[s.pointer] = {
        view: current.view,
        ctx: snapshot(s.view) ?? current.ctx,
      };
      if (s.view === target) {
        if (ctx) updated[s.pointer] = { view: current.view, ctx };
        const next = { view: target, history: updated, pointer: s.pointer };
        persistNav(next);
        return next;
      }
      const trunk = updated.slice(0, s.pointer + 1);
      const next = {
        view: target,
        history: [...trunk, { view: target, ctx }],
        pointer: trunk.length,
      };
      persistNav(next);
      return next;
    });
  },

  back: () => {
    const s = get();
    if (s.pointer <= 0) return;
    const target = s.history[s.pointer - 1];
    if (!target) return;
    // 同 `go`：缺席条目退回当前视图自己的空条目，而不是制造 view 缺失的条目。
    const leaving = s.history[s.pointer] ?? { view: s.view };
    const here = { view: leaving.view, ctx: snapshot(s.view) ?? leaving.ctx };
    pending = target.ctx ? { view: target.view, ctx: target.ctx } : null;
    const next = {
      view: target.view,
      pointer: s.pointer - 1,
      history: [...s.history.slice(0, s.pointer), here, ...s.history.slice(s.pointer + 1)],
    };
    set(next);
    persistNav(next);
  },

  forward: () => {
    const s = get();
    if (s.pointer >= s.history.length - 1) return;
    const target = s.history[s.pointer + 1];
    if (!target) return;
    // Capture before leaving, exactly as `back()` does (r15-correct-7). Without
    // it the page you are stepping *away from* kept whatever ctx it had when it
    // was first pushed: adjust a sort, press 前进, come back with 后退, and the
    // edits were gone — one direction preserved the user's context and the other
    // silently did not.
    const leaving = s.history[s.pointer] ?? { view: s.view };
    const here = { view: leaving.view, ctx: snapshot(s.view) ?? leaving.ctx };
    const history = [...s.history];
    history[s.pointer] = here;
    pending = target.ctx ? { view: target.view, ctx: target.ctx } : null;
    const next = { view: target.view, history, pointer: s.pointer + 1 };
    set(next);
    persistNav(next);
  },

  closeTopLayer: () => {
    const s = get();
    // Same precedence the 后退 handler used when it was inline in the shell:
    // the palette is on top, then the project panel, then the 网络诊断 dialog,
    // then the status strip's popovers. Only one layer closes per keypress, so
    // two stacked layers take two presses instead of vanishing at once.
    if (s.paletteOpen) {
      set({ paletteOpen: false });
      return true;
    }
    if (s.openSlug) {
      set({ openSlug: null });
      return true;
    }
    if (s.netDiagOpen) {
      set({ netDiagOpen: false });
      return true;
    }
    if (s.envOpen) {
      set({ envOpen: false });
      return true;
    }
    return false;
  },

  setView: (view) => {
    // Same door as `go`: a side-effect jump to an id nothing renders lands on
    // the landing page and says so, instead of putting a blank area on screen.
    const target = coerceView(view);
    set((s) => {
      const history = [...s.history];
      /**
       * The invariant all three mutators keep (r15-correct-7): **`history[pointer]`
       * names the view that is on screen, and its `ctx` is that view's own.**
       *
       * This setter used to change `view` and leave the entry underneath the
       * pointer naming the page the user had *just* left. Nothing else noticed —
       * until a snapshot ran: `back()` and `go()` both write `snapshot(s.view)`
       * into `history[pointer]`, so the *new* page's context landed in the *old*
       * page's entry. 后退 then restored a destination whose `view` was 项目 and
       * whose `ctx` was 设置's, and since the ctx keys collide across views (`sort`,
       * `filter`) the page came back quietly re-sorted by the other page's state.
       *
       * A side-effect move is still a move, so the entry has to follow it. Its
       * previous `ctx` belongs to the page being left and is dropped with it —
       * keeping it under the new view's name is the bug, and this is not a stop
       * the user can go back to (that is the whole point of `setView`).
       */
      if (s.view !== target) history[s.pointer] = { view: target };
      const next = { view: target, history, pointer: s.pointer };
      persistNav(next);
      return next;
    });
  },

  settingsSection: null,
  setSettingsSection: (settingsSection) => set({ settingsSection }),
  envOpen: false,
  setEnvOpen: (envOpen) => set({ envOpen }),
  netDiagOpen: false,
  setNetDiagOpen: (netDiagOpen) => set({ netDiagOpen }),
  openSlug: null,
  setOpenSlug: (openSlug) => set({ openSlug }),
  composerSeed: "",
  setComposerSeed: (composerSeed) => set({ composerSeed }),
  paletteOpen: false,
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  recordsSeed: "",
  setRecordsSeed: (recordsSeed) => set({ recordsSeed }),
}));


