/**
 * The stdio MCP server pinned as the wire contract it is.
 *
 * WHY THIS FILE HAS TO SPAWN A CHILD PROCESS. `scripts/mcp-devhub.mjs` is the one piece of
 * DevHub that external agents reach, and nothing else in this repository can reach it: the
 * app's own commands are `#[tauri::command]`s callable only from inside a running webview
 * (`src-tauri/src/lib.rs`, the `generate_handler!` list), so there is no import boundary to
 * test through. The contract under test is therefore literally the byte stream — one
 * newline-delimited JSON-RPC message per line in, one per line out — which means the only
 * honest test drives a real child over real pipes.
 *
 * Everything here is offline and deterministic:
 *   * the container is a fixture tree this file writes under `.mcpfixtures/` (gitignored),
 *     so no test depends on what happens to be cloned on this machine;
 *   * fixture bytes are written on every run (identical content, so the run is idempotent)
 *     and never deleted — `rmSync` is not even declared in `tests/helpers/node-builtins.d.ts`,
 *     and a test suite that reaches for deletion inside a worktree whose `node_modules` is a
 *     junction to a shared store is a suite nobody should run twice;
 *   * no network, no cargo, no tauri, no real MCP client (see docs/mcp-server.md 未验证).
 *
 * The 60 s budgets follow `tests/checkers.test.ts`: a spawn that a busy machine takes longer
 * than that is not a failing server, and a unit test must not depend on "this box is idle".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { at } from "./helpers/definite.ts";

/**
 * Two things this file needs and `tests/helpers/node-builtins.d.ts` does not declare:
 * `spawn` (the interactive handshake) and `input`/`env` on `spawnSync` (the batch sessions).
 *
 * They are augmented here rather than added to the shared shim because that shim belongs to
 * the whole suite and another direction may be editing it right now; the header of that file
 * says its contents are "the names `tests/**` actually uses", and until this file they were.
 * A module augmentation of an ambient module is the documented way to extend it from a
 * module file, and an extra `spawnSync` signature is an overload, not a redefinition.
 */
declare module "node:child_process" {
  /** Only the members this file touches; deliberately not a `ChildProcess` type surface. */
  export interface McpChild {
    stdin: { write(chunk: string): boolean; end(): void };
    stdout: { on(event: "data", listener: (chunk: unknown) => void): void; setEncoding(encoding: string): void };
    stderr: { on(event: "data", listener: (chunk: unknown) => void): void; setEncoding(encoding: string): void };
    on(event: "close", listener: (code: number | null) => void): void;
  }
  export function spawn(
    command: string,
    args: string[],
    options?: { cwd?: string; env?: Record<string, string | undefined> },
  ): McpChild;
  export function spawnSync(
    command: string,
    args?: string[],
    options?: {
      input?: string;
      env?: Record<string, string | undefined>;
      encoding?: "utf8";
      cwd?: string;
      timeout?: number;
    },
  ): SpawnSyncResult;
}

const ROOT = process.cwd();
const SCRIPT = resolve(ROOT, "scripts", "mcp-devhub.mjs");
const CONTAINER = resolve(ROOT, ".mcpfixtures", "container");
const BUDGET_MS = 60_000;

/** The default, un-gated tool set — asserted as a set, so an added tool fails here. */
const READ_ONLY_TOOLS = [
  "devhub_list_repos",
  "devhub_repo_detail",
  "devhub_repo_marker",
  "devhub_find_by_name",
  "devhub_repo_health",
  "devhub_container_health",
  "devhub_repo_readme",
  "devhub_repo_headings",
  "devhub_repo_files",
  "devhub_repo_commits",
  "devhub_search_local",
];
const PLAN_TOOLS = ["devhub_launch_plan", "devhub_stop_plan"];

type Json = Record<string, unknown>;

function writeFixture(dirName: string, body: string): string {
  const dir = join(CONTAINER, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".devhub.json"), body);
  return dir;
}

const ALPHA = writeFixture(
  "alpha_owner",
  JSON.stringify(
    {
      slug: "github.com/acme/alpha",
      url: "https://github.com/acme/alpha",
      clonedAt: "2026-01-01T00:00:00Z",
      portBase: 21000,
      services: [["http", 21000], ["ws", 21001]],
      pythonVersion: "3.11.5",
      venvPath: join(CONTAINER, "venvs", "alpha_owner"),
      launch: { command: "npm run dev", cwd: "", userConfirmed: true, steps: [] },
    },
    null,
    2,
  ),
);
const BETA_OWNER = writeFixture(
  "beta_owner",
  JSON.stringify({ slug: "github.com/acme/beta", portBase: 21010, services: [["http", 21010]] }),
);
// A marker whose launch step names an ABSOLUTE cwd. `LaunchStep.cwd` is documented as
// relative to the repository root, but the marker is a hand-editable JSON file, and the
// plan tool must not silently build a path no OS can resolve.
writeFixture(
  "delta_owner",
  JSON.stringify({
    slug: "github.com/acme/delta",
    portBase: 21020,
    services: [],
    launch: {
      command: "",
      cwd: "",
      userConfirmed: true,
      steps: [{ name: "跑", command: "npm start", cwd: CONTAINER, parallel: false }],
    },
  }),
);
// A directory whose marker exists but does not parse: the server must report it as corrupt
// rather than as "no marker" (the collapse that made the app reset a port block once).
const GAMMA_BROKEN = writeFixture("gamma_broken", '{"slug": this is not json');
const EPSILON_OWNER = writeFixture(
  "epsilon_owner",
  JSON.stringify({ slug: "github.com/acme/epsilon", portBase: 21030, services: [] }),
);
// DevHub's own bookkeeping directory, deliberately carrying a marker: `is_reserved_dir()`
// must keep it out of the list even though it looks like a repository.
writeFixture("venvs", '{"slug": "github.com/acme/not-a-repo"}');
// A directory with no marker at all: not ours to list.
mkdirSync(join(CONTAINER, "plain_dir"), { recursive: true });

// README fixtures for devhub_repo_readme / devhub_repo_headings. Same bytes every run,
// so the run stays idempotent.
// alpha: an ordinary small README under the first candidate spelling, carrying an ATX
// heading with closing hashes, a fenced code block whose shell comment must NOT become a
// heading, and one level-3 heading — the shape devhub_repo_headings is asserted against.
writeFileSync(
  join(ALPHA, "README.md"),
  ["# Alpha", "", "Hello workspace.", "", "## Setup", "", "```bash", "# not a heading", "echo hi", "```", "", "### Nested detail ###", "", "Done.", ""].join("\n"),
);
// beta: only README.markdown exists — reached after the first two candidate spellings
// miss. Deliberately NOT the lowercase `readme.md`: on a case-insensitive volume (every
// Windows checkout) the README.md probe would match readme.md and pin nothing about the
// probe order; `.markdown` differs beyond case, so the fallback is real on both FS types.
// The body is larger than the 256 KB byte cap, so this one fixture also pins `truncated`.
writeFileSync(join(BETA_OWNER, "README.markdown"), `# Beta (markdown)\n\n${"x".repeat(256 * 1024)}`);
// epsilon: 45 headings first, then padding past the 256 KB cap. Headings all live inside
// the capped window, so this one fixture pins both caps on devhub_repo_headings:
// headings hits the 40-item limit (truncated) and the source itself was cut (byteCapped).
writeFileSync(
  join(EPSILON_OWNER, "README.md"),
  `${Array.from({ length: 45 }, (_, i) => `## Section ${i + 1}`).join("\n")}\n\n${"y".repeat(256 * 1024)}\n`,
);
// gamma: a *directory* named README.md — existsSync says yes, the read fails, and the
// server must answer `unreadable`, not collapse it into `absent` (the MarkerFile bug).
mkdirSync(join(GAMMA_BROKEN, "README.md"), { recursive: true });

// devhub_repo_commits fixture: a real one-commit repository, created once and reused on
// later runs. The commit hash is not asserted — it changes with the clock — only that a
// real `git log` produced the subject and author.
const HIST = writeFixture(
  "hist_owner",
  JSON.stringify({ slug: "github.com/acme/hist", portBase: 21040, services: [] }),
);
if (!existsSync(join(HIST, ".git"))) {
  writeFileSync(join(HIST, "history.txt"), "first\n");
  spawnSync("git", ["init", "-q", HIST]);
  spawnSync("git", ["-C", HIST, "add", "."]);
  spawnSync("git", [
    "-C", HIST,
    "-c", "user.name=Fixture",
    "-c", "user.email=fixture@example.invalid",
    "commit", "-q", "-m", "fixture subject",
  ]);
}

// devhub_repo_files fixtures: a small source tree, an ignored dependency directory and a
// deep chain. The ignored directory exists so the test can prove it is skipped rather
// than merely absent.
mkdirSync(join(ALPHA, "src", "lib"), { recursive: true });
writeFileSync(join(ALPHA, "src", "main.ts"), "export const main = 1;\n");
writeFileSync(join(ALPHA, "src", "lib", "util.ts"), "export const util = 2;\n");
mkdirSync(join(ALPHA, "node_modules", "pkg"), { recursive: true });
writeFileSync(join(ALPHA, "node_modules", "pkg", "ignored.js"), "should not be listed\n");
mkdirSync(join(ALPHA, "deep", "a", "b", "c"), { recursive: true });
writeFileSync(join(ALPHA, "deep", "a", "b", "c", "leaf.txt"), "deep\n");

function request(id: number, method: string, params?: Json): string {
  return JSON.stringify(params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params });
}

const INITIALIZE = request(1, "initialize", {
  protocolVersion: "2025-06-18",
  capabilities: { roots: { listChanged: false } },
  clientInfo: { name: "node-test", version: "0" },
});

/** `process.env` is not in the shared shim; the inherited environment is read through globalThis. */
function inheritedEnv(): Record<string, string | undefined> {
  const holder = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return holder.process?.env ?? {};
}

/**
 * One batch session: every request line is written, stdin closes, and the server exits —
 * which is also the spec's stdio shutdown path ("the client closes the input stream").
 */
function runServer(args: string[], lines: string[], env?: Record<string, string | undefined>) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    cwd: ROOT,
    timeout: BUDGET_MS,
    input: `${lines.join("\n")}\n`,
    env,
  });
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  const frames = stdout.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as Json);
  return { status: result.status, stdout, stderr, frames, spawnError: result.error?.message ?? "" };
}

function containerArgs(extra: string[] = []): string[] {
  return ["--root", CONTAINER, ...extra];
}

function asRecord(value: unknown, what: string): Json {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value), `${what} 不是一个对象`);
  return value as Json;
}

/** `result.structuredContent` of a tools/call response. */
function structured(frame: Json): Json {
  const result = asRecord(frame.result, "响应 result");
  return asRecord(result.structuredContent, "structuredContent");
}

function toolNamesOf(frame: Json): string[] {
  const result = asRecord(frame.result, "tools/list result");
  const tools = result.tools;
  assert.ok(Array.isArray(tools), "tools/list 的 result.tools 必须是数组");
  return (tools as Json[]).map((tool) => String(tool.name));
}

function errorOf(frame: Json): Json {
  assert.ok(frame.error !== undefined, `期望 JSON-RPC error，实际拿到 ${JSON.stringify(frame)}`);
  return asRecord(frame.error, "error 对象");
}

// ---------------------------------------------------------------------------
// 握手（真交互：写一行、读一行）
// ---------------------------------------------------------------------------

test("initialize: 写一行读一行，字段与协商版本按 2025-06-18 规范", async () => {
  const child = spawn(process.execPath, [SCRIPT, "--root", CONTAINER], { cwd: ROOT });
  const frames: string[] = [];
  let buffer = "";
  let stderrText = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: unknown) => {
    buffer += String(chunk);
    for (;;) {
      const at = buffer.indexOf("\n");
      if (at < 0) break;
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      if (line.trim() !== "") frames.push(line);
    }
  });
  child.stderr.on("data", (chunk: unknown) => {
    stderrText += String(chunk);
  });

  async function nextFrame(): Promise<Json> {
    const deadline = Date.now() + BUDGET_MS;
    while (frames.length === 0) {
      if (Date.now() > deadline) {
        throw new Error(`等 MCP 响应超时 ${BUDGET_MS}ms；stderr:\n${stderrText}`);
      }
      await new Promise<void>((done) => {
        setTimeout(() => done(), 20);
      });
    }
    return JSON.parse(String(frames.shift())) as Json;
  }

  child.stdin.write(`${INITIALIZE}\n`);
  const handshake = await nextFrame();
  assert.equal(handshake.jsonrpc, "2.0");
  assert.equal(handshake.id, 1, "响应必须带回请求的 id");
  const init = asRecord(handshake.result, "initialize result");
  assert.equal(init.protocolVersion, "2025-06-18");
  assert.deepEqual(asRecord(init.capabilities, "capabilities"), {
    tools: { listChanged: false },
    resources: { subscribe: true, listChanged: false },
    prompts: { listChanged: false },
  });
  assert.equal(asRecord(init.serverInfo, "serverInfo").name, "devhub-container");
  assert.equal(init.error, undefined);

  // Second line, still the same live process: the server is not a one-shot script.
  child.stdin.write(`${request(2, "tools/list")}\n`);
  const listed = await nextFrame();
  assert.equal(listed.id, 2);
  assert.ok(toolNamesOf(listed).length > 0, "握手之后 tools/list 必须有内容");

  child.stdin.write(`${request(3, "ping")}\n`);
  const pong = await nextFrame();
  assert.equal(pong.id, 3);
  assert.deepEqual(pong.result, {}, "ping 的空 result");

  // Spec §Shutdown/stdio: closing the input stream is the shutdown signal.
  child.stdin.end();
  const exitCode = await new Promise<number | null>((done) => {
    child.on("close", (code) => done(code));
  });
  assert.equal(exitCode, 0, `stdin 关闭后应以 0 退出；stderr:\n${stderrText}`);
});

test("initialize: 客户端要的版本不支持时，服务器改答自己最新的版本而不是报错", () => {
  const asked = request(1, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "old-client", version: "0" },
  });
  const { frames, spawnError } = runServer(containerArgs(), [asked]);
  assert.equal(spawnError, "", "子进程必须起得来");
  const init = asRecord(at(frames, 0).result, "initialize result");
  assert.equal(init.protocolVersion, "2025-11-25", "规范要求回自己支持的最新版本");
});

// ---------------------------------------------------------------------------
// 注册表面
// ---------------------------------------------------------------------------

test("tools/list 默认只有只读工具（正好是注册表那一组），且每个都带 inputSchema 与安全注解", () => {
  const { frames } = runServer(containerArgs(), [INITIALIZE, request(2, "tools/list")]);
  const names = toolNamesOf(at(frames, 1)).slice().sort();
  assert.deepEqual(names, [...READ_ONLY_TOOLS].sort(), "默认注册表必须与 READ_ONLY_TOOLS 逐名相等，多一个少一个都算违约");

  const result = asRecord(at(frames, 1).result, "tools/list result");
  const tools = result.tools as Json[];
  for (const tool of tools) {
    assert.equal(typeof tool.title, "string", `${tool.name} 缺 title`);
    assert.match(String(tool.description), /.{20,}/, `${tool.name} 的 description 太短，模型无从判断`);
    const schema = asRecord(tool.inputSchema, `${tool.name} inputSchema`);
    assert.equal(schema.type, "object");
    assert.ok(schema.properties !== undefined || schema.additionalProperties === false, "inputSchema 必须有形状");
    const output = asRecord(tool.outputSchema, `${tool.name} outputSchema`);
    assert.equal(output.type, "object", `${tool.name} outputSchema 必须是对象 schema`);
    const properties = asRecord(output.properties, `${tool.name} outputSchema.properties`);
    assert.ok(Object.keys(properties).length > 0, `${tool.name} outputSchema 不能是空壳`);
    for (const key of (output.required as string[] | undefined) ?? []) {
      assert.ok(Object.prototype.hasOwnProperty.call(properties, key), `${tool.name} 的 required "${key}" 不在 properties 里`);
    }
    const annotations = asRecord(tool.annotations, `${tool.name} annotations`);
    assert.equal(annotations.readOnlyHint, true);
    assert.equal(annotations.destructiveHint, false);
    assert.equal(annotations.openWorldHint, false);
  }
  // No pagination is ever emitted, so a client must not be told a cursor exists.
  assert.equal(result.nextCursor, undefined);
});

test("--allow-mutations 只加两个计划工具，且它们也声明为非破坏性", () => {
  const { frames } = runServer(containerArgs(["--allow-mutations"]), [INITIALIZE, request(2, "tools/list")]);
  const names = toolNamesOf(at(frames, 1)).slice().sort();
  assert.deepEqual(names, [...READ_ONLY_TOOLS, ...PLAN_TOOLS].sort());

  const tools = asRecord(at(frames, 1).result, "result").tools as Json[];
  for (const tool of tools.filter((t) => PLAN_TOOLS.includes(String(t.name)))) {
    const annotations = asRecord(tool.annotations, "annotations");
    assert.equal(annotations.readOnlyHint, true, "计划工具确实不写环境——闸门管的是可发现性");
    assert.equal(annotations.destructiveHint, false);
    assert.match(String(tool.description), /不 spawn|不 kill/, `${tool.name} 的说明必须写清它不执行`);
  }
});

test("被闸门挡掉的工具回答 -32602，与未知工具同一形状（不承认它存在）", () => {
  const { frames } = runServer(containerArgs(), [
    INITIALIZE,
    request(2, "tools/call", { name: "devhub_launch_plan", arguments: { slug: "acme/alpha" } }),
    request(3, "tools/call", { name: "devhub_entirely_made_up" }),
  ]);
  assert.equal(errorOf(at(frames, 1)).code, -32602);
  assert.equal(errorOf(at(frames, 2)).code, -32602);
  assert.match(String(errorOf(at(frames, 1)).message), /Unknown tool: devhub_launch_plan/);
});

// ---------------------------------------------------------------------------
// JSON-RPC 错误码
// ---------------------------------------------------------------------------

test("畸形 JSON → -32700（且没有 id 可回，id 为 null）", () => {
  const { frames, stdout } = runServer(containerArgs(), [INITIALIZE, "{not json"]);
  const parseFailure = at(frames, 1);
  assert.equal(errorOf(parseFailure).code, -32700);
  assert.equal(parseFailure.id, null);
  assert.ok(stdout.indexOf("{not json") < 0, "服务器的 stdout 不许把请求原样吐回去");
});

test("未知方法 → -32601", () => {
  const { frames } = runServer(containerArgs(), [INITIALIZE, request(2, "logging/setLevel")]);
  const error = errorOf(at(frames, 1));
  assert.equal(error.code, -32601);
  assert.match(String(error.message), /Method not found: logging\/setLevel/);
});

test("参数不合法 → -32602：缺 required、未知键、整数越界", () => {
  const { frames } = runServer(containerArgs(), [
    INITIALIZE,
    request(2, "tools/call", { name: "devhub_repo_detail", arguments: {} }),
    request(3, "tools/call", { name: "devhub_list_repos", arguments: { bogus: true } }),
    request(4, "tools/call", { name: "devhub_find_by_name", arguments: { query: "alpha", limit: 999 } }),
    request(5, "tools/call", { name: "devhub_repo_detail", arguments: { slug: "no/such/repo" } }),
  ]);
  for (const id of [2, 3, 4, 5]) {
    const frame = frames.find((f) => f.id === id);
    assert.ok(frame, `id=${id} 没有响应`);
    assert.equal(errorOf(frame).code, -32602, `id=${id}: ${JSON.stringify(frame.error)}`);
  }
});

// ---------------------------------------------------------------------------
// 夹具容器上的真实读取
// ---------------------------------------------------------------------------

test("tools/call devhub_list_repos 命中夹具容器：marker 目录进、保留目录与无标记目录不进", () => {
  const { frames } = runServer(containerArgs(), [
    INITIALIZE,
    request(2, "tools/call", { name: "devhub_list_repos", arguments: {} }),
  ]);
  const payload = structured(at(frames, 1));
  assert.equal(payload.containerRoot, CONTAINER);
  assert.equal(payload.rootSource, "--root");
  assert.equal(payload.count, 6, "alpha/beta/delta/gamma/epsilon/hist 六个带标记的目录");
  const repositories = payload.repositories as Json[];
  const names = repositories.map((r) => String(r.name)).sort();
  assert.deepEqual(names, ["alpha_owner", "beta_owner", "delta_owner", "epsilon_owner", "gamma_broken", "hist_owner"]);
  const alpha = repositories.find((r) => r.name === "alpha_owner");
  assert.ok(alpha, "alpha_owner 必须被列出");
  assert.equal(alpha.slug, "github.com/acme/alpha");
  assert.equal(alpha.identitySource, "marker", "身份来自 .devhub.json，不是目录名的猜测");
  assert.equal(alpha.portBase, 21000);
  assert.equal(alpha.markerState, "valid");
  assert.deepEqual(alpha.services, [{ name: "http", port: 21000 }, { name: "ws", port: 21001 }]);
  // The corrupt marker is a fact about the container, so it is reported, not swallowed.
  const warnings = payload.warnings as string[];
  assert.ok(
    warnings.some((w) => w.includes("gamma_broken") && w.includes("corrupt")),
    `损坏标记必须出现在 warnings：${JSON.stringify(warnings)}`,
  );
});

test("outputSchema 不是装饰：devhub_list_repos 的 required 键都出现在真实 structuredContent 里", () => {
  const { frames } = runServer(containerArgs(), [
    INITIALIZE,
    request(2, "tools/list"),
    request(3, "tools/call", { name: "devhub_list_repos", arguments: {} }),
  ]);
  const listed = asRecord(at(frames, 1).result, "tools/list result");
  const tool = (listed.tools as Json[]).find((t) => t.name === "devhub_list_repos");
  assert.ok(tool, "devhub_list_repos 必须被列出");
  const schema = asRecord(tool.outputSchema, "outputSchema");
  const payload = structured(at(frames, 2));
  for (const key of (schema.required as string[] | undefined) ?? []) {
    assert.ok(Object.prototype.hasOwnProperty.call(payload, key), `required "${key}" 不在真实输出里 —— outputSchema 已经与实现脱节`);
  }
});

test("tools/call devhub_repo_detail / devhub_repo_marker 按 slug 解析到同一个目录", () => {
  const { frames } = runServer(containerArgs(), [
    INITIALIZE,
    request(2, "tools/call", { name: "devhub_repo_detail", arguments: { slug: "acme/alpha" } }),
    request(3, "tools/call", { name: "devhub_repo_marker", arguments: { slug: "github.com/acme/alpha" } }),
  ]);
  const detail = structured(at(frames, 1));
  const matched = asRecord(detail.matched, "matched");
  assert.equal(matched.path, ALPHA);
  assert.equal(matched.markerState, "valid");
  const environments = asRecord(matched.environments, "environments");
  assert.deepEqual(environments.node, [], "夹具里没有 package.json，环境线索必须为空而不是猜");

  const marker = structured(at(frames, 2));
  assert.equal(marker.markerPath, join(ALPHA, ".devhub.json"));
  assert.equal(marker.markerState, "valid");
  assert.match(String(marker.rawText), /"slug": "github\.com\/acme\/alpha"/);
  assert.equal(asRecord(marker.parsed, "parsed").portBase, 21000);
});

test("tools/call devhub_repo_readme：命中、候选顺序回退、256 KB 截断、absent、目录伪装 unreadable", () => {
  const { frames } = runServer(containerArgs(), [
    INITIALIZE,
    request(2, "tools/call", { name: "devhub_repo_readme", arguments: { slug: "acme/alpha" } }),
    request(3, "tools/call", { name: "devhub_repo_readme", arguments: { slug: "acme/beta" } }),
    request(4, "tools/call", { name: "devhub_repo_readme", arguments: { slug: "acme/delta" } }),
    request(5, "tools/call", { name: "devhub_repo_readme", arguments: { slug: "gamma" } }),
  ]);
  // alpha: first candidate spelling, small file, no truncation.
  const alpha = structured(at(frames, 1));
  assert.equal(alpha.state, "valid");
  assert.equal(alpha.readmePath, join(ALPHA, "README.md"));
  assert.equal(alpha.repository, "alpha_owner");
  assert.match(String(alpha.text), /# Alpha/);
  assert.equal(alpha.truncated, false);
  assert.equal(alpha.empty, false);
  assert.ok(Number(alpha.totalBytes) > 0);
  assert.deepEqual(alpha.candidates, ["README.md", "readme.md", "README.markdown", "README"]);

  // beta: README.md / readme.md both absent → the probe falls through to README.markdown,
  // whose body is larger than the 256 KB byte cap — the cut must land on the cap and say so.
  const beta = structured(at(frames, 2));
  assert.equal(beta.state, "valid");
  assert.equal(beta.readmePath, join(BETA_OWNER, "README.markdown"), "前两个拼写缺席时按候选顺序落到 README.markdown");
  assert.equal(beta.truncated, true);
  assert.ok(Number(beta.totalBytes) > 256 * 1024, "totalBytes 是未截断的文件总长");
  assert.equal(String(beta.text).length, 256 * 1024, "截断后恰好是字节上限（ASCII 填充，无多字节边界问题）");
  assert.ok(!String(beta.text).includes("�"), "截断不许吐 U+FFFD 替换符");

  // delta: no README at all — a fact, not a failure.
  const delta = structured(at(frames, 3));
  assert.equal(delta.state, "absent");
  assert.equal(delta.text, null);
  assert.equal(delta.readmePath, null);

  // gamma: README.md exists but is a directory — unreadable, never collapsed into absent
  // (the collapse the app's MarkerFile enum already paid for once).
  const gamma = structured(at(frames, 4));
  assert.equal(gamma.state, "unreadable");
  assert.equal(gamma.text, null);
  assert.ok(String(gamma.detail).length > 0, "unreadable 必须带 detail，否则无从诊断");
});

test("tools/call devhub_repo_headings：大纲提取、围栏跳过、40 条上限、absent/unreadable", () => {
  const { frames } = runServer(containerArgs(), [
    INITIALIZE,
    request(2, "tools/call", { name: "devhub_repo_headings", arguments: { slug: "acme/alpha" } }),
    request(3, "tools/call", { name: "devhub_repo_headings", arguments: { slug: "acme/epsilon" } }),
    request(4, "tools/call", { name: "devhub_repo_headings", arguments: { slug: "acme/delta" } }),
    request(5, "tools/call", { name: "devhub_repo_headings", arguments: { slug: "gamma" } }),
  ]);
  // alpha: three real headings; the shell comment inside the fence is not one, and the
  // closing hashes on `### Nested detail ###` are stripped.
  const alpha = structured(at(frames, 1));
  assert.equal(alpha.state, "valid");
  assert.equal(alpha.readmePath, join(ALPHA, "README.md"));
  assert.equal(alpha.count, 3);
  assert.deepEqual(alpha.headings, [
    { level: 1, text: "Alpha" },
    { level: 2, text: "Setup" },
    { level: 3, text: "Nested detail" },
  ]);
  assert.equal(alpha.truncated, false);
  assert.equal(alpha.byteCapped, false);
  assert.equal(alpha.headingLimit, 40);

  // epsilon: 45 headings inside a source larger than the byte cap — both caps fire and
  // both are reported rather than silently collapsing into one flag.
  const epsilon = structured(at(frames, 2));
  assert.equal(epsilon.state, "valid");
  assert.equal(epsilon.headingLimit, 40);
  assert.equal(epsilon.count, 40, "上限是应用 local-index 的同一个 40");
  assert.equal(epsilon.truncated, true, "第 41 条标题存在 → truncated");
  assert.equal(epsilon.byteCapped, true, "源文件超过 256 KB → byteCapped");
  const first = at(epsilon.headings as Json[], 0);
  assert.deepEqual(first, { level: 2, text: "Section 1" });

  // delta: no README — an empty outline plus the same three-state verdict, not an error.
  const delta = structured(at(frames, 3));
  assert.equal(delta.state, "absent");
  assert.deepEqual(delta.headings, []);
  assert.equal(delta.count, 0);

  // gamma: README.md is a directory — unreadable, with detail, never reported as absent.
  const gamma = structured(at(frames, 4));
  assert.equal(gamma.state, "unreadable");
  assert.deepEqual(gamma.headings, []);
  assert.ok(String(gamma.detail).length > 0);
});

test("tools/call devhub_repo_files：有界清单、跳过依赖目录、深度/条数上限与参数校验", () => {
  const { frames } = runServer(containerArgs(), [
    INITIALIZE,
    request(2, "tools/call", {
      name: "devhub_repo_files",
      arguments: { slug: "acme/alpha", maxDepth: 2, maxEntries: 200 },
    }),
    request(3, "tools/call", { name: "devhub_repo_files", arguments: { slug: "acme/alpha", maxEntries: 2 } }),
    request(4, "tools/call", {
      name: "devhub_repo_files",
      arguments: { slug: "acme/alpha", maxDepth: 8, maxEntries: 500 },
    }),
    request(5, "tools/call", { name: "devhub_repo_files", arguments: { slug: "acme/alpha", maxEntries: 0 } }),
    request(6, "tools/call", { name: "devhub_repo_files", arguments: { slug: "acme/alpha", maxDepth: 9 } }),
  ]);

  const shallow = structured(at(frames, 1));
  assert.equal(shallow.state, "ok");
  assert.equal(shallow.maxDepth, 2);
  const paths = (shallow.entries as Json[]).map((e) => String(e.path));
  assert.ok(paths.includes("README.md"), "根层文件必须在");
  assert.ok(paths.includes("src"), "根层目录必须在");
  assert.ok(paths.includes("src/main.ts"), "深度 2 的文件必须在");
  assert.ok(paths.includes("src/lib"), "深度 2 的目录必须在");
  assert.ok(!paths.some((p) => p.includes("node_modules")), "依赖目录及其内容不许出现");
  assert.deepEqual(shallow.ignoredDirectories, ["node_modules"]);
  assert.equal(shallow.depthLimitReached, true, "深度 2 时 src/lib 之下还有内容未展开");
  assert.ok(!paths.some((p) => p.includes(".git")), ".git 不许出现");

  const capped = structured(at(frames, 2));
  assert.equal(capped.count, 2);
  assert.equal(capped.truncated, true, "达到 maxEntries 即截断，而不是悄悄多给");

  const deep = structured(at(frames, 3));
  const deepPaths = (deep.entries as Json[]).map((e) => String(e.path));
  assert.ok(deepPaths.includes("deep/a/b/c/leaf.txt"), "maxDepth 8 时必须能到深层文件");
  assert.equal(deep.truncated, false);

  // Two invalid integers are params errors (-32602), not execution errors: min/max are
  // declared on the schema and enforced before the tool runs.
  const zero = frames.find((f) => f.id === 5);
  assert.ok(zero && zero.error, "maxEntries=0 必须被 inputSchema 拒绝");
  const nine = frames.find((f) => f.id === 6);
  assert.ok(nine && nine.error, "maxDepth=9 必须被 inputSchema 拒绝");
});

test("devhub_launch_plan 返回计划本身：executed:false，且不碰进程", () => {
  const { frames } = runServer(containerArgs(["--allow-mutations"]), [
    INITIALIZE,
    request(2, "tools/call", { name: "devhub_launch_plan", arguments: { slug: "alpha_owner" } }),
    request(3, "tools/call", { name: "devhub_stop_plan", arguments: { slug: "acme/alpha" } }),
  ]);
  const launch = structured(at(frames, 1));
  assert.equal(launch.executed, false);
  assert.equal(launch.repository, "alpha_owner");
  const plan = asRecord(launch.plan, "plan");
  const steps = plan.steps as Json[];
  assert.equal(steps.length, 1);
  assert.equal(at(steps, 0).command, "npm run dev");
  assert.equal(plan.userConfirmed, true);
  assert.deepEqual(plan.ports, [{ service: "http", port: 21000 }, { service: "ws", port: 21001 }]);

  const hint = structured(at(frames, 2));
  assert.equal(hint.executed, false);
  assert.match(String(asRecord(hint.hint, "hint").whyNotPid), /pid/);
});

test("--root 覆盖 DEVHUB_PROJECT_ROOT；没有 --root 时 env 生效", () => {
  const bogus = resolve(ROOT, ".mcpfixtures", "must-not-be-used");
  const overridden = runServer(containerArgs(), [INITIALIZE, request(2, "tools/call", { name: "devhub_list_repos" })], {
    ...inheritedEnv(),
    DEVHUB_PROJECT_ROOT: bogus,
  });
  assert.equal(structured(at(overridden.frames, 1)).containerRoot, CONTAINER);
  assert.equal(structured(at(overridden.frames, 1)).rootSource, "--root");

  // No `--root` at all: this is the branch `project_root()` takes when only the override
  // exists, and `rootSource` is how the test sees which branch actually ran.
  const fromEnv = runServer(
    [],
    [INITIALIZE, request(2, "tools/call", { name: "devhub_list_repos" })],
    { ...inheritedEnv(), DEVHUB_PROJECT_ROOT: CONTAINER },
  );
  const payload = structured(at(fromEnv.frames, 1));
  assert.equal(payload.rootSource, "env DEVHUB_PROJECT_ROOT");
  assert.equal(payload.containerRoot, CONTAINER);
});

test("换行分帧：一条请求恰好一行响应，stdout 里没有裸回车", () => {
  const lines = [
    INITIALIZE,
    request(2, "tools/list"),
    request(3, "tools/call", { name: "devhub_list_repos", arguments: {} }),
    request(4, "ping"),
  ];
  const { frames, stdout, status } = runServer(containerArgs(), lines);
  assert.equal(status, 0, "stdin 关闭即退出，退出码 0");
  assert.equal(frames.length, lines.length, "响应的行数必须与请求的行数相等");
  assert.equal(stdout.includes("\r"), false, "帧分隔是 \\n；出现裸 \\r 就说明消息里夹了换行");
  assert.deepEqual(frames.map((f) => f.id), [1, 2, 3, 4]);
});

test("分页游标：服务器从不发 nextCursor，收到任何 cursor 就回空页而不是重发全表", () => {
  const { frames } = runServer(containerArgs(), [
    INITIALIZE,
    request(2, "tools/list", { cursor: "anything" }),
  ]);
  const first = asRecord(at(frames, 1).result, "tools/list result");
  assert.deepEqual(first.tools, [], "带 cursor 的第二次拉取必须是空页，否则客户端永远翻不完");
  assert.equal(first.nextCursor, undefined);
});

test("客户端发来的 response 被丢弃，不回错误（否则一条管道能自激成错误风暴）", () => {
  const { frames, status } = runServer(containerArgs(), [
    INITIALIZE,
    JSON.stringify({ jsonrpc: "2.0", id: 99, result: { from: "a confused client" } }),
    request(3, "ping"),
  ]);
  assert.equal(frames.length, 2, "只有 initialize 与 ping 该有响应");
  assert.deepEqual(frames.map((f) => f.id), [1, 3]);
  assert.equal(status, 0);
});

test("计划里的 cwd 是绝对路径时原样给出，不与仓库目录拼接", () => {
  const { frames } = runServer(containerArgs(["--allow-mutations"]), [
    INITIALIZE,
    request(2, "tools/call", { name: "devhub_launch_plan", arguments: { slug: "delta_owner" } }),
  ]);
  const plan = asRecord(structured(at(frames, 1)).plan, "plan");
  const steps = plan.steps as Json[];
  assert.equal(steps.length, 1);
  assert.equal(at(steps, 0).workingDirectory, CONTAINER, "绝对 cwd 被 join 吞掉的话，这里就不是容器根了");
});

test("未知命令行参数 → 退出码 2，usage 只写 stderr（stdout 是消息通道）", () => {
  const { status, stdout, stderr } = runServer(["--root", CONTAINER, "--allow-mutationz"], [INITIALIZE]);
  assert.equal(status, 2);
  assert.equal(stdout, "", "启动失败时 stdout 必须一个字节都没有");
  assert.match(stderr, /usage: node scripts\/mcp-devhub\.mjs/);
  assert.match(stderr, /unknown argument\(s\): --allow-mutationz/);
});

test("r23 resources: initialize 声明 resources 能力，list/read 使用同一 README 读取路径", () => {
  const { frames } = runServer(containerArgs(), [
    INITIALIZE,
    request(2, "resources/list"),
    request(3, "resources/read", { uri: "devhub://repo/github.com%2Facme%2Falpha/readme" }),
    request(4, "resources/read", { uri: "devhub://repo/github.com%2Facme%2Falpha%2Fnope/readme" }),
    request(5, "resources/read", { uri: "https://example.com/readme" }),
  ]);
  const init = asRecord(at(frames, 0).result, "initialize result");
  const caps = asRecord(init.capabilities, "capabilities");
  assert.deepEqual(caps.resources, { subscribe: true, listChanged: false });
  const list = asRecord(at(frames, 1).result, "resources/list result");
  const resources = list.resources as Json[];
  assert.ok(resources.some((r) => String(r.uri).includes("alpha")), "alpha README must be listed");
  assert.equal(resources[0]?.mimeType, "text/markdown");
  const read = asRecord(at(frames, 2).result, "resources/read result");
  const contents = read.contents as Json[];
  assert.equal(contents.length, 1);
  assert.match(String(contents[0]?.text), /Alpha/);
  for (const idx of [3, 4]) {
    const frame = at(frames, idx);
    assert.ok(frame.error, `request ${idx} must be an error`);
    assert.match(String(asRecord(frame.error, "error").message), /Resource not found/);
  }
});

test("r24 prompts: 能力声明、list 的形状与未知 cursor 的空页", () => {
  const { frames } = runServer(containerArgs(), [
    INITIALIZE,
    request(2, "prompts/list"),
    request(3, "prompts/list", { cursor: "next" }),
  ]);
  const init = asRecord(at(frames, 0).result, "initialize result");
  const caps = asRecord(init.capabilities, "capabilities");
  assert.deepEqual(caps.prompts, { listChanged: false }, "prompts 能力必须与实现一起声明");

  const list = asRecord(at(frames, 1).result, "prompts/list result");
  const prompts = list.prompts as Json[];
  assert.ok(Array.isArray(prompts));
  assert.equal(prompts.length, 3, "运行 / 体检 / 查找 三份模板");
  const names = prompts.map((p) => String(p.name));
  assert.deepEqual(names, ["run_repo", "review_repo_health", "find_repo"]);
  for (const p of prompts) {
    assert.ok(String(p.title).length > 0, "title 是客户端列表里唯一的第一眼信息");
    assert.ok(String(p.description).length > 0);
    const args = p.arguments as Json[];
    assert.ok(Array.isArray(args) && args.length > 0);
    for (const a of args) {
      assert.equal(typeof a.name, "string");
      assert.equal(typeof a.description, "string");
      assert.equal(a.required, true);
    }
  }

  const second = asRecord(at(frames, 2).result, "cursor page");
  assert.deepEqual(second.prompts, [], "服务器不发出 nextCursor，也不接受一个不存在的页");
});

test("r24 prompts: get 返回 user/text 消息并替换参数；缺参/未知/类型错都是 -32602", () => {
  const { frames } = runServer(containerArgs(), [
    INITIALIZE,
    request(2, "prompts/get", { name: "run_repo", arguments: { repository: "acme/alpha" } }),
    request(3, "prompts/get", { name: "run_repo", arguments: {} }),
    request(4, "prompts/get", { name: "not_a_prompt" }),
    request(5, "prompts/get", { name: "run_repo", arguments: { repository: 7 } }),
    request(6, "prompts/get", { name: 7 }),
  ]);

  const got = asRecord(at(frames, 1).result, "prompts/get result");
  const messages = got.messages as Json[];
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.role, "user");
  const content = asRecord(messages[0]?.content, "message content");
  assert.equal(content.type, "text");
  assert.match(String(content.text), /acme\/alpha/, "模板参数必须真正替换");
  assert.match(String(content.text), /不要声称已经执行/, "读提示词不能声称执行了命令");

  for (const idx of [2, 3, 4, 5]) {
    const frame = at(frames, idx);
    assert.ok(frame.error, `request ${idx} must be an error`);
    const err = asRecord(frame.error, "error");
    assert.equal(err.code, -32602, "参数/未知 prompt 走 Invalid params，不是内部错误");
  }
  assert.match(String(asRecord(at(frames, 2).error, "missing").message), /Missing required argument: repository/);
  assert.match(String(asRecord(at(frames, 3).error, "unknown").message), /Unknown prompt: not_a_prompt/);
  assert.match(String(asRecord(at(frames, 4).error, "type").message), /argument "repository" must be a string/);
});

test("r24 prompts: 纯空白必填参数拒绝；多余参数忽略且不残留占位符", () => {
  const { frames } = runServer(containerArgs(), [
    INITIALIZE,
    request(2, "prompts/get", { name: "find_repo", arguments: { query: "   " } }),
    request(3, "prompts/get", { name: "find_repo", arguments: { query: "docker", extra: "ignored" } }),
    request(4, "prompts/get", { name: "find_repo", arguments: [] }),
  ]);
  const blank = errorOf(at(frames, 1));
  assert.equal(blank.code, -32602);
  assert.match(String(blank.message), /Missing required argument: query/);

  const ok = asRecord(at(frames, 2).result, "extra argument result");
  const messages = ok.messages as Json[];
  const text = String(asRecord(messages[0]?.content, "content").text);
  assert.match(text, /docker/);
  assert.doesNotMatch(text, /\{[a-z_]+\}/, "所有占位符要么被替换，要么不应该出现在模板里");

  const arrayArgs = errorOf(at(frames, 3));
  assert.equal(arrayArgs.code, -32602);
  assert.match(String(arrayArgs.message), /must be an object of strings/);
});


test("r26 health: 单仓库判定与容器总览都只读、issue code 稳定", () => {
  const { frames } = runServer(containerArgs(), [
    INITIALIZE,
    request(2, "tools/call", { name: "devhub_repo_health", arguments: { slug: "github.com/acme/alpha" } }),
    request(3, "tools/call", { name: "devhub_repo_health", arguments: { slug: "gamma_broken" } }),
    request(4, "tools/call", { name: "devhub_container_health", arguments: {} }),
    request(5, "tools/call", { name: "devhub_repo_health", arguments: { slug: "no-such-repo" } }),
  ]);
  const alpha = structured(at(frames, 1));
  assert.equal(alpha.verdict, "attention");
  const issues = alpha.issues as Json[];
  const codes = issues.map((i) => String(i.code)).sort();
  assert.deepEqual(codes, ["no_git", "venv_missing"], "alpha 有 marker/README/启动配置，但缺 .git，且记录的 venv 不存在");
  assert.equal(asRecord(alpha.facts, "facts").hasReadme, true);

  const gamma = structured(at(frames, 2));
  assert.equal(gamma.verdict, "unusable", "坏 marker 不能读成健康");
  assert.ok((gamma.issues as Json[]).some((i) => i.code === "marker_invalid"));

  const container = structured(at(frames, 3));
  assert.equal(container.repoCount, 6, "六个带 marker 的夹具仓库；venvs 保留目录与无标记目录不算");
  const by = asRecord(container.byVerdict, "byVerdict");
  assert.equal(Number(by.unusable), 1);
  assert.equal(Number(by.attention) + Number(by.ok) + Number(by.unusable), 6);
  assert.equal(asRecord(container.issueCounts, "issueCounts").marker_invalid, 1);
  assert.equal((container.repositories as Json[]).length, 6);

  const missing = at(frames, 4);
  assert.ok(missing.error);
  assert.equal(asRecord(missing.error, "error").code, -32602);
});


test("r26 health: 空容器是 0 行而不是错误；工具元数据仍是只读", () => {
  const empty = resolve(ROOT, ".mcpfixtures", "empty-container");
  rmSync(empty, { recursive: true, force: true });
  mkdirSync(empty, { recursive: true });
  const { frames } = runServer(["--root", empty], [
    INITIALIZE,
    request(2, "tools/list"),
    request(3, "tools/call", { name: "devhub_container_health", arguments: {} }),
  ]);
  const listed = asRecord(at(frames, 1).result, "tools/list result");
  const tools = listed.tools as Json[];
  const health = tools.find((t) => t.name === "devhub_container_health");
  assert.ok(health, "health tool must be listed");
  assert.ok(health.outputSchema, "health tool must declare outputSchema");
  const annotations = asRecord(health.annotations, "annotations");
  assert.equal(annotations.readOnlyHint, true);
  assert.equal(annotations.destructiveHint, false);

  const summary = structured(at(frames, 2));
  assert.equal(summary.repoCount, 0);
  assert.deepEqual(summary.byVerdict, { ok: 0, attention: 0, unusable: 0 });
  assert.deepEqual(summary.repositories, []);
  rmSync(empty, { recursive: true, force: true });
});

test("r26 subscribe: 未知资源 -32602，订阅/退订幂等", () => {
  const uri = "devhub://repo/github.com%2Facme%2Falpha/readme";
  const { frames } = runServer(containerArgs(), [
    INITIALIZE,
    request(2, "resources/subscribe", { uri }),
    request(3, "resources/subscribe", { uri }),
    request(4, "resources/unsubscribe", { uri }),
    request(5, "resources/unsubscribe", { uri }),
    request(6, "resources/subscribe", { uri: "https://example.com/readme" }),
  ]);
  for (const idx of [1, 2, 3, 4]) {
    assert.deepEqual(at(frames, idx).result, {}, `request ${idx} must be an empty result`);
  }
  const err = errorOf(at(frames, 5));
  assert.equal(err.code, -32602);
  assert.match(String(err.message), /Resource not found/);
});

test("r26 subscribe: 文件变化推送 notifications/resources/updated，退订后不再推", async () => {
  const root = resolve(ROOT, ".mcpfixtures", `subscribe-${Date.now()}`);
  rmSync(root, { recursive: true, force: true });
  const repo = join(root, "subdemo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(
    join(repo, ".devhub.json"),
    JSON.stringify({ slug: "github.com/acme/subdemo", portBase: 21000, services: [] }),
  );
  const readme = join(repo, "README.md");
  writeFileSync(readme, "# subdemo\n");

  const child = spawn(process.execPath, [SCRIPT, "--root", root], { cwd: ROOT });
  const frames: string[] = [];
  let buffer = "";
  let stderrText = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: unknown) => {
    buffer += String(chunk);
    for (;;) {
      const at = buffer.indexOf("\n");
      if (at < 0) break;
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      if (line.trim() !== "") frames.push(line);
    }
  });
  child.stderr.on("data", (chunk: unknown) => {
    stderrText += String(chunk);
  });
  async function nextFrame(timeoutMs = BUDGET_MS): Promise<Json> {
    const deadline = Date.now() + timeoutMs;
    while (frames.length === 0) {
      if (Date.now() > deadline) throw new Error(`等帧超时；stderr:\n${stderrText}`);
      await new Promise<void>((done) => setTimeout(done, 20));
    }
    return JSON.parse(String(frames.shift())) as Json;
  }

  const uri = "devhub://repo/github.com%2Facme%2Fsubdemo/readme";
  child.stdin.write(`${INITIALIZE}\n`);
  await nextFrame();
  child.stdin.write(`${request(2, "resources/subscribe", { uri })}\n`);
  assert.deepEqual((await nextFrame()).result, {});
  writeFileSync(readme, "# subdemo\nchanged\n");
  const update = await nextFrame(5_000);
  assert.equal(update.method, "notifications/resources/updated");
  assert.deepEqual(update.params, { uri });

  child.stdin.write(`${request(3, "resources/unsubscribe", { uri })}\n`);
  assert.deepEqual((await nextFrame()).result, {});
  writeFileSync(readme, "# subdemo\nchanged\nagain\n");
  await new Promise<void>((done) => setTimeout(done, 700));
  assert.equal(frames.length, 0, "unsubscribed resource must not notify");

  child.stdin.end();
  await new Promise<void>((done) => child.on("close", () => done()));
  rmSync(root, { recursive: true, force: true });
});

test("r26 subscribe: 没有 README 的资源不可订阅；退订未知 URI 幂等", () => {
  const { frames } = runServer(containerArgs(), [
    INITIALIZE,
    request(2, "resources/subscribe", { uri: "devhub://repo/gamma_broken/readme" }),
    request(3, "resources/subscribe", { uri: "devhub://repo/github.com%2Facme%2Fbeta/readme" }),
    request(4, "resources/unsubscribe", { uri: "devhub://repo/github.com%2Facme%2Fbeta/readme" }),
    request(5, "resources/unsubscribe", { uri: "devhub://repo/github.com%2Facme%2Fnobody/readme" }),
  ]);
  const absent = errorOf(at(frames, 1));
  assert.equal(absent.code, -32602, "目录名不是资源身份；没有可读 README 就不能订阅");
  assert.match(String(absent.message), /Resource not found/);

  // beta is reachable by slug and has README.markdown.
  assert.deepEqual(at(frames, 2).result, {});
  assert.deepEqual(at(frames, 3).result, {});
  assert.deepEqual(at(frames, 4).result, {}, "unsubscribe of an unknown URI is a no-op success");
});

test("tools/call devhub_repo_commits：真实 git log、无 .git 与错误 slug 三态", () => {
  const { frames } = runServer(containerArgs(), [
    INITIALIZE,
    request(2, "tools/call", { name: "devhub_repo_commits", arguments: { slug: "acme/hist" } }),
    request(3, "tools/call", { name: "devhub_repo_commits", arguments: { slug: "alpha" } }),
    request(4, "tools/call", { name: "devhub_repo_commits", arguments: { slug: "no/such/repo" } }),
  ]);
  const ok = structured(frames[1]);
  assert.equal(ok.state, "ok");
  const commits = ok.commits as Json[];
  assert.equal(commits.length, 1);
  assert.equal(commits[0].subject, "fixture subject");
  assert.equal(commits[0].author, "Fixture");
  assert.match(String(commits[0].hash), /^[0-9a-f]{40}$/);
  assert.match(String(commits[0].date), /^\d{4}-\d{2}-\d{2}T/);

  assert.equal(structured(frames[2]).state, "no-git", "a cloned archive must not look empty");
  assert.equal(structured(frames[2]).commits.length, 0);
  assert.equal(errorOf(frames[3]).code, -32602, "an unknown slug is a params error");
});

test("tools/call devhub_search_local：字面量搜索、忽略目录、单仓库范围与非法正则", () => {
  const { frames } = runServer(containerArgs(), [
    INITIALIZE,
    request(2, "tools/call", {
      name: "devhub_search_local",
      arguments: { query: "util", slug: "acme/alpha", regex: false },
    }),
    request(3, "tools/call", {
      name: "devhub_search_local",
      arguments: { query: "should not be listed" },
    }),
    request(4, "tools/call", {
      name: "devhub_search_local",
      arguments: { query: "[", regex: true },
    }),
  ]);
  const one = structured(frames[1]);
  assert.equal(one.scope, "one");
  assert.equal(one.count, 1);
  const hits = one.hits as Json[];
  assert.equal(hits[0].file, "src/lib/util.ts");
  assert.match(String(hits[0].content), /export const util/);

  const all = structured(frames[2]);
  assert.equal(all.count, 0, "node_modules must be skipped, not merely absent");
  assert.equal(all.truncated, false);

  assert.equal(errorOf(frames[3]).code, -32602, "an invalid regex is a params error");
});
