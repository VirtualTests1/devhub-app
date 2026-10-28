/**
 * Round 16, N1-2: the 工作树 panel inside 项目设置 — mounted by the r16 tail fix
 * (the panel existed since 5201121 but nothing rendered it, so nothing had ever
 * seen it work or fail).
 *
 * The fixture's `.git` is an empty directory, so git cannot answer: the panel
 * must SAY that (error line / warning line / honest count) instead of pretending,
 * and the create form only exists when git answered at all (`list.hasGit`).
 * Everything here therefore branches on what the panel honestly reports; nothing
 * is created on disk — the worst case of the create leg is git's own refusal,
 * which is exactly the error line being asserted.
 */
import path from "node:path";
import fs from "node:fs";
import { NAV } from "../nav.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const grabJs = `
  const p = document.querySelector('[data-reg-id="project-row-worktrees"]');
  if (!p) return null;
  const alert = [...p.querySelectorAll('[role="alert"]')].map((x) => x.textContent.trim()).join(' | ') || null;
  const warning = p.querySelector('p.text-warning')?.textContent.trim() ?? null;
  const hint = p.textContent ?? '';
  return {
    title: hint.includes('工作树'),
    refresh: [...p.querySelectorAll('button')].some((b) => b.textContent.trim() === '刷新'),
    alert,
    warning,
    count: (hint.match(/(\\d+) 个工作树/) ?? [])[1] ?? null,
    loading: hint.includes('正在问 git…'),
    unread: hint.includes('还没有读到列表'),
    createForm: !!p.querySelector('[data-reg-id="project-row-worktrees-add"]'),
    hasGit: !!p.querySelector('input[aria-label="工作树的分支名"]'),
  };
`;

export default async function (cdp) {
  const out = {};
  const fixtures = process.env.DEVHUB_FIXTURE_ROOT ?? path.join(process.cwd(), ".cdpfixtures");
  const worktreesRoot = path.join(fixtures, "_worktrees");

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
    return document.querySelector('[data-reg-id="project-row-worktrees"]') ? 'panel' : 'no panel';
  `);
  if (out.menu !== "panel") {
    out.consoleErrors = cdp.consoleErrors;
    return { ...out, verdict: "FAIL" };
  }

  // Wait for one of the three terminal truth-lines (error / no-git warning /
  // count), never for a fixed sleep: "正在问 git…" is the only forbidden state.
  // The window covers the backend's own 60s WORKTREE_OP_TIMEOUT deadline
  // (gitwt.rs:65) plus margin — a poll that gives up before the deadline would
  // measure the poll, not the panel.
  const t0 = Date.now();
  for (let i = 0; i < 175; i++) {
    out.initial = await cdp.evaluate(grabJs);
    if (out.initial && (out.initial.alert || out.initial.warning || out.initial.count)) break;
    await sleep(400);
  }
  out.initialPolls = Math.max(1, Math.round((Date.now() - t0) / 400));
  out.initialStuck = out.initial && !(out.initial.alert || out.initial.warning || out.initial.count)
    ? await cdp.evaluate(`document.querySelector('[data-reg-id="project-row-worktrees"]')?.textContent.replace(/\\s+/g, ' ').trim() ?? null`)
    : null;
  out.refreshed = await cdp.evaluate(`
    const p = document.querySelector('[data-reg-id="project-row-worktrees"]');
    const b = [...p.querySelectorAll('button')].find((x) => x.textContent.trim() === '刷新');
    if (!b || b.disabled) return 'no enabled 刷新';
    b.click();
    return 'clicked';
  `);
  const t1 = Date.now();
  for (let i = 0; i < 165; i++) {
    out.afterRefresh = await cdp.evaluate(grabJs);
    if (out.afterRefresh && (out.afterRefresh.alert || out.afterRefresh.warning || out.afterRefresh.count)) break;
    await sleep(400);
  }
  out.refreshPolls = Math.max(1, Math.round((Date.now() - t1) / 400));

  // ---- create leg: only exists when git actually answered --------------------
  if (out.initial?.hasGit) {
    out.emptyBranch = await cdp.evaluate(`
      const p = document.querySelector('[data-reg-id="project-row-worktrees"]');
      const create = [...p.querySelectorAll('button')].find((x) => x.textContent.trim() === '创建');
      const input = p.querySelector('input[aria-label="工作树的分支名"]');
      const disabledEmpty = create?.disabled ?? null;
      input.focus();
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((s) => setTimeout(s, 400));
      const emptyErr = [...p.querySelectorAll('[role="alert"]')].some((x) =>
        x.textContent.includes('先填一个分支名'));
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      input.focus();
      setter.call(input, 'r16probe');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((s) => setTimeout(s, 300));
      const create2 = [...p.querySelectorAll('button')].find((x) => x.textContent.trim() === '创建');
      return { disabledEmpty, emptyErr, disabledTyped: create2?.disabled ?? null };
    `);
    if (out.emptyBranch?.disabledTyped === false) {
      out.created = await cdp.evaluate(`
        const p = document.querySelector('[data-reg-id="project-row-worktrees"]');
        [...p.querySelectorAll('button')].find((x) => x.textContent.trim() === '创建').click();
        return 'clicked';
      `);
      for (let i = 0; i < 20; i++) {
        out.createResult = await cdp.evaluate(`
          const p = document.querySelector('[data-reg-id="project-row-worktrees"]');
          const alerts = [...p.querySelectorAll('[role="alert"]')].map((x) => x.textContent).join(' | ');
          const note = [...p.querySelectorAll('p')].map((x) => x.textContent).find((t) =>
            t.includes('已创建')) ?? null;
          return { refused: alerts.includes('创建工作树失败'), note };
        `);
        if (out.createResult.refused || out.createResult.note) break;
        await sleep(500);
      }
      let probeHits = [];
      try {
        probeHits = fs.readdirSync(worktreesRoot, { recursive: true })
          .map(String)
          .filter((entry) => entry.includes("r16probe"));
      } catch {
        probeHits = [];
      }
      out.probeOnDisk = probeHits;
    }
  }

  await cdp.evaluate(`
    const dlg = document.querySelector('[data-reg-id="project-settings-dialog"]')
      ?? [...document.querySelectorAll('.fixed.inset-0')].pop();
    const close = dlg?.querySelector('button[aria-label="关闭"]')
      ?? [...(dlg?.querySelectorAll('button') ?? [])].find((b) => b.querySelector('svg') && b.textContent.trim() === '');
    close?.click();
    await new Promise((s) => setTimeout(s, 400));
  `);

  out.consoleErrors = cdp.consoleErrors;
  const truth = (g) => (g ? g.alert || g.warning || g.count !== null : false);
  const mountedOk = out.menu === "panel" && out.initial?.title === true && out.initial?.refresh === true;
  const initialTruthOk = truth(out.initial);
  const refreshTruthOk = out.refreshed === "clicked" && truth(out.afterRefresh);
  const createLegOk = out.initial?.hasGit
    ? out.emptyBranch?.disabledEmpty === true &&
      out.emptyBranch?.emptyErr === true &&
      out.emptyBranch?.disabledTyped === false &&
      out.createResult?.refused === true &&
      (out.probeOnDisk?.length ?? 1) === 0
    : true;
  out.ok = { mountedOk, initialTruthOk, refreshTruthOk, createLegOk, hasGit: out.initial?.hasGit ?? null };
  out.verdict = mountedOk && initialTruthOk && refreshTruthOk && createLegOk ? "PASS" : "FAIL";
  return out;
}
