/**
 * 仓库健康诊断规则集（`src/lib/diagnose.ts`）的单元测试。
 *
 * 覆盖三件事，也正是这类「把散落事实归约成结论」的模块最容易出错的地方：
 *
 *   1. **没问题时是空清单**——不能靠「没有报错」当成没问题，也不能凭空造条目。
 *   2. **单项问题给出对应的严重度**——每条规则判几级是规定的，不是随手写的。
 *   3. **多项时排序稳定**——同一份输入两次跑出的顺序必须逐条相同，界面才不会每次
 *      重排。
 *
 * 另外把几条「不许说谎」的边界单独钉住：`unknown` 不能升级成 `error`、端口探针只在
 * 进程运行时才适用、阈值边界（等于阈值即触发）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CACHE_BIG_BYTES,
  diagText,
  diagnose,
  severityLabel,
  type Diagnostic,
  type RepoDiagInput,
} from "../src/lib/diagnose.ts";
import { tFor, type TFunc } from "../src/lib/i18n.ts";
import type {
  ClearReport,
  EnvironmentReport,
  Freshness,
  InstallPlan,
  RepoDetail,
  WorktreeStatus,
} from "../src/types.ts";

import { at } from "./helpers/definite.ts";

const SLUG = "github.com/a/b";

// --- 事实工厂：默认值代表「一切正常」，测试只覆盖它关心的那一项。 ---------------

const fresh = (state = "fresh"): Freshness => ({
  slug: SLUG,
  state,
  localHead: "aaaaaaa",
  remoteHead: "aaaaaaa",
  checkedAt: 1,
  error: null,
});

const cleanWorktree = (over: Partial<WorktreeStatus> = {}): WorktreeStatus => ({
  hasGit: true,
  branch: "main",
  dirty: 0,
  untracked: 0,
  ahead: 0,
  ...over,
});

const detail = (over: Partial<RepoDetail> = {}): RepoDetail => ({
  slug: SLUG,
  path: "D:/x/b",
  launch: { command: "npm start", cwd: "D:/x/b", userConfirmed: true, kind: "run", steps: [] },
  url: "",
  portBase: 3000,
  venvPath: null,
  stepwise: null,
  terminalChoice: null,
  ideChoice: null,
  pythonChoice: null,
  venvState: "ready",
  venvDir: null,
  branch: null,
  ...over,
});

const healthyEnv = (over: Partial<EnvironmentReport> = {}): EnvironmentReport => ({
  projectRoot: "D:/x",
  git: { path: "C:/git/git.exe", version: "2.4", source: "PATH" },
  rootIsFallback: false,
  localProxy: null,
  resolvedIp: null,
  mirrorEnabled: false,
  ipPinEnabled: false,
  elevated: false,
  linkAdvice: "",
  linkLabel: "",
  hostsHijacked: false,
  hostsRedirectCount: 0,
  hostsBy: null,
  systemProxy: null,
  searchRoute: "bypass",
  downloadRoute: "bypass",
  ...over,
});

const repo = (over: Partial<RepoDiagInput> = {}): RepoDiagInput => ({
  slug: SLUG,
  running: false,
  freshness: fresh(),
  worktree: cleanWorktree(),
  detail: detail(),
  ports: [],
  plan: null,
  cache: null,
  tools: null,
  ...over,
});

/** 只留规则码，断言时才不会被槽位/跳转的细节淹没。 */
const codes = (list: readonly Diagnostic[]): string[] => list.map((d) => d.code);

// ---------------------------------------------------------------------------
// 1. 无问题 → 空清单

test("diagnose: 所有探针正常时返回空清单（不是靠「没报错」当通过）", () => {
  assert.deepEqual(diagnose({ repos: [repo()], env: healthyEnv() }), []);
});

test("diagnose: 完全没有仓库、没有环境时也是空清单", () => {
  assert.deepEqual(diagnose({ repos: [], env: null }), []);
});

test("diagnose: 探针缺席（null）时该规则整条不产生，不当成「没问题」之外的任何结论", () => {
  // freshness / worktree / detail 全为 null：不能凭空报问题，也不能报「正常」。
  const out = diagnose({
    repos: [repo({ freshness: null, worktree: null, detail: null })],
    env: null,
  });
  assert.deepEqual(out, []);
});

// ---------------------------------------------------------------------------
// 2. 单项问题 → 对应严重度

test("diagnose: 工作区脏 → warn，且带出改动条数", () => {
  const out = diagnose({ repos: [repo({ worktree: cleanWorktree({ dirty: 3 }) })], env: null });
  assert.equal(out.length, 1);
  assert.equal(at(out, 0).code, "repo.dirty");
  assert.equal(at(out, 0).severity, "warn");
  assert.deepEqual(at(out, 0).vars, { n: 3 });
});

test("diagnose: 未推送提交 → warn，带出条数", () => {
  const out = diagnose({ repos: [repo({ worktree: cleanWorktree({ ahead: 2 }) })], env: null });
  assert.equal(at(out, 0).code, "repo.unpushed");
  assert.equal(at(out, 0).severity, "warn");
  assert.deepEqual(at(out, 0).vars, { n: 2 });
});

test("diagnose: ahead 为 null（没有上游）不报「未推送」", () => {
  const out = diagnose({ repos: [repo({ worktree: cleanWorktree({ ahead: null }) })], env: null });
  assert.deepEqual(codes(out), []);
});

test("diagnose: 五种同步状态各给对应严重度", () => {
  const of = (state: string) =>
    at(diagnose({ repos: [repo({ freshness: fresh(state) })], env: null }), 0);
  assert.equal(of("no-git").code, "repo.noGit");
  assert.equal(of("no-git").severity, "error");
  assert.equal(of("missing").code, "repo.remoteMissing");
  assert.equal(of("missing").severity, "warn");
  assert.equal(of("behind").code, "repo.behind");
  assert.equal(of("behind").severity, "warn");
  // unknown 只是「问不出来」，绝不能升级成 error。
  assert.equal(of("unknown").code, "repo.remoteUnknown");
  assert.equal(of("unknown").severity, "info");
  // fresh 不报。
  assert.equal(diagnose({ repos: [repo({ freshness: fresh("fresh") })], env: null }).length, 0);
});

test("diagnose: 没有启动命令 → info，跳项目设置", () => {
  const out = diagnose({ repos: [repo({ detail: detail({ launch: null }) })], env: null });
  assert.equal(at(out, 0).code, "repo.noLaunch");
  assert.equal(at(out, 0).severity, "info");
  assert.deepEqual(at(out, 0).jump, { kind: "repoSettings", slug: SLUG });
});

test("diagnose: 虚拟环境失效 → warn；ready 与 nothing 都不报", () => {
  for (const bad of ["missing", "notAVenv", "staleDir", "unrecorded"]) {
    const out = diagnose({ repos: [repo({ detail: detail({ venvState: bad as RepoDetail["venvState"] }) })], env: null });
    assert.equal(out[0]?.code, "repo.venvStale", `state ${bad} should warn`);
    assert.equal(out[0]?.severity, "warn");
  }
  for (const ok of ["ready", "nothing"]) {
    const out = diagnose({ repos: [repo({ detail: detail({ venvState: ok as RepoDetail["venvState"] }) })], env: null });
    assert.deepEqual(codes(out), [], `state ${ok} is not a problem`);
  }
});

test("diagnose: 端口探针只在进程运行时才适用", () => {
  const ports = [{ service: "web", port: 3000, listening: false }];
  // 未运行：不响是常态，不报。
  assert.deepEqual(codes(diagnose({ repos: [repo({ running: false, ports })], env: null })), []);
  // 运行中：应当 warn，并带出端口与服务名。
  const out = diagnose({ repos: [repo({ running: true, ports })], env: null });
  assert.equal(at(out, 0).code, "repo.portDown");
  assert.equal(at(out, 0).severity, "warn");
  assert.deepEqual(at(out, 0).vars, { port: 3000, service: "web" });
});

test("diagnose: 依赖清单 → info；所选管理器不在本机 → warn", () => {
  const plan = (over: Partial<InstallPlan>): InstallPlan => ({
    command: "npm ci",
    evidence: "package-lock.json",
    inspected: ["package.json"],
    ecosystem: "node",
    toolPresent: true,
    toolName: "npm",
    ...over,
  });
  const present = diagnose({ repos: [repo({ plan: plan({}) })], env: null });
  assert.equal(at(present, 0).code, "repo.depsInstall");
  assert.equal(at(present, 0).severity, "info");
  assert.deepEqual(at(present, 0).vars, { manager: "npm" });

  const absent = diagnose({ repos: [repo({ plan: plan({ toolPresent: false }) })], env: null });
  assert.equal(at(absent, 0).code, "repo.toolMissing");
  assert.equal(at(absent, 0).severity, "warn");
  assert.deepEqual(at(absent, 0).vars, { tool: "npm" });
  assert.deepEqual(at(absent, 0).jump, { kind: "appSettings" });
});

test("diagnose: 缓存阈值——等于阈值即触发，低于不触发", () => {
  const cache = (bytes: number): ClearReport => ({
    items: [{ rel: "node_modules", bytes, label: "依赖" }],
    totalBytes: bytes,
    freedBytes: 0,
    removed: [],
    failed: [],
  });
  assert.deepEqual(codes(diagnose({ repos: [repo({ cache: cache(CACHE_BIG_BYTES - 1) })], env: null })), []);
  // 局部名避开模块级 `at`（helpers/definite.ts 的索引断言）——Shadow 合法，但是陷阱。
  const atThreshold = diagnose({ repos: [repo({ cache: cache(CACHE_BIG_BYTES) })], env: null });
  assert.equal(at(atThreshold, 0).code, "repo.cacheLarge");
  assert.equal(at(atThreshold, 0).severity, "info");
  assert.equal(typeof at(atThreshold, 0).vars.size, "string");
});

test("diagnose: 环境级——git 不可用是 error，hosts 被改写是 info", () => {
  const noGit = diagnose({ repos: [repo()], env: healthyEnv({ git: null }) });
  assert.equal(at(noGit, 0).code, "env.noGit");
  assert.equal(at(noGit, 0).severity, "error");
  assert.equal(at(noGit, 0).slug, null);

  const hijacked = diagnose({
    repos: [repo()],
    env: healthyEnv({ hostsHijacked: true, hostsRedirectCount: 3, hostsBy: "Steam++" }),
  });
  assert.equal(at(hijacked, 0).code, "env.hostsHijacked");
  assert.equal(at(hijacked, 0).severity, "info");
});

// ---------------------------------------------------------------------------
// 3. 多项 → 排序稳定

test("diagnose: 多项按「严重度 → 规则码 → slug」排序，且两次结果逐条一致", () => {
  const inputs = {
    repos: [
      repo({
        slug: "github.com/a/z",
        freshness: fresh("behind"), // warn
        worktree: cleanWorktree({ dirty: 1 }), // warn
      }),
      repo({
        slug: "github.com/a/a",
        freshness: fresh("no-git"), // error
        worktree: cleanWorktree({ dirty: 5 }), // warn（与 z 的 repo.dirty 同码，靠 slug 定序）
        detail: detail({ launch: null }), // info
      }),
    ],
    env: healthyEnv({ git: null }), // error（全局）
  };
  const first = diagnose(inputs);
  const second = diagnose(inputs);
  assert.deepEqual(codes(first), codes(second), "同一输入两次必须同序");

  // 严重度分区：先 error，再 warn，最后 info。
  const sev = first.map((d) => d.severity);
  assert.deepEqual(
    sev,
    [...sev].sort((a, b) => ({ error: 0, warn: 1, info: 2 } as const)[a] - ({ error: 0, warn: 1, info: 2 } as const)[b]),
  );
  // 两个 error 里，全局 env.noGit 的 slug 为 null，排在仓库之前。
  assert.equal(at(first, 0).code, "env.noGit");
  assert.equal(at(first, 1).code, "repo.noGit");
  // warn 区里 code 相同者按 slug：repo.dirty 的 z 与 a 都出现，a 在前。
  const dirtySlugs = first.filter((d) => d.code === "repo.dirty").map((d) => d.slug);
  assert.deepEqual(dirtySlugs, ["github.com/a/a", "github.com/a/z"]);
});

// ---------------------------------------------------------------------------
// 4. 结论句/严重度词真的走词表（不是把码或原始值印在屏幕上）

test("diagnose: diagText 从词表取句，槽位被填上", () => {
  const t: TFunc = (key, vars) => tFor("zh-CN", key, vars);
  const dirty = at(diagnose({ repos: [repo({ worktree: cleanWorktree({ dirty: 3 }) })], env: null }), 0);
  assert.equal(diagText(t, dirty), "工作区有 3 处改动未提交，删除或清理会一并带走。");
  // 英文侧要由同一套键解析出非空句子（键集一致性的运行时半边）。
  assert.notEqual(tFor("en", "diagnose.dirty.title", { n: 3 }), "diagnose.dirty.title");
});

test("diagnose: severityLabel 三档都取自词表", () => {
  const t: TFunc = (key, vars) => tFor("zh-CN", key, vars);
  assert.equal(severityLabel(t, "error"), "严重");
  assert.equal(severityLabel(t, "warn"), "警告");
  assert.equal(severityLabel(t, "info"), "提示");
});
