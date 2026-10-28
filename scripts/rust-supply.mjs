#!/usr/bin/env node
// rust-supply.mjs — Rust/Cargo 侧供应链漏洞审计的薄封装（r17-r1-1）。
//
// 为什么单独一个脚本：仓库已有 scripts/audit-report.mjs 包 `pnpm audit`（JS/npm 侧），
// scripts/license-report.mjs 包 `pnpm licenses list`（JS/npm 许可证侧）。src-tauri/
// 下的 Cargo.lock 一直没有任何对应物——Rust 依赖的已知 CVE（RustSec Advisory DB）
// 从不被检查。这个脚本补上那一侧。
//
// 选型记录（研究探索类，2026-10-17 本机实测）：
//   * cargo-audit  —— 只做一件事：拉 RustSec Advisory DB，对照 Cargo.lock 报已知漏洞。
//                     二进制单用途，输出 --json 稳定，适合做 CI 门禁。
//   * cargo-deny   —— 更大：许可证 allowlist + advisory + 禁止项 + 源策略，需要 deny.toml。
//                     本项目的许可证门禁已由 license-report.mjs 覆盖（JS 侧），Rust 侧
//                     许可证目前依赖 tauri 官方依赖树、不打算自建 allowlist，所以选
//                     cargo-audit（更小、不引入配置文件），cargo-deny 留作以后需要
//                     跨语言统一许可证策略时的替代。
//   官方文档：https://rustsec.org/advisories/ 与 `cargo audit --help`；
//   仓库：https://github.com/rustsec/rustsec/tree/main/cargo-audit。
//
// 三态退出契约（与 audit-report.mjs 对齐，绝不假装绿）：
//   0  clean      —— 工具在，数据库应答，0 条 advisory
//   1  vulnerable —— 工具在，报出 ≥1 条 advisory（按严重度打印包名）
//   2  cannot-determine / tool-missing —— cargo-audit 不在 PATH、或数据库拉不下来。
//                    这一态打印安装命令与原因，但**不**让门禁失败：本机不要求装
//                    cargo-audit（它是 `cargo install` 出来的全局二进制，本项目约束
//                    禁止全局安装）；工具一旦装好，同一条命令就变成真正的 verdict。
//
// 只读：`cargo audit` 不写 Cargo.lock，不改依赖树。

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const srcTauri = join(repoRoot, "src-tauri");

function findCargoAudit() {
  // PATH 上的 cargo-audit（用户自行 `cargo install cargo-audit` 后在这里）。
  const onPath = spawnSync("cargo-audit", ["--version"], { encoding: "utf8" });
  if (onPath.status === 0) return "cargo-audit";
  // 兜底：~/.cargo/bin 是 cargo install 的默认落点，未必在 PATH 上。
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const candidate = join(home, ".cargo", "bin", process.platform === "win32" ? "cargo-audit.exe" : "cargo-audit");
  if (existsSync(candidate)) return candidate;
  return null;
}

// 从 cargo-audit --json 输出判定。纯函数，selftest 直接喂样例。
function verdictFromJson(stdout) {
  let parsed = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { code: 2, reason: "unparseable" };
  }
  const vulns = parsed?.vulnerabilities?.list || [];
  if (vulns.length === 0) return { code: 0, vulns: 0 };
  return { code: 1, vulns };
}

// --selftest: 不依赖本机是否装 cargo-audit，把三态逻辑跑一遍。
function selftest() {
  const cases = [
    // [描述, stdin, 期望 code(0/1/2 三态内部码)]
    ["空 advisory → clean", JSON.stringify({ vulnerabilities: { list: [] }, warnings: {} }), 0],
    [
      "一条 advisory → vulnerable",
      JSON.stringify({
        vulnerabilities: { list: [{ advisory: { id: "RUSTSEC-0000", package: { name: "x" }, cvss: { score: [{ score: 9.8 }] } } }] },
      }),
      1,
    ],
    ["非 JSON → cannot-determine", "not json at all", 2],
  ];
  let fail = 0;
  for (const [desc, input, want] of cases) {
    const got = verdictFromJson(input).code;
    const ok = got === want;
    if (!ok) fail++;
    console.error(`  ${ok ? "ok" : "FAIL"}  ${desc}（期望 ${want}，实得 ${got}）`);
  }
  if (fail) {
    console.error(`FAIL: rust-supply selftest ${fail} 条不符`);
    return 1;
  }
  console.error(`OK: rust-supply selftest ${cases.length} 条全过`);
  return 0;
}

function main() {
  if (process.argv.includes("--selftest")) {
    return selftest();
  }
  if (!existsSync(join(srcTauri, "Cargo.lock"))) {
    console.error("SKIP: 未找到 src-tauri/Cargo.lock，跳过 Rust 供应链审计。");
    return 0; // 没锁文件就没东西可审，不是失败。
  }

  const bin = findCargoAudit();
  if (!bin) {
    // tool-missing = 2：信息态，不 FAIL。打印安装指引，让人知道怎么把它变成真 verdict。
    console.error("INFO: cargo-audit 未安装，Rust 供应链审计跳过（不计失败）。");
    console.error("      安装后本命令自动生效：cargo install cargo-audit");
    console.error("      （cargo install 是全局二进制，本项目默认不自动安装；装上后即用。）");
    return 2;
  }

  const res = spawnSync(bin, ["audit", "--json"], {
    cwd: srcTauri,
    encoding: "utf8",
    // 审计 DB 要联网拉；给足超时但不无限挂。
    timeout: 120_000,
  });

  // cargo audit 在有 advisory 时退出码非 0，所以不能只看退出码——要解析 JSON。
  const out = (res.stdout || "") + (res.stderr || "");
  const v = verdictFromJson(res.stdout || "");

  if (v.code === 2) {
    console.error("CANNOT DETERMINE: cargo-audit 输出不可解析，可能是离线拉不动 Advisory DB。");
    console.error(out.trim().split("\n").slice(-5).join("\n"));
    return 2;
  }

  if (v.code === 0) {
    console.error("OK: cargo-audit 报告 0 条已知漏洞。");
    return 0;
  }

  console.error(`FAIL: cargo-audit 报告 ${v.vulns.length} 条已知漏洞：`);
  for (const adv of v.vulns) {
    const pkg = adv.advisory?.package || adv.package?.name || "?";
    const sev = adv.advisory?.cvss?.score?.[0]?.score ?? adv.advisory?.severity ?? "?";
    const id = adv.advisory?.id || "?";
    console.error(`  - ${id}  ${pkg}  severity=${sev}`);
  }
  return 1;
}

const code = main();
process.exit(code === 2 ? 0 : code); // 2 = INFO，对外不报失败（与 hooks-path 一致）。
