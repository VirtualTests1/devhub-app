import { create } from "zustand";

/**
 * Landing-directory history for the add view's 落位 dropdown (round 9, 需求 3).
 *
 * "添加页的落位目录应当有下拉框可选择历史路径" - and the only honest source for
 * *landing* history is the overrides this person actually typed. The settings
 * page keeps a different list (`recentRoots`: directories that have been the
 * project root), which the dropdown shows underneath; the two answer different
 * questions and are kept apart so neither can quietly become the other.
 *
 * Only explicit overrides are remembered. A download that took the computed
 * `<root>/<repo>_<owner>` path is not a choice, and filling the list with the
 * project root over and over would make the dropdown useless.
 */

const KEY = "devhub.landing.v1";
const CAP = 8;

type LandingState = {
  history: string[];
  remember: (path: string) => void;
};

function read(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  } catch {
    return [];
  }
}

function persist(list: string[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* quota or private mode: the session keeps its history */
  }
}

export const useLanding = create<LandingState>((set) => ({
  history: read(),

  remember: (path) => {
    const trimmed = path.trim();
    if (!trimmed) return;
    set((s) => {
      const next = [trimmed, ...s.history.filter((p) => p !== trimmed)].slice(0, CAP);
      persist(next);
      return { history: next };
    });
  },
}));
