/**
 * Launch-command risk wiring (r27-O3).
 *
 * The classifier itself is Rust (`launch_risk::tests`); this file pins the two
 * front-end halves: localized sentences for the stable codes, and the source
 * shape that makes a danger hit ask once more before launch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { hasDanger, riskListText, riskText } from "../src/lib/launch-risk.ts";
import { tFor } from "../src/lib/i18n.ts";

const DIALOG = readFileSync("src/dialogs/LaunchDialog.tsx", "utf8");
const EVIDENCE = readFileSync("src/dialogs/launch/DetectionEvidence.tsx", "utf8");

test("riskText: every backend code has a localized sentence in both locales", () => {
  const codes = [
    "pipe-to-shell",
    "encoded-command",
    "download-execute",
    "root-delete",
    "elevation",
    "insecure-tls",
    "world-writable",
  ];
  for (const code of codes) {
    const zh = riskText(tFor.bind(null, "zh-CN"), code);
    const en = riskText(tFor.bind(null, "en"), code);
    assert.ok(zh.length > 0 && !/[\u4e00-\u9fff]/.test(en), `${code} en=${en}`);
    assert.notEqual(zh, en, `${code} must be a real translation, not a zh fallback`);
  }
  // A code this build predates degrades to a sentence, never the raw identifier.
  assert.equal(
    riskText(tFor.bind(null, "zh-CN"), "future-code"),
    "未识别的风险模式",
  );
});

test("hasDanger ignores warn; riskListText dedups and uses the locale separator", () => {
  assert.equal(hasDanger([{ code: "elevation", severity: "warn" }]), false);
  assert.equal(hasDanger([{ code: "root-delete", severity: "danger" }]), true);
  const hits = [
    { code: "pipe-to-shell", severity: "danger" as const },
    { code: "pipe-to-shell", severity: "danger" as const },
    { code: "elevation", severity: "warn" as const },
  ];
  assert.equal(
    riskListText(tFor.bind(null, "zh-CN"), hits),
    "下载内容直接管道给 shell 执行、请求管理员/提权",
  );
  assert.equal(
    riskListText(tFor.bind(null, "en"), hits),
    "Downloads content and pipes it into a shell, Requests administrator/elevated privileges",
  );
});

test("LaunchDialog: live badges + a second confirmation on every launch path", () => {
  assert.match(DIALOG, /invoke<RiskHit\[\]\[\]>\("assess_launch_commands", \{ commands \}\)/);
  assert.match(DIALOG, /const guardRisk = async \(commands: string\[\]\): Promise<boolean>/);
  assert.match(DIALOG, /if \(!\(await guardRisk\(steps\.map\(\(s\) => s\.command\)\)\)\) return;/);
  assert.match(DIALOG, /if \(!\(await guardRisk\(\[steps\[index\]\?\.command \?\? ""\]\)\)\) return;/);
  assert.match(DIALOG, /if \(!\(await guardRisk\(\[c\.command\]\)\)\) return;/);
  assert.match(DIALOG, /t\("launch\.risk\.confirm", \{ list: riskListText\(t, danger\) \}\)/);
  assert.match(DIALOG, /stepRisks\.some\(\(h\) => h\.length > 0\)/);
});

test("DetectionEvidence: a candidate carries its own risk sentence", () => {
  assert.match(EVIDENCE, /report\.risks\?\.find\(\(r\) => r\.command === c\.command\)\?\.hits \?\? \[\]/);
  assert.match(EVIDENCE, /hasDanger\(hits\)/);
  assert.match(EVIDENCE, /riskText\(t, h\.code\)/);
});

test("词条成对：风险标题与确认按钮", () => {
  assert.equal(tFor("zh-CN", "launch.risk.title"), "检测到高风险启动命令");
  assert.equal(tFor("en", "launch.risk.title"), "High-risk launch command detected");
  assert.equal(tFor("zh-CN", "launch.risk.confirmOk"), "仍然启动");
  assert.equal(tFor("en", "launch.risk.confirmOk"), "Launch anyway");
});
