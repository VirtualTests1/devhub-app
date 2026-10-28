/**
 * The 项目墙's GitHub heat store (r18 N4).
 *
 * Shape taken from `src/store/meta.ts`, including the sequence guard, and for the same
 * measured reason: two loads can be in flight at once, and without a monotonic stamp the
 * *earlier* answer — the one the backend served out of its cache — can land last and
 * overwrite the fresh numbers. Round 15 recorded that race as `r15-correct-4`; a second
 * store making the same mistake would be the same bug in different clothes.
 *
 * ## Why nothing here auto-polls, and why there is no `force`
 *
 * Every other poller in this app re-reads something *local* (processes, ports, the wall
 * index). This one asks GitHub. A timer would spend rate-limit budget on a number that
 * moves on the scale of days, and the backend's own rules are what makes a repeat cheap:
 * six-hour TTL, and anything older re-validated with `If-None-Match` (a `304` is not
 * charged). So the store is called when the wall is ordered by 按 Star 数 and by nothing
 * else. The command still accepts an optional `force` — it documents the 刷新 semantics
 * in `src-tauri/src/heat.rs:heat_many` and is covered there — but no surface in this app
 * asks for it yet, so the fetcher does not carry the parameter.
 */
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { swallow } from "../lib/report-error";
import { indexHeat } from "../lib/heat";
import type { RepoHeat } from "../types";

export type HeatFetcher = (names: string[]) => Promise<RepoHeat[]>;

type HeatState = {
  /** Keyed by `owner/repo`. An absent key means "never asked", not "zero stars". */
  bySlug: Record<string, RepoHeat>;
  loading: boolean;
  loadedAt: number;
  /** How many rows the last batch answered. */
  lastCount: number;
  load: (names: string[]) => Promise<void>;
};

export function createHeatStore(fetchHeat: HeatFetcher) {
  /** Monotonic request stamp; only the newest accepted load may write. */
  let seq = 0;
  /** The name list currently in flight, so a re-fire with the *same* names is dropped. */
  let pendingKey: string | null = null;

  return create<HeatState>((set, get) => ({
    bySlug: {},
    loading: false,
    loadedAt: 0,
    lastCount: 0,

    load: async (names) => {
      if (names.length === 0) return;
      // Drop a re-fire that asks for exactly what is already in flight — the wall's
      // effect runs whenever `cards` gets a new identity, which is often, and GitHub
      // would see the same batch over and over. A *different* list is allowed through:
      // the wall gained or lost repositories while a batch was out, and the tiles that
      // just appeared must still be answered. That is what makes the sequence below more
      // than decoration — two different batches really can be in flight, and the older
      // one must not write over the newer.
      const key = names.join("|");
      if (get().loading && pendingKey === key) return;
      const mine = ++seq;
      pendingKey = key;
      set({ loading: true });
      try {
        const list = await fetchHeat(names);
        if (mine !== seq) return;
        // Merge rather than replace: a batch is capped, so rows answered by an earlier
        // batch that were not in this one are still true and stay on screen.
        const bySlug = { ...get().bySlug, ...indexHeat(list) };
        set({ bySlug, loadedAt: Date.now(), lastCount: list.length });
      } catch (e) {
        if (mine !== seq) return;
        // Cosmetic, like the metadata labels: a missing star count must never look like
        // a broken wall. `swallow` still records the reason in console.debug, because
        // "absent" and "silent" are different things and only one of them is unhelpful.
        swallow(e, "仓库热度取不到就不显示数字，项目墙照常渲染");
      } finally {
        // Only the newest load ends the loading state; an older response finishing
        // first used to clear it while a newer one was still out.
        if (mine === seq) {
          set({ loading: false });
          pendingKey = null;
        }
      }
    },
  }));
}

export const useHeat = createHeatStore((names) => invoke<RepoHeat[]>("repo_heat_many", { names }));
