/**
 * The canonical repository slug.
 *
 * `host/owner/repo` is the app's repository identity: it is what the backend
 * addresses a repo by, what `localStorage` usage keys are built from
 * (`repo:<slug>`), what the wall's per-project overlay is keyed by, and what each
 * clone's own `.devhub.json` records. It is *not* the cover service's key — that
 * one is `owner/repo`, deliberately shorter (`RepoTile.coverSlug`) — and a slug
 * derived from a *pasted ref* is a guess at this shape rather than a known
 * `RepoRef`: that direction lives in `slugFromRef` below, which either answers
 * with this exact shape or admits the ref names no repository.
 *
 * Why this lives in `lib/` and not in `store/wall.ts`, where it was born: the
 * identity of a repository is not wall state, and three surfaces that need it
 * (命令面板、常用页、项目墙) had to reach into a store to spell it — so two of them
 * wrote their own copy instead, byte-identical, and drifted the moment one of them
 * was edited. `lib/` is dependency-free, so nothing has to import a store to name
 * a repository.
 *
 * `store/wall.ts` still re-exports this while its older consumers keep importing
 * it from there; the re-export is a pass-through of *this* function, not a second
 * implementation, and it is what `tests/single-source.test.ts` checks.
 */

/** The three parts every `RepoRef` carries. Structural on purpose: a slug needs
 *  nothing but these, so callers from a store, a view or a test all satisfy it. */
export type SlugParts = { host: string; owner: string; repo: string };

export const slugOf = (r: SlugParts): string => `${r.host}/${r.owner}/${r.repo}`;

/**
 * The canonical slug for a *pasted ref*, or `null` when the ref names no
 * repository.
 *
 * The download queue's 打开项目 needs a slug, and all it has is `task.ref` —
 * whatever the add page, a search result or a record retry put there. The
 * backend's `DownloadOutcome` would be the source of truth for the resolved
 * host, but it carries no identity fields (only `path`/`layer`/`attempts`;
 * `DownloadQueue.tsx`'s comment on this used to promise "the same parser
 * handles it" while the parser only handled pasted `http(s)` URLs), so the ref
 * is the only place identity can come from.
 *
 * The shapes people actually paste, and what each becomes:
 *
 *   - `https://host/owner/repo(.git)` — parsed as a URL; the scheme is not part
 *     of the identity, and for `http(s)` a non-default port stays (`u.host`),
 *     which is what the old queue parser produced.
 *   - `ssh://git@host/owner/repo` / `git://…` — same URL parse; for these the
 *     port and the login are transport detail, not identity, so the bare
 *     hostname is used.
 *   - `git@host:owner/repo(.git)` — the scp-like form, which is not a URL and
 *     used to be mangled into `host/git@host:owner/repo`.
 *   - `owner/repo` — assumed GitHub, the queue's one host-guessing case, same
 *     as before; `host/owner/repo` is taken as typed.
 *
 * Anything else answers `null` rather than a fabricated slug: a single word, a
 * search query, an empty string. A wrong slug does not fail loudly — the
 * dialog it opens just cannot load that project — so "I cannot name this
 * repository" has to be a first-class answer the caller can disable on.
 *
 * Pinned by `tests/slug-from-ref.test.ts`.
 */
export function slugFromRef(ref: string): string | null {
  const trimmed = ref.trim();
  if (!trimmed) return null;

  // `scheme://…` — http(s), ssh, git, … one parse for all of them.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      const u = new URL(trimmed);
      const host = /^https?:$/i.test(u.protocol) ? u.host : u.hostname;
      const path = u.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
      if (!host || !path) return null;
      // `${host}/${path}` already drops the scheme; strip a trailing `.git`.
      const slug = `${host}/${path}`.replace(/\.git\/?$/i, "");
      // host + owner + repo at minimum: `https://github.com/owner` never named
      // a repository, and answering with it was the same silent dead end as the
      // mangled forms above.
      return slug.split("/").length >= 3 ? slug : null;
    } catch {
      // Not a URL after all — fall through to the shapes below.
    }
  }

  // scp-like `user@host:owner/repo`, which has no `//` for `URL` to take.
  const scp = trimmed.match(/^([^@/:]+)@([^/:]+):(.+)$/);
  if (scp) {
    const path = (scp[3] ?? "").replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git\/?$/i, "");
    if (!path || path.split("/").length < 2) return null;
    return `${scp[2]}/${path}`;
  }

  // `host/owner/repo` (3+ segments) as typed, or `owner/repo` (2) on GitHub.
  const segments = trimmed
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .split("/")
    .filter((s) => s.length > 0);
  if (segments.length === 2) return `github.com/${segments.join("/")}`;
  if (segments.length >= 3) return segments.join("/");
  return null;
}
