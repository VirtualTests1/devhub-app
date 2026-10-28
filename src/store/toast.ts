import { create } from "zustand";

/**
 * The toast queue, without the pixels.
 *
 * Why this file exists separately from `components/Toast.tsx`: the host is a
 * `.tsx`, and Node's type-stripping runner cannot even parse JSX, so anything
 * that imports `toast` became untestable outside the browser. `src/lib/report-error.ts`
 * needs `toast.error` and a unit test, so the queue moved here and the host kept
 * the drawing. The re-export in `components/Toast.tsx` means no call site had to
 * change its import line.
 *
 * Why a store rather than local state: success feedback was requested for many
 * unrelated actions (settings saved, root changed, download finished), and each
 * of those lives in a different component. One store + one host in `App` gives
 * every action a single line of API: `toast("已保存并生效")`.
 *
 * Timing, from round 9 (需求 5): everything auto-dismisses, by kind — success
 * 3 s, info 3.5 s, error 6 s. Hover or focus pauses every countdown at once.
 * At most three are visible; a fourth pushes the oldest out.
 */

export type ToastKind = "success" | "error" | "info";

/** How long each kind stays, in ms. Errors get the most reading time. */
const DISMISS_MS: Record<ToastKind, number> = {
  success: 3000,
  info: 3500,
  error: 6000,
};

/** More than three at once is a wall of text, which is the complaint. */
const MAX_VISIBLE = 3;

export type ToastItem = {
  id: number;
  kind: ToastKind;
  text: string;
  /** Epoch ms after which the ticker retires this toast. */
  expiresAt: number;
};

type ToastState = {
  items: ToastItem[];
  /** True while the pointer or keyboard focus is inside the host. */
  paused: boolean;
  push: (kind: ToastKind, text: string) => void;
  dismiss: (id: number) => void;
  setPaused: (paused: boolean) => void;
};

let nextId = 1;

/** The one ticker. 250 ms is fine-grained enough to feel immediate on expiry
 *  and cheap enough to forget about. It stops itself when nothing is left. */
let ticker: number | null = null;

/** Arms the ticker if it is idle. Exported because the host re-arms it on every
 *  render — see `ToastHost`'s first effect. */
export function ensureTicker() {
  if (ticker !== null) return;
  ticker = window.setInterval(() => {
    const { items, paused } = useToast.getState();
    if (paused || items.length === 0) return;
    const now = Date.now();
    const alive = items.filter((t) => t.expiresAt > now);
    if (alive.length !== items.length) {
      useToast.setState({ items: alive });
      if (alive.length === 0 && ticker !== null) {
        window.clearInterval(ticker);
        ticker = null;
      }
    }
  }, 250);
}

export const useToast = create<ToastState>((set) => ({
  items: [],
  paused: false,

  push: (kind, text) => {
    const id = nextId++;
    // Newest last: the stack grows upward from the bottom-right corner, so the
    // freshest toast is the one closest to the hand.
    set((s) => ({
      items: [...s.items, { id, kind, text, expiresAt: Date.now() + DISMISS_MS[kind] }].slice(
        -MAX_VISIBLE,
      ),
    }));
    ensureTicker();
  },

  dismiss: (id) =>
    set((s) => {
      const items = s.items.filter((t) => t.id !== id);
      if (items.length === 0 && ticker !== null) {
        window.clearInterval(ticker);
        ticker = null;
      }
      return { items };
    }),

  setPaused: (paused) => set({ paused }),
}));

/** One-line helpers so call sites read like sentences. */
export const toast = {
  success: (text: string) => useToast.getState().push("success", text),
  error: (text: string) => useToast.getState().push("error", text),
  info: (text: string) => useToast.getState().push("info", text),
};
