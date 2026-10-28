/**
 * r18-o4-2: 故障与诊断页的真机取证（r18-n1 落地的界面）。
 *
 * 第一版在真机上跑过一次，两个文本断言互相矛盾（`row=false` 而 12 s 后「marker 还在」），
 * 同时 `buttonCount: 3` 里那个**没有文字的图标按钮**说明行其实是渲染出来的（它就是行内的
 * 「复制这一条」按钮，`aria-label` 才有名字）。结论：错的是断言的写法，不是界面——
 * 我在两个不同时刻各读一次 DOM，中间 store 与 section 各自还会重绘。
 *
 * 这一版每条判断都在**同一次 evaluate 里取一份快照**：DOM 文本、store 的 entries 长度、
 * 行内按钮的 aria-label，一起返回，再据此判定。剩下的三条真信号：
 *   1. 有条目时行文本 + verb + 时间戳都在，行内复制按钮存在；
 *   2. 「复制全部 / 清空」两个动作行的 disabled 状态与条目数一致（0 条则都不可点）；
 *   3. store 清空后同一份快照里 marker 消失（钉的是订阅生效，不是那一下点击）。
 * 破坏性确认对话框不点：`confirmDestructive` 的按钮语义已由 `round11-a11y.mjs` 与
 * `tests/dismiss-focus-return.test.ts` 覆盖，把「弹窗里点哪个」引进来只会让场景随机失败。
 */
import { NAV } from "../nav.mjs";

const MARKER = "r18-o4-2 场景制造的失败";
const VERB = "scenario-probe";

/** One evaluate, one snapshot: DOM text + store state + the row's copy button. */
const SNAPSHOT = (marker, verb) => `
  const { useFailures } = await import('/src/store/failures.ts');
  const entries = useFailures.getState().entries.map((e) => ({ verb: e.verb, text: e.text, count: e.count }));
  const g = document.querySelector('[data-reg-id="settings-group-diagnostics"], [data-surface="settings-group-diagnostics"]');
  const text = g ? g.textContent.replace(/\\s+/g, ' ') : '';
  const labelled = g ? [...g.querySelectorAll('button')].map((b) => (b.getAttribute('aria-label') || b.textContent || '').replace(/\\s+/g, ' ').trim()) : [];
  const btn = (name) => (g ? [...g.querySelectorAll('button')] : []).find((b) => ((b.textContent || '') + (b.getAttribute('aria-label') || '')).includes(name));
  const clearBtn = btn('清空');
  const copyAll = btn('复制全部');
  return {
    groupFound: !!g,
    hasMarker: text.includes('${marker}'),
    hasVerb: text.includes('${verb}'),
    rowCount: g ? g.querySelectorAll('ul li').length : 0,
    storeCount: entries.length,
    storeHasSeed: entries.some((e) => e.verb === '${verb}' && e.text.includes('${marker}')),
    clearPresent: !!clearBtn,
    clearDisabled: clearBtn ? clearBtn.disabled : null,
    copyAllDisabled: copyAll ? copyAll.disabled : null,
    buttons: labelled.slice(0, 6),
  };
`;

export default async function (cdp) {
  const out = {};

  // 1. seed a failure through the app's own module (Vite serves the same URL the app
  //    imports, so this is the same store the UI subscribes to — the snapshot below is
  //    what proves it, rather than my assumption).
  out.seeded = await cdp.evaluate(`
    const mod = await import('/src/lib/report-error.ts');
    const { useFailures } = await import('/src/store/failures.ts');
    const before = useFailures.getState().entries.length;
    mod.reportError(new Error('${MARKER}'), '${VERB}', 'runtime');
    return { before, after: useFailures.getState().entries.length, hasFn: typeof mod.reportError === 'function' };
  `);
  if (!out.seeded.hasFn) {
    out.verdict = "FAIL";
    out.reason = "页面里 import 不到 report-error 模块（Vite dev 路径变了？）";
    return out;
  }

  // 2. open the section and take one consistent snapshot
  await cdp.evaluate(`${NAV}
    await gotoSettings(500);
    await openSettingsPage('故障与诊断', 900);
    return true;
  `);
  const shot = async () => cdp.evaluate(SNAPSHOT(MARKER, VERB));
  out.withSeed = await shot();

  // 3. clear through the store, then the same snapshot must lose the marker
  await cdp.evaluate(`
    const { useFailures } = await import('/src/store/failures.ts');
    useFailures.getState().clear();
    return true;
  `);
  out.afterClear = await shot();

  out.verdict =
    out.withSeed.groupFound &&
    out.withSeed.storeHasSeed &&
    out.withSeed.hasMarker &&
    out.withSeed.hasVerb &&
    out.withSeed.rowCount >= 1 &&
    out.withSeed.clearPresent &&
    out.withSeed.clearDisabled === false &&
    out.afterClear.storeCount === 0 &&
    !out.afterClear.hasMarker &&
    out.afterClear.rowCount === 0 &&
    // 0 条时两个动作行都必须不可点：这是「按钮存在但什么都不做」的反证
    out.afterClear.clearDisabled !== false &&
    out.afterClear.copyAllDisabled !== false
      ? "PASS"
      : "FAIL";
  if (out.verdict === "FAIL") {
    out.reason = `withSeed=${JSON.stringify(out.withSeed)} afterClear=${JSON.stringify(out.afterClear)}`;
  }
  return out;
}
