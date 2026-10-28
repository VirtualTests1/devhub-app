/**
 * Viewport-based lazy trigger: a boolean that flips to `true` once the element
 * is (or is about to be) on screen, and stays true.
 *
 * ## Why this exists
 *
 * `RepoTile` fetches its OpenGraph cover on mount. A 40-card wall therefore
 * issues 40 `fetch_cover` IPC calls the moment the 项目 page paints, even
 * though only ~8 cards are visible. The backend's disk cache makes each call
 * cheap individually, but the fan-out still costs: 40 IPC round-trips, 40
 * `convertFileSrc` asset registrations, and 40 image decodes that the user
 * never sees.
 *
 * `loading="lazy"` on the `<img>` only defers the *decode* — the IPC call and
 * the disk read already happened. What we actually want is to defer the fetch
 * itself until the card is within a screen or two of the viewport, which is
 * what IntersectionObserver gives us.
 *
 * ## The shared observer
 *
 * One observer for the whole wall, not one per card: 40 IntersectionObserver
 * instances are measurably heavier than one observer with 40 targets (the
 * observer is the expensive native object; targets are bookkeeping). The
 * singleton is created on first use and never torn down — tiles come and go
 * but the page lives for the session, and re-creating the observer on every
 * mount would defeat the point.
 *
 * ## `once` semantics
 *
 * Once a card has been near the screen it stays "in view" for the rest of its
 * mount. A cover that was fetched must not be re-fetched because the user
 * scrolled away and back. The `inView` flag is monotonic.
 *
 * ## Graceful fallback
 *
 * When IntersectionObserver is unavailable (old WebView2, tests without a DOM),
 * the hook reports `true` immediately — better to over-fetch than to show a
 * wall of gradient-only cards. The same fallback fires if `ref` is never
 * attached.
 */
import { useEffect, useRef, useState } from "react";

let sharedObserver: IntersectionObserver | null = null;
const watchers = new Map<Element, (inView: boolean) => void>();

function getObserver(): IntersectionObserver | null {
  if (typeof IntersectionObserver === "undefined") return null;
  if (sharedObserver) return sharedObserver;
  // `rootMargin: "200px 0"` means "fire when the card is within 200 px of the
  // viewport's top or bottom edge" — far enough that the cover is usually
  // decoded by the time the card scrolls into view, close enough that a wall
  // of 40 cards still only fetches ~12 covers on first paint.
  sharedObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const cb = watchers.get(entry.target);
        if (cb && entry.isIntersecting) cb(true);
      }
    },
    { rootMargin: "200px 0px", threshold: 0 },
  );
  return sharedObserver;
}

export function useInView<T extends Element>(): [React.RefCallback<T>, boolean] {
  const [inView, setInView] = useState(false);
  const ref = useRef<T | null>(null);
  const setRef = useRef((el: T | null) => {
    ref.current = el;
  });

  useEffect(() => {
    if (inView) return;
    const el = ref.current;
    if (!el) return;
    const obs = getObserver();
    if (!obs) {
      setInView(true);
      return;
    }
    watchers.set(el, (v) => {
      if (v) {
        setInView(true);
        watchers.delete(el);
        obs.unobserve(el);
      }
    });
    obs.observe(el);
    return () => {
      watchers.delete(el);
      obs.unobserve(el);
    };
  }, [inView]);

  return [setRef.current, inView];
}
