import { useEffect, useRef } from "react";

/** 一个盒子或一组盒子：浮层与它的触发器常常不在同一个父节点里（Controls 的下拉就是两段兄弟）。 */
export type ElementBox = { readonly current: HTMLElement | null };

/** 「自己会响应激活事件」的元素：按钮、表单控件、链接，以及显式声明排除行级点击的盒子。 */
const OWN_ACTIVATION_SELECTOR =
  "button, select, input, textarea, a, label, [data-no-row-click]";

/**
 * 事件源头是否落在一个「自己处理激活」的控件里。
 *
 * 行级容器（`role="button"` 的设置行、`role="group"` 的下载行）同时接收
 * click 与从内层控件冒泡上来的 keydown。click 路径早就有这个判定
 * （SettingsRows 的 `handledInside`），键盘路径没有 —— 焦点停在内层
 * Switch/选项按钮上时，一次 Enter 会既激活控件又跑一遍行动作（r15-a11y-1/2）。
 * 判定收敛在这里，两条路径与两个页面共用同一份选择器，不再各写一遍。
 */
export function hasOwnActivation(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el?.closest) return false;
  return !!el.closest(OWN_ACTIVATION_SELECTOR);
}

/**
 * 行级容器是否「拥有」这次 Enter/Space keydown。
 *
 * 判定只有一条：键是激活键，且焦点不在行内某个自带激活语义的控件上。
 * 返回 false 时调用方必须整段跳过 —— 连 preventDefault 都不能做，
 * 否则会把内层按钮自己的激活掐掉（下载行的 r15-a11y-2 正是这样把
 * 「移除」顺带变成了「展开」）。
 */
export function rowOwnsKey(target: EventTarget | null, key: string): boolean {
  return (key === "Enter" || key === " ") && !hasOwnActivation(target);
}

/**
 * 纯重排步进：把 `id` 在 id 列表里移动 `delta` 格（r15-a11y-8 的键盘路径）。
 *
 * 常用页的固定项此前只有鼠标拖拽一条路（原生 draggable），键盘没有任何入口，
 * 而邻页的项目墙早就有 dnd-kit 的 KeyboardSensor（ProjectsView:539）。键盘
 * 处理只负责把方向键翻译成 ±1 的请求，位移算术收敛在这一个纯函数里 ——
 * 放在 `.ts` 而非组件文件里，是因为 Node 的 type-stripping 拒收 `.tsx`，
 * 这一层的规矩就是把能钉住的部分挪到可测的一侧。找不到 id、移出边界都
 * 返回原数组，与 `dialogs/launch/step-keys.ts` 的 moveStep 同一套 no-op 规则。
 */
export function reorderById(ids: readonly string[], id: string, delta: number): string[] {
  const from = ids.indexOf(id);
  if (from < 0) return [...ids];
  const to = from + delta;
  if (to < 0 || to >= ids.length) return [...ids];
  const next = [...ids];
  const moved = next.splice(from, 1)[0];
  if (moved === undefined) return [...ids];
  next.splice(to, 0, moved);
  return next;
}

/**
 * 焦点是否已经「无人认领」——落回了文档根。
 *
 * 浮层里的元素被卸载（关闭整层，或选完一项后那一行消失）时，浏览器把焦点
 * 交回 body；调用方判定「该不该把焦点还给触发器」用的就是这一条。写成接收
 * 一个文档形状而不是直接读全局 document，是为了让它能被单测钉住。
 */
export function focusIsLost(doc: {
  activeElement: unknown;
  body: unknown;
  documentElement: unknown;
}): boolean {
  const a = doc.activeElement;
  return !a || a === doc.body || a === doc.documentElement;
}

/**
 * 关闭浮层后归还焦点（r15-a11y-9）。
 *
 * 下一帧再看：React 会在离散事件提交后、绘帧之前完成卸载，那时 activeElement
 * 是不是已经掉到根才说明问题。用户点在另一个可聚焦元素上关闭的，焦点在
 * 那个元素手里 —— 不许抢；只有真的无人认领时，才把焦点交还触发器。
 */
export function restoreFocusWhenLost(trigger: ElementBox): void {
  requestAnimationFrame(() => {
    if (!focusIsLost(document)) return;
    const el = trigger.current;
    if (el && document.contains(el)) el.focus({ preventScroll: true });
  });
}

/**
 * 「外部 pointerdown / Escape 关闭这一层浮层」的统一实现。
 *
 * 这句话此前在五处各写了一遍（Controls 下拉、状态条弹层、历史路径、常用页
 * 选择器、字体下拉），每处的事件名（mousedown 还是 pointerdown）、监听阶段
 * （capture 还是 bubble）、监听对象（document 还是 window）都不一样。收敛成
 * 一个 hook，保留各调用点确实存在的差异作为选项：
 *
 *   - `enabled`：浮层关着时不订阅（五处原本都是 `if (!open) return`）；
 *   - `capture`：pointerdown 是否走捕获阶段——需要抢在组件自己的 handler
 *     之前看到点击的调用点用 true；
 *   - `escape`：Escape 是否由本 hook 负责。列表框自己处理 Escape 以便把焦点
 *     还给触发器时，调用点把它关掉。
 *   - `returnFocusTo`（r15-a11y-9，可选）：浮层被 dismiss 后，若焦点落回
 *     文档根就把它还给触发器。此前每层浮层 dismiss 后焦点都掉到 body，
 *     键盘用户得重新 Tab 整块面板。默认不传 = 行为与从前完全一致。
 *
 * pointerdown 忽略落在浮层内部的按下；Escape 不看来源——焦点在面板里按
 * Escape 也必须能关掉它。refs 与 onClose 每次渲染换身份也不要紧：它们存在
 * ref 里，监听器只在 enabled/选项变化时重新订阅。
 */
export function useDismiss(
  refs: ElementBox | ElementBox[],
  onClose: () => void,
  opts?: {
    enabled?: boolean;
    capture?: boolean;
    escape?: boolean;
    returnFocusTo?: ElementBox;
  },
) {
  const enabled = opts?.enabled ?? true;
  const capture = opts?.capture ?? false;
  const escape = opts?.escape ?? true;

  const latest = useRef({ refs, onClose, returnFocusTo: opts?.returnFocusTo });
  latest.current = { refs, onClose, returnFocusTo: opts?.returnFocusTo };

  useEffect(() => {
    if (!enabled) return;
    const isInside = (target: EventTarget | null) => {
      const boxes = Array.isArray(latest.current.refs) ? latest.current.refs : [latest.current.refs];
      const node = target as Node | null;
      return !!node && boxes.some((box) => box.current?.contains(node) ?? false);
    };
    const dismiss = () => {
      latest.current.onClose();
      const trigger = latest.current.returnFocusTo;
      if (trigger) restoreFocusWhenLost(trigger);
    };
    const onPointerDown = (e: PointerEvent) => {
      if (!isInside(e.target)) dismiss();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    document.addEventListener("pointerdown", onPointerDown, capture);
    if (escape) document.addEventListener("keydown", onKeyDown, capture);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, capture);
      document.removeEventListener("keydown", onKeyDown, capture);
    };
  }, [enabled, capture, escape]);
}
