/**
 * Round 16, O1-2: the three 清理 verbs on 项目设置 → Python 与虚拟环境.
 *
 * Self-contained: the marker's venvPath is seeded here when absent (the fixture
 * only creates the directory), because a scenario that works only when
 * project-settings.mjs ran first is not a test of this panel. Nothing destroys
 * the fixture's venv directory: 彻底删除 only opens its typed confirmation and
 * cancels it, 只清除记录 only drops the record (the directory is asserted still
 * on disk afterwards), and 移入回收站 is asserted but never committed — the move
 * itself is the backend's tested path, and leaving the directory put keeps the
 * next run reproducible.
 */
import path from "node:path";
import fs from "node:fs";
import { NAV } from "../nav.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SLUG = "github.com/testowner/zfixture";

export default async function (cdp) {
  const out = {};
  const fixtures = process.env.DEVHUB_FIXTURE_ROOT ?? path.join(process.cwd(), ".cdpfixtures");
  const venvDir = path.join(fixtures, "venvs", "testowner_zfixture");
  const norm = (p) => (p ? p.replace(/\//g, "\\").toLowerCase().replace(/\\+$/, "") : p);

  await cdp.evaluate(NAV + "await gotoView('projects', 900);");

  out.menu = await cdp.evaluate(`
    const tile = [...document.querySelectorAll('.skin-card')].find((b) =>
      (b.getAttribute('title') ?? '').includes('testowner/zfixture'));
    if (!tile) return 'no tile';
    const r = tile.getBoundingClientRect();
    tile.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true,
      clientX: Math.round(r.left + 20), clientY: Math.round(r.top + 20),
    }));
    await new Promise((s) => setTimeout(s, 400));
    const item = [...document.querySelectorAll('[role=menuitem]')].find((i) =>
      i.textContent.includes('项目设置'));
    if (!item) return 'no menu item';
    item.click();
    await new Promise((s) => setTimeout(s, 900));
    return document.querySelector('[data-reg-id="project-settings-dialog"]') ? 'dialog' : 'no dialog';
  `);
  if (out.menu !== "dialog") {
    out.consoleErrors = cdp.consoleErrors;
    return { ...out, verdict: "FAIL" };
  }

  const readVenv = () => cdp.evaluate(`
    const d = await window.__TAURI_INTERNALS__.invoke('repo_detail', { slug: ${JSON.stringify(SLUG)} });
    return d.venvPath ?? null;
  `);

  // PathInput only commits on Enter: the window is never the foreground window, so
  // focus/blur produce no events (the lesson project-settings.mjs already paid for).
  const seedVenv = async (value) => {
    const ok = await cdp.evaluate(`
      const dlg = document.querySelector('[data-reg-id="project-settings-dialog"]');
      const input = dlg?.querySelector('input[name="venv"]');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      input.focus();
      setter.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((s) => setTimeout(s, 400));
      return true;
    `);
    await sleep(1200);
    return ok;
  };

  out.venvPathBefore = await readVenv();
  if (out.venvPathBefore === null) {
    out.seeded = await seedVenv(venvDir);
    out.venvPathAfterSeed = await readVenv();
  } else {
    out.seeded = "already set";
    out.venvPathAfterSeed = out.venvPathBefore;
  }

  // ---- the verbs block ------------------------------------------------------
  out.verbs = await cdp.evaluate(`
    const dlg = document.querySelector('[data-reg-id="project-settings-dialog"]');
    if (!dlg) return null;
    const b = (t) => [...dlg.querySelectorAll('button')].find((x) => x.textContent.trim() === t) ?? null;
    const toBin = b('移入回收站'), destroy = b('彻底删除'), forget = b('只清除记录');
    return {
      prefix: dlg.textContent.includes('清理：'),
      toBin: toBin ? toBin.disabled : null,
      destroy: destroy ? destroy.disabled : null,
      forget: forget ? forget.disabled : null,
    };
  `);

  // ---- 彻底删除: irreversible for state=ready → typed confirmation ----------
  // The confirm button's disabled state is the contract: disabled while the box
  // is empty, still disabled on text that is not the slug, enabled the moment it
  // matches, and 取消 closes the block with the record untouched. Nothing typed
  // here ever commits.
  out.destroy = await cdp.evaluate(`
    const dlg = document.querySelector('[data-reg-id="project-settings-dialog"]');
    const btn = [...dlg.querySelectorAll('button')].find((x) => x.textContent.trim() === '彻底删除');
    if (!btn || btn.disabled) return 'no enabled 彻底删除';
    btn.click();
    await new Promise((s) => setTimeout(s, 350));
    const label = '输入 ${SLUG} 以确认彻底删除虚拟环境';
    const input = dlg.querySelector('input[aria-label="' + label + '"]');
    if (!input) return 'confirm input missing';
    const wrap = input.parentElement;
    const confirmBtn = [...wrap.querySelectorAll('button')].find((x) => x.textContent.trim() === '确认彻底删除');
    if (!confirmBtn) return 'confirm button missing';
    const disabledEmpty = confirmBtn.disabled;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    const write = async (v) => {
      input.focus();
      setter.call(input, v);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((s) => setTimeout(s, 250));
    };
    await write('wrong-text');
    const disabledWrongText = confirmBtn.disabled;
    await write('${SLUG}');
    const disabledCorrectSlug = confirmBtn.disabled;
    const warning = wrap.querySelector('p')?.textContent ?? '';
    const cancel = [...wrap.querySelectorAll('button')].find((x) => x.textContent.trim() === '取消');
    cancel?.click();
    await new Promise((s) => setTimeout(s, 300));
    const closed = !dlg.querySelector('input[aria-label="' + label + '"]');
    return { disabledEmpty, disabledWrongText, disabledCorrectSlug, closed, warningHasSlug: warning.includes('${SLUG}') };
  `);

  // ---- 只清除记录: record goes, directory stays (checked on disk) -----------
  out.forget = await cdp.evaluate(`
    const dlg = document.querySelector('[data-reg-id="project-settings-dialog"]');
    const btn = [...dlg.querySelectorAll('button')].find((x) => x.textContent.trim() === '只清除记录');
    if (!btn || btn.disabled) return 'no enabled 只清除记录';
    btn.click();
    return 'clicked';
  `);
  for (let i = 0; i < 10 && out.venvPathAfterForget === undefined; i++) {
    const v = await readVenv();
    if (v === null) out.venvPathAfterForget = null;
    else await sleep(400);
    if (i === 9) out.venvPathAfterForget = v;
  }
  // The report line is set in the same continuation that resolves the invoke, so
  // give it a beat after the readback flipped to null — polling the record and
  // reading the note in the same millisecond is a race, not a measurement.
  await sleep(600);
  out.note = await cdp.evaluate(`
    const dlg = document.querySelector('[data-reg-id="project-settings-dialog"]');
    if (!dlg) return null;
    const tone = dlg.querySelector('p.text-success, p.text-warning');
    const alerts = [...dlg.querySelectorAll('[role="alert"]')].map((x) => x.textContent.replace(/\\s+/g, ' ').trim());
    return { toneText: tone?.textContent.replace(/\\s+/g, ' ').trim() ?? null, alerts };
  `);
  out.noteMatches = (out.note?.toneText ?? "").match(
    /已停止跟踪|已清除记录里的虚拟环境路径|虚拟环境已移入回收站|虚拟环境已彻底删除|这个仓库本来就没有记录|删除虚拟环境未完成/,
  )?.[0] ?? null;
  out.dirStillOnDisk = fs.existsSync(path.join(venvDir, "pyvenv.cfg"));

  // ---- restore what was there before ---------------------------------------
  if (out.venvPathBefore !== null) {
    out.restored = await seedVenv(out.venvPathBefore);
    out.venvPathRestored = await readVenv();
  } else {
    out.restored = "was null, stays null";
    out.venvPathRestored = await readVenv();
  }

  await cdp.evaluate(`
    const dlg = document.querySelector('[data-reg-id="project-settings-dialog"]');
    const close = dlg?.querySelector('button[aria-label="关闭"]')
      ?? [...(dlg?.querySelectorAll('button') ?? [])].find((b) => b.querySelector('svg') && b.textContent.trim() === '');
    close?.click();
    await new Promise((s) => setTimeout(s, 400));
  `);

  out.consoleErrors = cdp.consoleErrors;
  const seedOk =
    out.seeded === "already set" ||
    (out.seeded === true && norm(out.venvPathAfterSeed) === norm(venvDir));
  const verbsOk =
    out.verbs?.prefix === true &&
    out.verbs.toBin === false &&
    out.verbs.destroy === false &&
    out.verbs.forget === false;
  const destroyOk =
    typeof out.destroy === "object" &&
    out.destroy.disabledEmpty === true &&
    out.destroy.disabledWrongText === true &&
    out.destroy.disabledCorrectSlug === false &&
    out.destroy.closed === true &&
    out.destroy.warningHasSlug === true;
  const forgetOk =
    out.forget === "clicked" &&
    out.venvPathAfterForget === null &&
    !!out.noteMatches &&
    out.dirStillOnDisk === true;
  const restoreOk =
    out.venvPathBefore === null
      ? out.venvPathRestored === null
      : norm(out.venvPathRestored) === norm(out.venvPathBefore);
  out.ok = { seedOk, verbsOk, destroyOk, forgetOk, restoreOk };
  out.verdict = seedOk && verbsOk && destroyOk && forgetOk && restoreOk ? "PASS" : "FAIL";
  return out;
}
