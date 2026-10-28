import { useCallback, useSyncExternalStore } from "react";
import {
  getLocale,
  setLocale,
  subscribeLocale,
  tFor,
  type Locale,
  type TFunc,
} from "./i18n";

/**
 * The React edge of `lib/i18n`.
 *
 * Split from the dictionary module so `i18n.ts` keeps zero React (and zero
 * JSX-adjacent) imports at its top — the Node test runner loads every
 * `src/lib/**` module, and `tests/lib-import-graph.test.ts` fails the build if
 * any of them becomes un-importable. A `.ts` file importing the `react`
 * package is fine under that guard (`useSettingsAutosave.ts` has done it since
 * round 6); the split is about the *dictionary* staying a pure module the
 * tests can drive without a renderer, not about `react` being hazardous.
 *
 * `useSyncExternalStore` is the whole integration: the locale store is a
 * primitive snapshot (a string) plus a subscribe function, so a switch
 * re-renders every mounted consumer exactly once and the getSnapshot identity
 * cannot loop. The returned `t` is memoised on the locale, so it is a stable
 * dependency for the `useMemo`s that build command lists (CommandPalette).
 */
export type I18n = {
  locale: Locale;
  setLocale: (next: Locale) => void;
  t: TFunc;
};

export function useI18n(): I18n {
  const locale = useSyncExternalStore(subscribeLocale, getLocale);
  const t = useCallback<TFunc>((key, vars) => tFor(locale, key, vars), [locale]);
  return { locale, setLocale, t };
}
