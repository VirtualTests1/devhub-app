/**
 * A `localStorage` stand-in, so the stores that persist to it can be imported and
 * driven from Node.
 *
 * Why this exists rather than a DOM library: `landing.ts` / `wall.ts` /
 * `customize.ts` / `appearance.ts` all read their initial state from
 * `localStorage` *inside a try/catch*, so they import cleanly here and simply
 * start from defaults — a test could not tell "empty storage" from "storage I
 * seeded". The helper installs a real map, then re-imports the module fresh so
 * its initial state actually comes from the seed.
 *
 * The cache-busting query (`?hub=N`) is what makes "re-import fresh" work: Node
 * keys the ESM module registry by resolved URL, so a new query string is a new
 * module instance, and its top-level `read()` runs again against this seed.
 */

type Seed = Record<string, string>;

import { flushStorage } from "../../src/lib/storage.ts";

const store = new Map<string, string>();

const fake: Storage = {
  get length() {
    return store.size;
  },
  key(index: number) {
    return [...store.keys()][index] ?? null;
  },
  getItem(k: string) {
    return store.has(k) ? (store.get(k) as string) : null;
  },
  setItem(k: string, v: string) {
    store.set(k, String(v));
  },
  removeItem(k: string) {
    store.delete(k);
  },
  clear() {
    store.clear();
  },
};

let counter = 0;

/** Installs the fake `localStorage` (and optionally `window`) for this process. */
export function installBrowserGlobals(opts?: { matchMedia?: (q: string) => { matches: boolean } }) {
  (globalThis as { localStorage?: Storage }).localStorage = fake;
  if (opts?.matchMedia) {
    (globalThis as { window?: unknown }).window = { matchMedia: opts.matchMedia };
  }
}

/**
 * Imports a fresh copy of `url` bound to `seed`.
 *
 * `url` is a *resolved* URL — callers pass `import.meta.resolve("../src/…")` —
 * because a bare relative specifier would resolve against this helper file,
 * not against the test that asked for it.
 */
export async function importSeeded<T>(url: string, seed?: Seed): Promise<T> {
  // A previous test's coalesced write (250 ms trailing timer in
  // `src/lib/storage.ts`) may still be pending: `store.clear()` below wipes the
  // map, but the timer fires *after* the clear and *before/while* the fresh
  // module reads its seed, re-injecting the previous test's JSON. That is how
  // "wall: unhideAll and resetAll" saw `repos.a = {pinned:true}` left over from
  // the pin test above it when the suite ran under load. Flush first — the
  // flush cancels the timer — then clear, so the read sees exactly the seed.
  flushStorage();
  store.clear();
  if (seed) for (const [k, v] of Object.entries(seed)) store.set(k, v);
  counter += 1;
  return (await import(`${url}?hub=${counter}`)) as T;
}

/** Imports fresh with empty storage — the "first run" case. */
export async function importFresh<T>(url: string): Promise<T> {
  return importSeeded<T>(url, {});
}

/** What the module wrote back out, for asserting a reducer actually persisted. */
export function readBack(key: string): string | null {
  return fake.getItem(key);
}
