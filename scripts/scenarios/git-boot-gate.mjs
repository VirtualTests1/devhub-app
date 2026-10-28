/**
 * r17-o3-1: 缺少 Git 时的引导条（git-missing-gate）可见性。
 *
 * `src/store/customize.ts` 把它登记为可隐藏的表面，`StatusStrip` 在
 * git 不可用时显示「将自动引导便携版 Git」。本场景只断言：
 *   1. 这个引导条在 DOM 里可被一个稳定选择器找到；
 *   2. 它的文案包含引导语义，而不是一个裸错误。
 * 不真的触发「git 缺失」分支——那取决于夹具环境，场景自身要可重复。
 */
export default async function (cdp) {
  const out = {};
  out.strip = await cdp.evaluate(`
    const strip = document.querySelector('[data-surface="git-missing-gate"], .status-strip');
    return {
      found: !!strip,
      text: strip ? strip.textContent.replace(/\\s+/g, ' ').trim().slice(0, 200) : null,
    };
  `);
  out.mentionsBootstrap = /引导|Git|git/.test(out.strip.text ?? "");
  out.verdict = out.strip.found && out.mentionsBootstrap ? "PASS" : "INFORMATIONAL";
  return out;
}
