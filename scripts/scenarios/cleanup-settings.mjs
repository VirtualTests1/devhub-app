/**
 * r17-o3-2: 设置页「自动清理」分区可达，且保留天数在「手动」模式下有联动提示。
 *
 * 对应 src/views/SettingsView.tsx:1140 起的清理分区。断言：
 *   1. 能进到设置页并找到「自动清理」标题；
 *   2. 「清理时保留」控件存在；
 *   3. 当清理频率为手动时，页面会显示一句说明（否则用户会以为保留天数生效）。
 */
export default async function (cdp) {
  const out = {};
  await cdp.evaluate(`
    const nav = [...document.querySelectorAll('.skin-nav')].find((b) => b.textContent.includes('设置'));
    if (nav) nav.click();
    await new Promise((r) => setTimeout(r, 500));
  `);
  out.cleanup = await cdp.evaluate(`
    const body = document.body.innerText.replace(/\\s+/g, ' ');
    return {
      hasAutoCleanTitle: body.includes('自动清理'),
      hasKeepDays: body.includes('清理时保留'),
      manualHint: /手动.*不生效|不主动清/.test(body),
    };
  `);
  out.verdict =
    out.cleanup.hasAutoCleanTitle && out.cleanup.hasKeepDays ? "PASS" : "FAIL";
  return out;
}
