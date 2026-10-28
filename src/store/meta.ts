import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { swallow } from "../lib/report-error";
import type { RepoMeta } from "../types";

/**
 * Per-repository metadata for the 项目墙 (round 9, 需求 1).
 *
 * ## Why this is a store and not part of the wall fetch
 *
 * The Rust side computes these facts by walking each clone - a size walk takes
 * seconds on a container that also holds build trees - so `list_repositories`
 * stays cheap and the wall paints first. This store is filled right after, and
 * the tiles render their labels as the answers arrive; a failure leaves the
 * labels absent rather than breaking the wall, because a missing "128 MB" is
 * cosmetics and a missing project is not.
 *
 * ## Why `load` deduplicates, and why it also needs a sequence guard
 *
 * The backend caches per directory mtime with a ten-minute age, so asking again
 * is nearly free. A plain second ask while one is in flight is dropped rather
 * than queued: the in-flight answer is newer than the request that would replace
 * it.
 *
 * A `force` ask is different — 刷新 means "re-walk past that cache" — and it used
 * to be accepted unconditionally, which is the r15-correct-4 race. Two loads
 * could then be in flight at once (the wall's own follow-up and a 刷新, or two
 * refresh paths from the download queue and the launch dialog), and the *earlier*
 * one — the cached, stale answer — was still allowed to write `bySlug` after the
 * fresh one landed, so the wall ended up showing sizes from before the refresh.
 * Whichever load finishes last also cleared `loading` for both.
 *
 * So the store keeps a monotonic request sequence, the same shape `App.tsx` uses
 * for settings (`settingsSeq`, and its `if (settingsSeq.current === seq)` guard at
 * the write): every `load` stamps the sequence at entry and only its own newest
 * stamp may write state or clear `loading`. The dedupe above is unchanged —
 * this is what makes the *non*-dropped case safe.
 */

type MetaState = {
  bySlug: Record<string, RepoMeta>;
  loading: boolean;
  loadedAt: number;
  load: (force?: boolean) => Promise<void>;
};

/**
 * The one thing this store asks the backend for, behind an interface.
 *
 * `invoke` cannot be reached from the zero-dependency Node test runner (there is
 * no Tauri IPC, and `--experimental-strip-types` refuses `.tsx`), so the ordering
 * rule below — the part that actually broke — is driven through an injected
 * fetcher. Production wires the real command; see `useMeta`.
 */
export type MetaFetcher = (force: boolean) => Promise<RepoMeta[]>;

/** Builds the metadata store over a fetcher. `useMeta` is the real-command instance. */
export function createMetaStore(fetchMetadata: MetaFetcher) {
  /**
   * Monotonic request stamp. Bumped on every load that is *accepted*, so a
   * response can be recognised as the one the caller is still waiting for.
   */
  let seq = 0;

  return create<MetaState>((set, get) => ({
    bySlug: {},
    loading: false,
    loadedAt: 0,

    load: async (force = false) => {
      if (get().loading && !force) return;
      const mine = ++seq;
      set({ loading: true });
      try {
        const list = await fetchMetadata(force);
        // A newer load owns the answer: the cached response of an earlier call
        // must not overwrite what the forced one already put up.
        if (mine !== seq) return;
        const bySlug: Record<string, RepoMeta> = {};
        for (const m of list) bySlug[m.slug] = m;
        set({ bySlug, loadedAt: Date.now() });
      } catch (e) {
        if (mine !== seq) return;
        // 故意不打扰用户：这是墙的化妆品，缺了「128 MB」不影响项目本身。
        // 但「完全没反应」曾让人以为 store 坏了——swallow 会把理由写进 console.debug。
        swallow(e, "仓库元数据是墙的化妆品，标签缺席即可，墙照常渲染");
      } finally {
        // Only the newest load gets to end the loading state; an older response
        // finishing first used to clear it while a newer one was still out.
        if (mine === seq) set({ loading: false });
      }
    },
  }));
}

export const useMeta = createMetaStore((force) => invoke<RepoMeta[]>("repo_metadata", { force }));
