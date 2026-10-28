/**
 * `src/lib/netdiag.ts` — 网络诊断规则（r18 N2）。
 *
 * 钉三件事：规则的触发条件（按码断言，不按文案）、「没发现 ≠ 问题」的
 * 分级纪律（只有解析/钉死两条 warn），以及排序的确定性（同一输入两次
 * 跑出的顺序逐条相同）。句子的 zh 文案在这里也各点一次名——它们真正的
 * 逐字节 pin 在 `tests/i18n.test.ts` 的 5j 段，这里只证明码能走到句子。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { diagnoseNetwork, netDiagText } from "../src/lib/netdiag.ts";
import { tFor, type TFunc } from "../src/lib/i18n.ts";
import type { EnvironmentReport } from "../src/types.ts";

import { at } from "./helpers/definite.ts";

const zh: TFunc = (key, vars) => tFor("zh-CN", key, vars);

/** 健康基线：代理可用、DNS 有共识、无改写、无镜像、标准权限。 */
function env(over: Partial<EnvironmentReport> = {}): EnvironmentReport {
  return {
    projectRoot: "D:\\x",
    git: null,
    rootIsFallback: false,
    localProxy: "http://127.0.0.1:7890",
    resolvedIp: "20.205.243.166",
    mirrorEnabled: false,
    ipPinEnabled: true,
    elevated: false,
    linkAdvice: "直连可用",
    linkLabel: "直连",
    hostsHijacked: false,
    hostsRedirectCount: 0,
    hostsBy: null,
    systemProxy: null,
    searchRoute: "bypass",
    downloadRoute: "bypass",
    ...over,
  };
}

const codes = (list: ReturnType<typeof diagnoseNetwork>) => list.map((i) => i.code);

test("netdiag: 探针失败（null）返回空清单——「问不出来」不是「没问题」", () => {
  // 空清单在这里的含义是「没有可报的结论」；对话框用 probeFailed 状态把
  // 「取不到」画成另一张脸，两者绝不合并。
  assert.deepEqual(diagnoseNetwork(null), []);
});

test("netdiag: 健康的环境报告没有任何结论", () => {
  assert.deepEqual(diagnoseNetwork(env()), []);
});

test("netdiag: hosts 改写是 info，认得出改写者走 By 变体", () => {
  const plain = at(diagnoseNetwork(env({ hostsHijacked: true, hostsRedirectCount: 3 })), 0);
  assert.equal(plain.code, "net.hostsHijacked");
  assert.equal(plain.severity, "info", "自动绕过已经生效，这不是让用户动手的事");
  assert.deepEqual(plain.vars, { n: 3, by: "" });
  assert.equal(
    netDiagText(zh, plain),
    "hosts 把 GitHub 域名指向了本机（3 条）：搜索会按当前策略自动绕过，通常无需处理。",
  );

  const named = at(
    diagnoseNetwork(
      env({ hostsHijacked: true, hostsRedirectCount: 2, hostsBy: "Steam++" }),
    ),
    0,
  );
  assert.equal(
    netDiagText(zh, named),
    "hosts 把 GitHub 域名指向了本机（2 条，多半来自 Steam++）：搜索会按当前策略自动绕过，通常无需处理。",
  );
});

test("netdiag: 解析不到地址时，钉死开着报「绕过不可用」，否则报解析未一致", () => {
  const pinned = diagnoseNetwork(env({ resolvedIp: null, ipPinEnabled: true }));
  assert.deepEqual(codes(pinned), ["net.pinUnviable"]);
  assert.equal(at(pinned, 0).severity, "warn", "这条真的会改变下载走得通哪条路");

  const unpinned = diagnoseNetwork(env({ resolvedIp: null, ipPinEnabled: false }));
  assert.deepEqual(codes(unpinned), ["net.unresolvedDns"]);
  assert.equal(at(unpinned, 0).severity, "warn");
});

test("netdiag: 代理未发现是 info；找到代理就不再提", () => {
  const missing = at(diagnoseNetwork(env({ localProxy: null })), 0);
  assert.equal(missing.code, "net.proxyNotFound");
  assert.equal(missing.severity, "info", "hosts 加速模式下代理缺席是常态，不是警告");
  assert.deepEqual(diagnoseNetwork(env({ localProxy: "http://127.0.0.1:10809" })), []);
});

test("netdiag: 镜像与提权各报一条 info", () => {
  assert.deepEqual(codes(diagnoseNetwork(env({ mirrorEnabled: true, elevated: true }))), [
    "net.elevated",
    "net.mirrorOn",
  ]);
});

test("netdiag: 排序固定——warn 在前，同severity 按码字母序", () => {
  const hostile = {
    resolvedIp: null,
    ipPinEnabled: false,
    hostsHijacked: true,
    hostsRedirectCount: 1,
    localProxy: null,
    mirrorEnabled: true,
  } as const;
  const mixed = diagnoseNetwork(env(hostile));
  assert.deepEqual(codes(mixed), [
    "net.unresolvedDns",
    "net.hostsHijacked",
    "net.mirrorOn",
    "net.proxyNotFound",
  ]);
  // 全键比较、不赌 sort 稳定性：两次运行必须逐字段相同。
  assert.deepEqual(mixed, diagnoseNetwork(env(hostile)));
});

test("netdiag: 每条码都能走到一句中文（默认语言的句子点名）", () => {
  const cases: [Parameters<typeof diagnoseNetwork>[0], string][] = [
    [env({ resolvedIp: null, ipPinEnabled: true }), "IP 钉死已开启，但本次没有拿到一致的公网地址——这条绕过路径暂时不可用。"],
    [env({ resolvedIp: null, ipPinEnabled: false }), "多个公共 DNS 未对 github.com 达成一致，本次没有采用任何解析结果（防投毒策略）。"],
    [env({ localProxy: null }), "未发现本地代理。没发现不等于没有加速——hosts 改写请看事实区。"],
    [env({ mirrorEnabled: true }), "第三方镜像已启用：代码会经由镜像下载。"],
    [env({ elevated: true }), "应用以管理员权限运行——它并不需要提权，请检查启动方式。"],
  ];
  for (const [input, sentence] of cases) {
    const issue = at(diagnoseNetwork(input), 0);
    assert.equal(netDiagText(zh, issue), sentence);
  }
  // en 一侧只抽一条证明语言行跟随（逐字节钉在 5j 段）。
  const pin = at(diagnoseNetwork(env({ resolvedIp: null, ipPinEnabled: true })), 0);
  const en: TFunc = (key, vars) => tFor("en", key, vars);
  assert.match(netDiagText(en, pin), /IP pinning is on/);
});
