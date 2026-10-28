import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import autoAnimate, { type AnimationController } from "@formkit/auto-animate";

/**
 * Motion helpers shared by every surface that appears or disappears.
 *
 * Why these exist: the app had enter animations written inline at each call site
 * and no exit animations at all — a menu unmounted the instant its state flipped,
 * so 消失 never happened. The fix is not "remember to animate" in thirty
 * components; it is one hook that keeps an element mounted exactly as long as the
 * stylesheet needs to play its exit, plus one token both sides read.
 */

/** Resolves a `--motion-*` custom property to milliseconds.
 *
 * `parseFloat` on the raw value is not enough: the ladder is written as
 * `calc(150ms * var(--motion-scale))` so a skin's speed applies to every rung
 * (index.css, 运动令牌), and `getPropertyValue` hands back that *unresolved*
 * string, which parses to NaN and would silently make every JS-side wait fall
 * back to its default instead of following the skin. Asking the engine for a
 * computed `transition-duration` resolves the calc the same way the animation
 * itself will.
 */
export function motionMs(token: string, fallback = 150): number {
  if (typeof window === "undefined") return fallback;
  const probe = document.createElement("div");
  probe.style.position = "fixed";
  probe.style.left = "-9999px";
  probe.style.transitionDuration = `var(${token})`;
  document.body.appendChild(probe);
  const computed = getComputedStyle(probe).transitionDuration;
  probe.remove();
  const seconds = Number.parseFloat(computed);
  if (!Number.isFinite(seconds)) {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
    const direct = raw.endsWith("ms") ? Number.parseFloat(raw) : Number.parseFloat(raw) * 1000;
    return Number.isFinite(direct) ? direct : fallback;
  }
  return Math.round(seconds * 1000);
}

/**
 * Keeps a layer in the DOM for its exit duration.
 *
 * Returns whether to render it and what `data-state` to put on it — the CSS in
 * `index.css` (`[data-layer][data-state="closed"]`) owns the actual motion, so a
 * component never states a duration it could get wrong.
 *
 * `open` flipping false while nothing is rendered is the no-op case: the very
 * first close of a layer that never opened must not schedule a timer.
 */
export function useLayerExit(open: boolean, extraMs = 0) {
  const [render, setRender] = useState(open);
  const [state, setState] = useState<"open" | "closed">(open ? "open" : "closed");
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    if (open) {
      setRender(true);
      setState("open");
      return;
    }
    if (!render) return;
    setState("closed");
    timer.current = window.setTimeout(
      () => setRender(false),
      motionMs("--motion-exit") + extraMs,
    );
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [open, render, extraMs]);

  return { render, state };
}

/**
 * Lets a layer play its own exit before the parent unmounts it.
 *
 * The app's overlays are conditionally rendered by their parents
 * (`{openSlug && <LaunchDialog/>}`), so an `onClose` handler means the element is
 * gone on the next frame and 消失 never renders. Rather than teaching every call
 * site to keep its child mounted, the surface defers the callback by exactly the
 * CSS exit duration and reports `leaving` to its own markup.
 *
 * Caveats worth knowing: a close driven by *other* state (another component
 * clearing the flag) will not animate, and a layer whose parent unmounts for an
 * unrelated reason simply disappears — which is the correct behaviour, not a bug
 * to paper over.
 */
export function useSelfClosing(onClose: () => void) {
  const [leaving, setLeaving] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const close = () => {
    if (leaving) return;
    setLeaving(true);
    timer.current = window.setTimeout(onClose, motionMs("--motion-exit") + 20);
  };

  return { leaving, close };
}

/**
 * Turns off the CSS stagger once the first batch has played.
 *
 * A grid that keeps `animation` on its children will re-run it for a card added
 * later by a filter change, and that card is also being animated by auto-animate.
 * Two engines writing one transform shows up as a card sitting in the wrong slot
 * for a frame, so the entrance owns only the mount.
 *
 * Put it on the same element that carries `.motion-stagger`.
 */
export function useEntranceGate(
  ref: React.RefObject<HTMLElement | null>,
  maxItems = 12,
) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.dataset.entered = "false";
    const count = Math.min(el.children.length || 1, maxItems);
    const total = motionMs("--motion-enter") + motionMs("--motion-stagger", 40) * count;
    const t = window.setTimeout(() => {
      el.dataset.entered = "true";
    }, total + 60);
    return () => window.clearTimeout(t);
  }, [ref, maxItems]);
}

/**
 * One auto-animate controller per list container, for pages whose lists are
 * rendered inside a `.map()`.
 *
 * `useAutoAnimate` from the package handles a single element, which is fine for a
 * page with one list and useless for the records view (a container per day) or
 * the grouped project wall. `register` is a stable ref callback: React calls it
 * once per element and runs the returned cleanup when that element goes away, so
 * controllers do not accumulate on detached nodes.
 */
export function useAutoLayers() {
  const controllers = useRef(new Map<HTMLElement, AnimationController>());

  const register = useCallback((el: HTMLElement | null) => {
    if (!el || controllers.current.has(el)) return;
    const controller = autoAnimate(el, {
      duration: motionMs("--motion-enter"),
      easing: "ease-out",
    });
    controllers.current.set(el, controller);
    // The in-app 减弱动画 switch works by zeroing CSS durations. auto-animate runs
    // on the Web Animations API, which does not read CSS, so the switch has to be
    // applied here or a user who turned motion off still gets moving cards.
    if (document.documentElement.dataset.motion === "reduced") controller.disable();
    return () => {
      controller.disable();
      controllers.current.delete(el);
    };
  }, []);

  /** Turning this off while another engine owns the children's transforms is what
   *  keeps auto-animate and dnd-kit from fighting over the same card. The app-wide
   *  减弱动画 switch always wins over a caller asking for motion. */
  const setEnabled = useCallback((requested: boolean) => {
    const on = requested && document.documentElement.dataset.motion !== "reduced";
    controllers.current.forEach((c) => (on ? c.enable() : c.disable()));
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    // Copy the map once: the cleanup must act on the map this effect registered
    // controllers into, not on whatever `controllers.current` points at later.
    const map = controllers.current;
    const sync = () => setEnabled(root.dataset.motion !== "reduced");
    // One observer for the whole app instead of every list subscribing to the
    // appearance store: the store already writes this attribute, and writing it
    // is the signal.
    const obs = new MutationObserver(sync);
    obs.observe(root, { attributes: true, attributeFilter: ["data-motion"] });
    sync();
    return () => {
      obs.disconnect();
      map.forEach((c) => c.disable());
      map.clear();
    };
  }, [setEnabled]);

  // Stable identity, so `useEffect(..., [dragging, walls])` at a call site does not
  // re-run on every render.
  return useMemo(() => ({ register, setEnabled }), [register, setEnabled]);
}
