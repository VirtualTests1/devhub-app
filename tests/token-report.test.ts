/**
 * r18-R3 — the token self-check's wording rules.
 *
 * The rule these pin is the one that matters: `valid === false` must never be phrased as
 * "the token is wrong" when the request simply did not get through. That distinction is
 * the entire difference between a useful line and one that sends a person to regenerate a
 * working credential because a local accelerator broke a TLS handshake
 * (`src-tauri/src/auth.rs:parse_report` is the other half of it).
 *
 * Sentences are produced through `tFor(locale, …)`, i.e. the app's own dictionaries rather
 * than a fixture copy, so a wording change in either locale shows up here as a failing
 * assertion instead of a stale expectation. Key-set parity between the two tables is
 * `tests/i18n.test.ts`'s job; this file checks *selection*.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { describeTokenReport, type TokenReport } from "../src/lib/token-report.ts";
import { DICTIONARIES, tFor, type Locale, type TranslationKey } from "../src/lib/i18n.ts";

const ZH = DICTIONARIES["zh-CN"];
const EN = DICTIONARIES["en"];

const base: TokenReport = {
  valid: false,
  status: null,
  login: null,
  scopes: null,
  expiredScopes: null,
  remaining: null,
  limit: null,
  note: null,
};

/** The real interpolator, plus a log of which keys the sentence reached for. */
function recorder(locale: Locale) {
  const asked: string[] = [];
  const t = (key: TranslationKey, vars?: Record<string, string | number>) => {
    asked.push(key);
    return tFor(locale, key, vars);
  };
  return { t, asked };
}

test("token: 通过的校验说账户、说作用域、说额度", () => {
  const { t, asked } = recorder("zh-CN");
  const line = describeTokenReport(
    { ...base, valid: true, status: 200, login: "octocat", scopes: "repo, user", remaining: 4993, limit: 5000 },
    t,
  );
  assert.ok(line.includes("octocat"), line);
  assert.ok(line.includes("repo, user"), line);
  assert.ok(line.includes("4993/5000"), line);
  assert.ok(!line.includes("没有返回作用域头"), "带了作用域头就不该说没带：" + line);
  assert.ok(asked.includes("settings.page.tokenValidAccount"));
});

test("token: 有效但没有 login 时不编造账户名", () => {
  const { t } = recorder("zh-CN");
  const line = describeTokenReport({ ...base, valid: true, status: 200 }, t);
  assert.equal(line.split(" · ")[0], ZH["settings.page.tokenValid"]);
});

test("token: 401 与「没能问成」是两句话", () => {
  const { t } = recorder("zh-CN");
  const rejected = describeTokenReport({ ...base, status: 401, note: "令牌无效：可能被撤销、过期，或粘贴时少了字符" }, t);
  assert.ok(rejected.includes("HTTP 401"), rejected);
  assert.ok(rejected.includes("令牌无效"), rejected);

  const noAnswer = describeTokenReport({ ...base, note: "读取仓库信息失败: schannel CRYPT_E_NO_REVOCATION_CHECK" }, t);
  assert.ok(noAnswer.includes("没能问成"), noAnswer);
  assert.ok(noAnswer.includes("schannel"), "理由要原样带出来：" + noAnswer);
  assert.ok(!noAnswer.includes("令牌无效"), "没问成不能被写成令牌有问题：" + noAnswer);
  assert.ok(!noAnswer.includes("HTTP"), "没有状态号就不该出现 HTTP 字样：" + noAnswer);
});

test("token: note 缺席时用兜底句，不打印 null 或 undefined", () => {
  for (const locale of ["zh-CN", "en"] as Locale[]) {
    const { t } = recorder(locale);
    for (const line of [describeTokenReport({ ...base, status: 403 }, t), describeTokenReport({ ...base }, t)]) {
      assert.ok(!line.includes("null") && !line.includes("undefined"), line);
      assert.ok(line.includes(DICTIONARIES[locale]["settings.page.tokenUnknown"]!), `${locale}: ${line}`);
    }
  }
});

test("token: 有效但响应没有作用域头时明说，失败时根本不语气作用域", () => {
  const { t } = recorder("zh-CN");
  const okNoScope = describeTokenReport({ ...base, valid: true, status: 200 }, t);
  assert.ok(okNoScope.includes(ZH["settings.page.tokenNoScopes"]!), okNoScope);
  const failed = describeTokenReport({ ...base, status: 401, note: "x" }, t);
  assert.ok(!failed.includes("作用域"), failed);
});

test("token: 额度只在两个数都到位时才报", () => {
  const { t } = recorder("zh-CN");
  const partial = describeTokenReport({ ...base, valid: true, status: 200, remaining: 9 }, t);
  assert.ok(!partial.includes("/"), "半个额度读数会印成 `9/—`：" + partial);
  const full = describeTokenReport({ ...base, valid: true, status: 200, remaining: 9, limit: 60 }, t);
  assert.ok(full.includes("9/60"), full);
});

test("token: 过期作用域只在真有的时候出现", () => {
  const { t } = recorder("zh-CN");
  const withExpired = describeTokenReport({ ...base, valid: true, status: 200, scopes: "repo", expiredScopes: "gist" }, t);
  assert.ok(withExpired.includes("gist"), withExpired);
  const without = describeTokenReport({ ...base, valid: true, status: 200, scopes: "repo" }, t);
  assert.ok(!without.includes("已过期"), without);
});

test("token: 英文外壳里同一组状态不会漏回中文", () => {
  // The fallback chain is `tFor`'s business, but this surface composes seven keys into one
  // sentence, and one missing EN key would show up as Chinese inside an English shell.
  const { t } = recorder("en");
  const samples: TokenReport[] = [
    { ...base, valid: true, status: 200, login: "octocat", scopes: "repo", remaining: 1, limit: 2 },
    { ...base, valid: true, status: 200 },
    { ...base, status: 401, note: "nope" },
    { ...base },
    { ...base, valid: true, status: 200, expiredScopes: "gist" },
  ];
  for (const s of samples) {
    const line = describeTokenReport(s, t);
    assert.ok(!/[一-鿿]/.test(line), `英文句子里出现了中文：${line}`);
    assert.ok(!line.includes("?settings."), `没命中的键会被印出来：${line}`);
  }
  assert.ok(EN["settings.page.tokenVerifyButton"] === "Verify token", EN["settings.page.tokenVerifyButton"]);
});
