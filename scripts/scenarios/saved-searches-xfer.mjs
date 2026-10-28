/**
 * r17-o3-3: 设置页传输分区里能看到「收藏搜索」导出/导入行（承接 n1-xfer）。
 *
 * 这两行是 n1 加进去的；本场景防止以后重构设置页时把它们静默删掉。
 */
export default async function (cdp) {
  const out = {};
  await cdp.evaluate(`
    const nav = [...document.querySelectorAll('.skin-nav')].find((b) => b.textContent.includes('设置'));
    if (nav) nav.click();
    await new Promise((r) => setTimeout(r, 500));
  `);
  out.xfer = await cdp.evaluate(`
    const body = document.body.innerText.replace(/\\s+/g, ' ');
    return {
      hasSettingsExport: body.includes('导出设置'),
      hasSavedSearchExport: body.includes('导出收藏搜索'),
      hasSavedSearchImport: body.includes('导入收藏搜索'),
    };
  `);
  out.verdict =
    out.xfer.hasSavedSearchExport && out.xfer.hasSavedSearchImport ? "PASS" : "FAIL";
  return out;
}
