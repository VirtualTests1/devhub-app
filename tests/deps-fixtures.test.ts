/**
 * 真机 fixture 接进 `pnpm test`（r21-R2-3 的落地物）。
 *
 * 两侧同源：`src-tauri/src/deps.rs` 的解析器测试用 `include_str!` 读
 * `tests/fixtures/deps/` 里的同一份真机 stdout（来源、脱敏与前后读数记录在
 * docs/deps-ecosystems.md §6/§7）。Rust 侧验证「解析器读得对」；这里验证三件
 * 纯 Rust 覆盖不到的事：
 *
 *   1. 六份底稿还在、还是各自生态的形状（整理/迁移弄坏文件先红在这里）；
 *   2. 脱敏没有回退——真机原件带本机盘符，任何一份 fixture 再出现机器路径就红；
 *   3. 文档与代码的接线：deps-ecosystems.md 无 TBD 残留、矩阵仍引用每一份
 *      fixture，deps.rs 真的 `include_str!` 了每一份数（落点被单侧改动即红）。
 *
 * 不跑 cargo：本仓约定 `pnpm test` 在没有 Rust 工具链的机器上也必须全绿
 * （scripts/test-rust.ps1 头注与 tests/checkers.test.ts 的 no-cargo 约定），
 * Rust 侧由 `pnpm test:rust` 单独执行。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const FIXTURES = join(ROOT, "tests", "fixtures", "deps");
const DEPS_RS = join(ROOT, "src-tauri", "src", "deps.rs");

/** §7.1 的清单在此处的镜像：改了 fixture 集合，两边必须同时改。 */
const EXPECTED = [
  "cargo-outdated.json",
  "npm-outdated.json",
  "pip-outdated.json",
  "pnpm-outdated.json",
  "uv-outdated.json",
  "yarn-outdated.jsonl",
];

const read = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

interface NpmRow {
  current: string;
  wanted: string;
  latest: string;
  [extra: string]: unknown;
}

interface CargoRow {
  name: string;
  project: string;
  compat: string;
  latest: string;
  kind: string;
  platform: unknown;
}

interface CargoOut {
  crate_name: string;
  dependencies: CargoRow[];
}

interface YarnTable {
  head: string[];
  body: string[][];
}

interface YarnLine {
  type: string;
  data?: YarnTable | string;
}

test("deps fixtures：六份真机底稿一份不少、一份不多", () => {
  const files = readdirSync(FIXTURES).sort();
  assert.deepEqual(files, [...EXPECTED].sort(), "fixture 集合与 docs/deps-ecosystems.md §7.1 清单必须一致");
});

test("deps fixtures：npm/pnpm 是以包名为键的 map，12 条，三版本字段齐全", () => {
  for (const file of ["npm-outdated.json", "pnpm-outdated.json"]) {
    const rows = JSON.parse(read(file)) as Record<string, NpmRow>;
    const keys = Object.keys(rows);
    assert.equal(keys.length, 12, `${file}: 真机 12 条`);
    for (const key of keys) {
      const row = rows[key];
      assert.ok(row, `${file}: ${key} 行缺失`);
      assert.equal(typeof row.current, "string", `${file}: ${key}.current`);
      assert.equal(typeof row.wanted, "string", `${file}: ${key}.wanted`);
      assert.equal(typeof row.latest, "string", `${file}: ${key}.latest`);
    }
  }
  // npm 的 wanted 是 range 内最新（eslint 卡 9.39.4、latest 10.13.0），
  // pnpm 的 wanted 遵守 lockfile（= current）——同一仓两种读数，形状差异就在这里。
  const npm = JSON.parse(read("npm-outdated.json")) as Record<string, NpmRow>;
  const eslint = npm["eslint"];
  assert.ok(eslint, "npm 真机输出含 eslint");
  assert.equal(eslint.current, "9.39.4");
  assert.equal(eslint.latest, "10.13.0");
  const pnpm = JSON.parse(read("pnpm-outdated.json")) as Record<string, NpmRow>;
  const api = pnpm["@tauri-apps/api"];
  assert.ok(api, "pnpm 真机输出含 @tauri-apps/api");
  assert.equal(api.wanted, api.current, "pnpm 的 wanted = lockfile 版本");
  assert.equal(api.latest, "2.12.4");
});

test("deps fixtures：yarn 是 JSON-lines（info 图例 + table），四列表头齐全", () => {
  const lines = read("yarn-outdated.jsonl")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "");
  assert.equal(lines.length, 2, "真机两行：1 info + 1 table");
  const parsed = lines.map((l, i) => {
    try {
      return JSON.parse(l) as YarnLine;
    } catch {
      throw new Error(`第 ${i + 1} 行不是合法 JSON —— fixture 被改坏`);
    }
  });
  const [info, table] = parsed;
  assert.ok(info && table, "两行都在");
  assert.equal(info.type, "info");
  assert.equal(table.type, "table");
  const data = table.data;
  assert.ok(data, "table 行有 data");
  if (typeof data === "string") {
    assert.fail("table 行的 data 是对象，不是字符串");
  }
  for (const col of ["Package", "Current", "Wanted", "Latest"]) {
    assert.ok(data.head.includes(col), `表头缺 ${col}`);
  }
  assert.equal(data.body.length, 1, "真机 table 里 1 行过期（ms）");
  const first = data.body[0];
  assert.ok(first, "table 首行");
  assert.equal(first[0], "ms");
  assert.equal(first[1], "0.7.3");
  assert.equal(first[3], "2.1.3");
});

test("deps fixtures：uv/pip 是数组形状，条数与真机读数一致（1 / 0）", () => {
  const uv = JSON.parse(read("uv-outdated.json")) as {
    name: string;
    version: string;
    latest_version: string;
    latest_filetype: string;
  }[];
  assert.equal(uv.length, 1, "uv 真机 1 条");
  const row = uv[0];
  assert.ok(row, "uv 首条");
  assert.equal(row.name, "requests");
  assert.equal(row.version, "2.31.0");
  assert.equal(row.latest_version, "2.34.2");
  const pip = JSON.parse(read("pip-outdated.json")) as unknown;
  assert.ok(Array.isArray(pip), "pip 的输出是数组");
  assert.equal(pip.length, 0, "pip 真机 0 条（系统包全最新，§6/§7.1）");
});

test("deps fixtures：cargo 是单对象 398 行，字段集合只有一种", () => {
  const out = JSON.parse(read("cargo-outdated.json")) as CargoOut;
  assert.equal(out.crate_name, "devhub-app");
  assert.equal(out.dependencies.length, 398, "真机 398 行");
  const keyset = new Set(
    out.dependencies.map((r) => Object.keys(r).sort().join(",")),
  );
  assert.deepEqual(
    [...keyset],
    ["compat,kind,latest,name,platform,project"],
    "真机全树只有一种行形状",
  );
  const removed = out.dependencies.filter((r) => r.latest === "Removed");
  assert.equal(removed.length, 100, "100 行已撤 crate —— 解析器必须跳过（§7.2：398 − 100 = 298）");
  const first = out.dependencies[0];
  assert.ok(first, "首行在");
  assert.equal(first.name, "android_system_properties->libc");
  assert.equal(first.project, "0.2.189");
  assert.equal(first.latest, "0.2.191");
});

test("deps fixtures：脱敏闸门——没有一份 fixture 带本机盘符或用户目录", () => {
  // 真机原件的 location 带 `D:\…`；脱敏后这组正则必须永远数不到。
  // `(?!)` 排除 `https://`——URL 的冒号后也是斜杠，但那是网络地址不是盘符。
  const drivePath = /[A-Za-z]:[\\/](?!\/)/;
  const userDir = /[\\/](?:Users|home)[\\/]/;
  for (const file of EXPECTED) {
    const text = read(file);
    assert.ok(!drivePath.test(text), `${file}: 出现本机盘符路径 —— 脱敏回退`);
    assert.ok(!userDir.test(text), `${file}: 出现用户目录路径 —— 脱敏回退`);
  }
});

test("deps fixtures：deps.rs include_str 了每一份数——两侧同源的接线", () => {
  const depsRs = readFileSync(DEPS_RS, "utf8");
  for (const file of EXPECTED) {
    assert.ok(
      depsRs.includes(`tests/fixtures/deps/${file}`),
      `deps.rs 未引用 ${file} —— 落点被单侧改动，两侧不再同源`,
    );
  }
});
