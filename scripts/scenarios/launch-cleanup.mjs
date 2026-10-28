/**
 * r21 O4-3: the 启动对话框's 「清理与删除」 section
 * (src/dialogs/launch/CleanupSection.tsx).
 *
 * REQUIREMENTS §6 lists this surface as never visually verified — grep for
 * 「清理与删除 / 清理以上 / 以确认删除」 across scripts/scenarios/ was empty —
 * while its backend commands were covered by headless probes only. This drives
 * the real dialog and asserts the two-stage contract on the real DOM:
 *
 *   1. scan first: 扫描缓存 lists exactly what would go (a fake `node_modules`
 *      this scenario plants inside the .cdpfixtures copy of zfixture, so the
 *      list is controlled and contains no real data), with the 清理以上 button
 *      carrying the live count/size and the `.git is never touched` note;
 *   2. clearing removes exactly that fake artefact on disk and reports 已释放;
 *   3. the delete gate: 我要删除… reveals the type-the-slug field, and
 *      确认彻底删除 stays disabled for a wrong slug and only enables for the
 *      exact one. **The scenario never clicks it** — the fixture repository is
 *      never deleted, and the run re-checks the marker file afterwards.
 *      The whole destroy block renders only after a scan (the section's
 *      `scanned && report` branch), so before 扫描缓存 there is no
 *      我要删除… to press — asserted as `openDeleteGate === false` initially.
 *
 * The fake artefact is removed in the `finally`, so a failed run does not leak
 * it into later scenarios either.
 */

import { access, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { NAV } from "../nav.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FIXTURE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.cdpfixtures");
const REPO_DIR = path.join(FIXTURE_ROOT, "testowner_zfixture");
const FAKE_PKG = path.join(REPO_DIR, "node_modules", "fakepkg", "index.js");
const MARKER = path.join(REPO_DIR, ".devhub.json");
const SLUG = "github.com/testowner/zfixture";

const exists = async (p) => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

export default async function (cdp) {
  const out = {};
  let passed = false;

  const SECTION = '[data-reg-id="launch-cleanup-section"]';

  /** One read of the section: stages 1 and 2 plus the delete gate state. */
  const snap = () =>
    cdp.evaluate(`
      const s = document.querySelector('${SECTION}');
      if (!s) return null;
      const buttons = [...s.querySelectorAll('button')];
      const input = s.querySelector('input');
      const items = [...s.querySelectorAll('li')].map((li) => li.textContent.replace(/\\s+/g, ' ').trim().slice(0, 80));
      const confirm = buttons.find((b) => b.textContent.trim() === '确认彻底删除');
      const text = s.textContent.replace(/\\s+/g, ' ');
      return {
        titlePresent: text.includes('清理与删除'),
        scanButton: buttons.some((b) => b.textContent.trim() === '扫描缓存'),
        items,
        clearButton: buttons.map((b) => b.textContent.trim()).find((t) => t.startsWith('清理以上')) ?? null,
        nothingShown: text.includes('没有可清理的缓存'),
        gitNote: text.includes('.git') && text.includes('不会被碰'),
        destroyTitle: text.includes('彻底删除项目'),
        destroyWarning: text.includes('不可恢复'),
        openDeleteGate: buttons.some((b) => b.textContent.trim() === '我要删除…'),
        gateOpen: !!input,
        inputPlaceholder: input ? input.getAttribute('placeholder') : null,
        inputAria: input ? input.getAttribute('aria-label') : null,
        typedValue: input ? input.value : null,
        confirmDisabled: confirm ? confirm.disabled : null,
        cancelButton: buttons.some((b) => b.textContent.trim() === '取消'),
        statusText: (() => {
          const st = [...s.querySelectorAll('div')].find(
            (d) => typeof d.className === 'string' && d.className.includes('bg-success') && d.textContent.trim(),
          );
          return st ? st.textContent.replace(/\\s+/g, ' ').trim().slice(0, 120) : null;
        })(),
        errorText: (() => {
          const er = [...s.querySelectorAll('div')].find(
            (d) => typeof d.className === 'string' && d.className.includes('text-danger') && d.textContent.trim(),
          );
          return er ? er.textContent.replace(/\\s+/g, ' ').trim().slice(0, 160) : null;
        })(),
      };
    `);

  const typeInto = (value) =>
    cdp.evaluate(`
      const s = document.querySelector('${SECTION}');
      const input = s?.querySelector('input');
      if (!input) return 'no input';
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return 'typed';
    `);

  try {
    // --- plant the controlled artefact -------------------------------------
    await mkdir(path.dirname(FAKE_PKG), { recursive: true });
    await writeFile(FAKE_PKG, "module.exports = {};\n", "utf8");
    out.fixturePlanted = await exists(FAKE_PKG);
    out.markerBefore = await exists(MARKER);

    // --- open the 启动对话框 on the fixture tile ---------------------------
    await cdp.evaluate(NAV + "await gotoView('projects', 700);");
    out.tileClick = await cdp.evaluate(`
      const tile = [...document.querySelectorAll('.skin-card')].find((b) =>
        (b.getAttribute('title') ?? '').includes('testowner/zfixture'));
      if (!tile) return 'no tile';
      tile.click();
      return 'clicked';
    `);
    try {
      await cdp.waitFor(`document.querySelector('${SECTION}') !== null`, {
        timeoutMs: 10000,
        label: 'cleanup section reachable in the launch dialog',
      });
      out.sectionFound = true;
    } catch {
      out.sectionFound = false;
    }
    out.initial = await snap();

    // --- stage 1: scan lists the fake artefact -----------------------------
    out.scanClick = await cdp.evaluate(`
      const s = document.querySelector('${SECTION}');
      const b = [...(s?.querySelectorAll('button') ?? [])].find((x) => x.textContent.trim() === '扫描缓存');
      if (!b) return 'no scan button';
      b.click();
      return 'clicked';
    `);
    try {
      await cdp.waitFor(
        `(() => { const s = document.querySelector('${SECTION}'); if (!s) return false;
           return s.querySelectorAll('li').length > 0 || s.textContent.includes('没有可清理的缓存'); })()`,
        { timeoutMs: 8000, label: 'scan result shown' },
      );
      out.scanned = true;
    } catch {
      out.scanned = false;
    }
    out.afterScan = await snap();

    // --- clearing: only the fake node_modules goes, and it really goes -----
    out.clearClick = await cdp.evaluate(`
      const s = document.querySelector('${SECTION}');
      const b = [...(s?.querySelectorAll('button') ?? [])].find((x) => x.textContent.trim().startsWith('清理以上'));
      if (!b) return 'no clear button';
      b.click();
      return 'clicked';
    `);
    if (out.clearClick === "clicked") {
      try {
        await cdp.waitFor(
          `(() => { const s = document.querySelector('${SECTION}');
             return !!s && s.textContent.includes('已释放'); })()`,
          { timeoutMs: 8000, label: '已释放 status after clearing' },
        );
        out.cleared = true;
      } catch {
        out.cleared = false;
      }
    } else {
      out.cleared = false;
    }
    // The disk must agree with the status line — polled from node, not from the page.
    const diskDeadline = Date.now() + 5000;
    while (Date.now() < diskDeadline && (await exists(FAKE_PKG))) await sleep(200);
    out.fakeGoneFromDisk = !(await exists(FAKE_PKG));
    out.afterClear = await snap();

    // --- stage 2: the delete gate needs the exact slug ---------------------
    out.gateClick = await cdp.evaluate(`
      const s = document.querySelector('${SECTION}');
      const b = [...(s?.querySelectorAll('button') ?? [])].find((x) => x.textContent.trim() === '我要删除…');
      if (!b) return 'no gate button';
      b.click();
      return 'clicked';
    `);
    try {
      await cdp.waitFor(
        `(() => { const s = document.querySelector('${SECTION}');
           return !!s && s.querySelector('input[placeholder="${SLUG}"]') !== null; })()`,
        { timeoutMs: 8000, label: 'typed-confirmation field appears' },
      );
      out.gateOpened = true;
    } catch {
      out.gateOpened = false;
    }
    out.gateIdle = await snap();

    out.wrongTyped = await typeInto("definitely-not-the-slug");
    await sleep(250);
    out.afterWrong = await snap();

    out.rightTyped = await typeInto(SLUG);
    await sleep(250);
    out.afterRight = await snap();

    // --- cancel out of the gate, then close the dialog ---------------------
    out.cancelClick = await cdp.evaluate(`
      const s = document.querySelector('${SECTION}');
      const b = [...(s?.querySelectorAll('button') ?? [])].find((x) => x.textContent.trim() === '取消');
      if (!b) return 'no cancel button';
      b.click();
      return 'clicked';
    `);
    await sleep(400);
    out.afterCancel = await snap();

    out.closeClick = await cdp.evaluate(`
      const panel = document.querySelector('[data-reg-id="launch-cleanup-section"]')?.closest('[role="dialog"]');
      const b = panel?.querySelector('button[aria-label="关闭"]');
      if (!b) return 'no close button';
      b.click();
      return 'clicked';
    `);
    try {
      await cdp.waitFor(`document.querySelector('${SECTION}') === null`, {
        timeoutMs: 6000,
        label: 'launch dialog closes',
      });
      out.closed = true;
    } catch {
      out.closed = false;
    }

    // --- the repository itself must have survived all of the above ---------
    out.markerAfter = await exists(MARKER);
    out.repoStillThere = await exists(REPO_DIR);

    const i = out.initial;
    const sc = out.afterScan;
    const cl = out.afterClear;
    const gi = out.gateIdle;
    const wr = out.afterWrong;
    const ri = out.afterRight;
    out.ok = {
      planted: out.fixturePlanted === true && out.markerBefore === true,
      section:
        out.tileClick === "clicked" &&
        out.sectionFound === true &&
        !!i &&
        i.titlePresent &&
        i.scanButton &&
        // 实测（2026-10-19）：删除区整个在 `scanned && report` 分支里，
        // 扫描之前「我要删除…」与「彻底删除项目」都不渲染——先列表、后可删。
        i.openDeleteGate === false &&
        !i.gateOpen &&
        !i.destroyTitle,
      scan:
        out.scanClick === "clicked" &&
        out.scanned === true &&
        !!sc &&
        sc.items.some((t) => t.includes("node_modules")) &&
        !!sc.clearButton &&
        /^清理以上 \d+ 项，释放 /.test(sc.clearButton) &&
        sc.gitNote &&
        sc.destroyTitle &&
        sc.destroyWarning &&
        sc.openDeleteGate === true,
      clear:
        out.clearClick === "clicked" &&
        out.cleared === true &&
        out.fakeGoneFromDisk === true &&
        !!cl &&
        cl.errorText === null,
      gate:
        out.gateClick === "clicked" &&
        out.gateOpened === true &&
        !!gi &&
        gi.gateOpen &&
        gi.inputPlaceholder === SLUG &&
        gi.inputAria === `输入 ${SLUG} 以确认删除` &&
        gi.confirmDisabled === true &&
        !!wr &&
        wr.typedValue === "definitely-not-the-slug" &&
        wr.confirmDisabled === true &&
        !!ri &&
        ri.typedValue === SLUG &&
        ri.confirmDisabled === false,
      cancel: out.cancelClick === "clicked" && !!out.afterCancel && out.afterCancel.gateOpen === false,
      closed: out.closeClick === "clicked" && out.closed === true,
      // The whole point of never clicking 确认彻底删除: the fixture survives.
      noDeletion: out.markerAfter === true && out.repoStillThere === true,
    };
    passed = Object.values(out.ok).every(Boolean);
  } finally {
    // Never leave the fake artefact behind, whatever happened above.
    try {
      await rm(path.join(REPO_DIR, "node_modules"), { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    // Close the dialog if a mid-run failure left it open, so the next scenario
    // in the chain does not start behind a scrim.
    try {
      await cdp.evaluate(`
        const panel = document.querySelector('[data-reg-id="launch-cleanup-section"]')?.closest('[role="dialog"]');
        const b = panel?.querySelector('button[aria-label="关闭"]');
        if (b) b.click();
        return !!b;
      `);
    } catch {
      /* best-effort */
    }
  }

  out.consoleErrors = cdp.consoleErrors;
  out.verdict = passed ? "PASS" : "FAIL";
  return out;
}
