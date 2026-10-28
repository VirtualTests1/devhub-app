/**
 * Round 16, R1-3: the 克隆深度策略 row (设置 → 网络).
 *
 * Three segmented options; the choice must reach the Rust config through
 * save_settings and read back through get_settings — a pressed button alone is
 * not evidence, because the row can paint selected while the write bounced.
 *
 * Whatever the config held before this scenario is restored in `finally`: the
 * setting is real (it changes how the next clone behaves), not scenario state,
 * so a failed run must not leave the user's box on 浅克隆.
 */
import { NAV } from "../nav.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** full is stored as ''/null/'full' depending on the write path — one name here. */
function normStrategy(v) {
  if (v === null || v === undefined || v === "" || v === "full") return "full";
  return v;
}

export default async function (cdp) {
  const out = {};
  let passed = false;
  let restoreFragment = null;

  const readStrategy = () => cdp.evaluate(`
    const s = await window.__TAURI_INTERNALS__.invoke('get_settings');
    return s?.cloneStrategy ?? null;
  `);

  const clickFragment = (needle) => cdp.evaluate(`
    const row = document.querySelector('[data-reg-id="settings-row-clone-strategy"]');
    if (!row) return 'no row';
    const b = [...row.querySelectorAll('button[aria-pressed]')].find((x) =>
      x.textContent.includes(${JSON.stringify(needle)}));
    if (!b) return 'no button ${needle}';
    b.click();
    return 'clicked';
  `);

  const waitFor = async (expected) => {
    let last = null;
    for (let i = 0; i < 10; i++) {
      last = normStrategy(await readStrategy());
      if (last === expected) return last;
      await sleep(400);
    }
    return last;
  };

  const grabRow = () => cdp.evaluate(`
    const row = document.querySelector('[data-reg-id="settings-row-clone-strategy"]');
    if (!row) return null;
    return {
      title: (row.textContent ?? '').replace(/\\s+/g, ' ').slice(0, 80),
      buttons: [...row.querySelectorAll('button[aria-pressed]')].map((b) => ({
        text: b.textContent.trim(),
        pressed: b.getAttribute('aria-pressed') === 'true',
      })),
    };
  `);

  try {
    await cdp.evaluate(NAV + "await gotoSettings(700); await openSettingsPage('网络', 800);");
    out.row = await grabRow();
    out.initial = normStrategy(await readStrategy());
    restoreFragment =
      out.initial === "shallow" ? "浅克隆" : out.initial === "blobless" ? "无 blob" : "完整";

    if (out.row) {
      out.toShallow = await clickFragment("浅克隆");
      out.shallow = await waitFor("shallow");
      out.afterShallow = await grabRow();
      out.toBlobless = await clickFragment("无 blob");
      out.blobless = await waitFor("blobless");
    }

    const rowOk =
      out.row !== null &&
      out.row.buttons.length === 3 &&
      (out.row.title ?? "").includes("克隆深度策略");
    const shallowOk =
      out.toShallow === "clicked" &&
      out.shallow === "shallow" &&
      out.afterShallow?.buttons?.find((b) => b.text.includes("浅克隆"))?.pressed === true &&
      out.afterShallow?.buttons?.find((b) => b.text.includes("无 blob"))?.pressed === false;
    const bloblessOk = out.toBlobless === "clicked" && out.blobless === "blobless";
    passed = rowOk && shallowOk && bloblessOk;
    out.ok = { rowOk, shallowOk, bloblessOk };
  } finally {
    try {
      if (restoreFragment) {
        await clickFragment(restoreFragment);
        out.restored = await waitFor(normStrategy(out.initial));
        out.restoreOk = out.restored === normStrategy(out.initial);
      }
    } catch (e) {
      out.restoreOk = false;
      out.restoreError = String(e?.message ?? e);
    }
  }

  out.consoleErrors = cdp.consoleErrors;
  out.verdict = passed && out.restoreOk !== false ? "PASS" : "FAIL";
  return out;
}
