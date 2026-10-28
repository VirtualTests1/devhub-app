// check-compose.mjs — the `compose config` validator `src/lib/compose.ts` claims exists.
//
// WHY THIS FILE EXISTS
// The module header of `src/lib/compose.ts` (lines 26-28) says: "isolatedOverride
// produces the file content the 项目设置 panel can offer to save; `compose config`
// validation of that content is what `scripts/check-compose.mjs` measures." Until
// round 21 (o3-1) that sentence was FALSE — `Test-Path scripts\check-compose.mjs`
// output `False`. A source comment asserting a guard that does not exist is the
// exact defect class this round exists for: readers believed the generated
// override was machine-validated when nothing in the repo checked it. This script
// is that measurement, and `pnpm check` now runs it (package.json `check` chain).
//
// WHAT IT CHECKS — two layers
//
// (a) OFFLINE STRUCTURE — always runs: no docker, no network, no subprocess.
//     It imports the REAL `src/lib/compose.ts` and validates its output against
//     the constraints that module itself states:
//       - project name matches the compose practice constraint `[a-z0-9][a-z0-9_-]*`
//         (<= 40 chars) — stated above `composeProjectName` (src/lib/compose.ts:34),
//         exercised over dirty slugs (`Owner/My.Repo`, `!!!`, `__leading`,
//         `trailing---`, 80 chars, `weird///path  case`);
//       - network = `<project>_devhub` (`composeNetworkName`, src/lib/compose.ts:50);
//       - volume = `<project>_<folded>` (`composeVolumeName`, src/lib/compose.ts:57),
//         including dirty volume inputs (`""`, `Mixed CASE !! name`, `UPPER/CASE`);
//       - override YAML (`isolatedOverride`, src/lib/compose.ts:75): the generated-file
//         comment header is present, `networks` declares exactly the one private
//         network with `external: false`, EVERY service attaches to exactly that
//         network, every volume is re-qualified via `name:`, and `container_name`
//         never appears (docs/docker-isolation.md §3: 不重命名容器);
//       - the two-file command (`isolatedComposeCommand`, src/lib/compose.ts:107)
//         carries `-p <project>` and both `-f` files.
//     The override text is parsed by a strict miniature parser (2-space steps,
//     `key:` / `key: value` / `- item`, `#` comments, tabs and duplicate keys are
//     errors) — enough to check the structure this generator emits, without a YAML
//     dependency (dependency-free by rule: node:fs / node:path / node:child_process /
//     node:url / node:os only). Design context: docs/docker-isolation.md §2 (names
//     are the whole problem), §3 (what the app deliberately does not do).
//
// (b) REAL `docker compose config` — runs only when the docker CLI is USABLE:
//     a fixture project (base docker-compose.yml + the generated override) is handed
//     to `docker compose -p <project> -f base -f override config --format json`,
//     the authoritative merge, and the resolved project name / network attachment /
//     volume names are asserted, plus the base file must come back byte-identical
//     (the app never rewrites a user's tree, docs/docker-isolation.md §3).
//     docker ABSENT (no CLI, `docker compose version` broken) is a SKIP — reported
//     as a skip, never as a pass, and never a failure: docs/docker-isolation.md §4
//     documents that `config` is client-side, so absence of docker is a machine
//     fact, not a defect of the override.
//
// THREE-STATE EXIT CONTRACT (shared by every checker in `pnpm check`):
//   0 = passed. Note that "passed with the docker layer skipped" prints the word
//       SKIPPED — a skip is not a green for that layer, and the success line says so.
//   1 = FAILED: the offline structure is wrong, or `docker compose config` rejected
//       the generated override (a compose verdict we CAN attribute to the config).
//   2 = COULD NOT DECIDE: docker exists but the failure is an environment class
//       (daemon socket/pipe, permissions, spawn timeout), `config` exited 0 with
//       unparseable output, or `src/lib/compose.ts` cannot be imported on this Node
//       (type stripping unavailable — needs Node >= 22.18 unflagged; measured here
//       on v22.19.0). Exit 2 is neither green nor red: it is not evidence the
//       override is wrong, and it must never be read as "checked, fine". `pnpm
//       check`'s && chain stops on any non-zero (same treatment as a usage error),
//       so a 2 surfaces loudly instead of passing silently.
//
// RUN:
//   node scripts/check-compose.mjs             both layers (this is what pnpm check runs)
//   node scripts/check-compose.mjs --offline   layer (a) only
//   node scripts/check-compose.mjs --json      one JSON verdict on stdout, same exit codes
//   node scripts/check-compose.mjs --selftest  detector self-test: synthetic overrides
//                                              + the env/reject classifier; no repo
//                                              state, no docker, no network
//   node scripts/check-compose.mjs --help
// Unknown flags are rejected (exit 2), never ignored — an ignored `--jsno` is how a
// guard silently stops running.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Root anchoring (house rule since round 15 d7): resolve from this file's own
// location and chdir, so reported paths stay relative and the invocation
// directory never decides what gets checked. Regression guard: the checker runs
// from `tests/` in tests/checkers.test.ts.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
process.chdir(ROOT);

// ---------------------------------------------------------------------------
// CLI contract
// ---------------------------------------------------------------------------
const CLI_KNOWN = new Set(["--json", "--offline", "--selftest", "--help"]);
const argv = process.argv.slice(2);
for (const a of argv) {
  if (!CLI_KNOWN.has(a)) {
    console.error(`check-compose.mjs: unknown argument '${a}'`);
    console.error("usage: node scripts/check-compose.mjs [--offline] [--json] [--selftest] [--help]");
    process.exit(2);
  }
}
if (argv.includes("--help")) {
  console.log(
    "node scripts/check-compose.mjs [--offline] [--json] [--selftest] [--help]\n" +
      "  (no flag)     offline structure layer + `docker compose config` when the CLI is usable\n" +
      "  --offline     run only the offline structural layer (no docker spawn at all)\n" +
      "  --json        one JSON verdict on stdout; `ok` agrees with the exit code\n" +
      "  --selftest    synthetic detector self-test, no repo state, no docker\n" +
      "exit codes: 0 = passed, 1 = validation FAILED, 2 = could not decide (see the header)",
  );
  process.exit(0);
}
const AS_JSON = argv.includes("--json");
const OFFLINE_ONLY = argv.includes("--offline");

// ---------------------------------------------------------------------------
// The constraints, stated as patterns
// ---------------------------------------------------------------------------
// `composeProjectName`'s own doc comment (src/lib/compose.ts:31) calls
// `[a-z0-9][a-z0-9_-]*` the *practice* constraint compose enforces; 40 chars is
// the module's own truncation. Network/volume names additionally allow `.`
// because that is what compose's name rule accepts for resources.
const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const RESOURCE_NAME_RE = /^[a-z0-9][a-z0-9_.-]*$/;

const isMapping = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// ---------------------------------------------------------------------------
// The miniature YAML parser (offline layer only)
// ---------------------------------------------------------------------------
// Accepts exactly the shape `isolatedOverride` emits: 2-space indent steps,
// `key:`, `key: value`, `- item`, `#` comments, blank lines. Anything else —
// a tab, a stray indent, a duplicate key, a line that is neither — is an error,
// because a generator whose output drifts out of this shape has stopped
// producing what the panel claims to save, and guessing past that would hide it.
// Returns { root, comments } on success, { error } with a line number on failure.
export function parseOverrideYaml(text) {
  const lines = text.split("\n");
  const comments = [];
  const root = {};
  const frames = [{ indent: -1, container: root }];
  const nextMeaningful = (from) => {
    for (let i = from; i < lines.length; i += 1) {
      const t = lines[i];
      if (t.trim() === "" || /^\s*#/.test(t)) continue;
      return { line: t };
    }
    return null;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const lineNo = i + 1;
    if (raw.includes("\t")) return { error: `line ${lineNo}: tab character (the generator emits spaces)` };
    if (raw.trim() === "") continue;
    if (/^\s*#/.test(raw)) {
      comments.push({ line: lineNo, text: raw.trim() });
      continue;
    }
    const indent = raw.length - raw.trimStart().length;
    const content = raw.trim();
    while (frames.length > 1 && frames[frames.length - 1].indent >= indent) frames.pop();
    const frame = frames[frames.length - 1];
    const wantIndent = frame.indent < 0 ? 0 : frame.indent + 2;
    if (indent !== wantIndent) {
      return { error: `line ${lineNo}: indentation ${indent}, expected ${wantIndent} (2-space steps only)` };
    }
    const item = /^- (.*)$/.exec(content);
    if (item) {
      if (!Array.isArray(frame.container)) return { error: `line ${lineNo}: list item outside a list` };
      frame.container.push(item[1]);
      continue;
    }
    const kv = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(content);
    if (!kv) return { error: `line ${lineNo}: not a \`key: value\` line: ${JSON.stringify(content)}` };
    if (!isMapping(frame.container)) return { error: `line ${lineNo}: mapping key inside a list` };
    const key = kv[1];
    const val = kv[2];
    if (Object.prototype.hasOwnProperty.call(frame.container, key)) {
      return { error: `line ${lineNo}: duplicate key \`${key}\`` };
    }
    if (val === "") {
      // The child's type (mapping vs list) is revealed by the first child line —
      // YAML itself cannot know it at the key either.
      const nxt = nextMeaningful(i + 1);
      const nxtIndent = nxt ? nxt.line.length - nxt.line.trimStart().length : -1;
      const child = nxt && nxtIndent > indent && /^\s*- /.test(nxt.line) ? [] : {};
      frame.container[key] = child;
      frames.push({ indent, container: child });
    } else {
      frame.container[key] = val;
    }
  }
  return { root, comments };
}

// ---------------------------------------------------------------------------
// Offline layer — one scenario is one (slug, services, volumes) triple
// ---------------------------------------------------------------------------
export function validateOverride(slug, services, volumes, mods) {
  const fail = [];
  const where = `override(${JSON.stringify(slug)})`;

  const project = mods.composeProjectName(slug);
  const network = mods.composeNetworkName(slug);
  if (!PROJECT_NAME_RE.test(project)) {
    fail.push(`${where}: project name ${JSON.stringify(project)} violates the compose practice constraint [a-z0-9][a-z0-9_-]* (<= 40 chars)`);
  }
  if (network !== `${project}_devhub`) {
    fail.push(`${where}: network name ${JSON.stringify(network)} does not derive from the project name (expected ${project}_devhub)`);
  }
  if (!RESOURCE_NAME_RE.test(network)) {
    fail.push(`${where}: network name ${JSON.stringify(network)} violates [a-z0-9][a-z0-9_.-]*`);
  }

  // Dirty volume INPUTS to composeVolumeName: the on-disk volume must be
  // project-qualified whatever the panel feeds it.
  for (const dirty of ["", "Mixed CASE !! name", "-leading", "UPPER/CASE"]) {
    const q = mods.composeVolumeName(slug, dirty);
    if (!RESOURCE_NAME_RE.test(q)) {
      fail.push(`${where}: composeVolumeName(${JSON.stringify(dirty)}) = ${JSON.stringify(q)} is not a name compose accepts`);
    }
    if (!q.startsWith(`${project}_`)) {
      fail.push(`${where}: composeVolumeName(${JSON.stringify(dirty)}) = ${JSON.stringify(q)} is not project-qualified with ${project}_`);
    }
  }

  const text = mods.isolatedOverride(slug, services, volumes);
  const lines = text.split("\n");
  if (!/^# Generated by DevHub/.test(lines[0] || "")) {
    fail.push(`${where}: line 1 is not the generated-file marker comment (\`# Generated by DevHub …\`) — without it the file is unattributable`);
  }

  const parsed = parseOverrideYaml(text);
  if (parsed.error) {
    fail.push(`${where}: the override does not parse under the generator's shape: ${parsed.error}`);
    return fail;
  }
  if (parsed.comments.length < 1) {
    fail.push(`${where}: the override carries no comment header at all`);
  }

  const wantTop = ["networks", ...(services.length ? ["services"] : []), ...(volumes.length ? ["volumes"] : [])];
  const top = Object.keys(parsed.root);
  if (top.join(",") !== wantTop.join(",")) {
    fail.push(`${where}: top-level keys [${top.join(", ")}] != expected [${wantTop.join(", ")}]`);
  }

  const nets = parsed.root.networks;
  if (!isMapping(nets)) {
    fail.push(`${where}: \`networks\` must be a mapping`);
  } else {
    const nk = Object.keys(nets);
    if (nk.length !== 1 || nk[0] !== network) {
      fail.push(`${where}: networks declares [${nk.join(", ")}] but the project-private network is \`${network}\``);
    } else if (nets[network].external !== "false") {
      fail.push(`${where}: \`${network}\` must be \`external: false\` — an external network is shared, which defeats isolation`);
    }
  }

  if (services.length) {
    const svcs = parsed.root.services;
    if (!isMapping(svcs)) {
      fail.push(`${where}: \`services\` must be a mapping`);
    } else {
      const sk = Object.keys(svcs);
      if (sk.join(",") !== [...services].join(",")) {
        fail.push(`${where}: service keys [${sk.join(", ")}] != [${services.join(", ")}]`);
      }
      for (const svc of services) {
        const attached = svcs[svc] && svcs[svc].networks;
        if (!Array.isArray(attached)) {
          fail.push(`${where}: service \`${svc}\` has no \`networks\` list — it is attached to no network`);
        } else if (attached.length !== 1 || attached[0] !== network) {
          fail.push(`${where}: service \`${svc}\` attaches to [${attached.join(", ")}] instead of exactly \`${network}\``);
        }
      }
    }
  }

  if (volumes.length) {
    const vols = parsed.root.volumes;
    if (!isMapping(vols)) {
      fail.push(`${where}: \`volumes\` must be a mapping`);
    } else {
      const vk = Object.keys(vols);
      if (vk.join(",") !== [...volumes].join(",")) {
        fail.push(`${where}: volume keys [${vk.join(", ")}] != [${volumes.join(", ")}]`);
      }
      for (const vol of volumes) {
        const want = mods.composeVolumeName(slug, vol);
        const got = vols[vol] && vols[vol].name;
        if (got !== want) {
          fail.push(`${where}: volume \`${vol}\` declares name \`${got}\`, expected the project-qualified \`${want}\``);
        }
      }
    }
  }

  if (text.includes("container_name")) {
    fail.push(`${where}: the override sets \`container_name\` — renaming containers is deliberately out of scope (docs/docker-isolation.md §3)`);
  }
  return fail;
}

export function validateCommand(slug, mods) {
  const fail = [];
  const project = mods.composeProjectName(slug);
  const cmd = mods.isolatedComposeCommand(slug);
  if (!cmd.startsWith("docker compose ")) {
    fail.push(`command ${JSON.stringify(cmd)} does not start with \`docker compose\``);
  }
  if (!cmd.includes(`-p ${project}`)) {
    fail.push(`command does not pin the project: missing \`-p ${project}\``);
  }
  if (!cmd.includes("-f docker-compose.yml")) {
    fail.push("command does not include the repository's own base file `-f docker-compose.yml`");
  }
  if (!cmd.includes("-f devhub-isolation.yml")) {
    fail.push("command does not include the generated override `-f devhub-isolation.yml`");
  }
  return fail;
}

// One scenario per shape of dirty input; every scenario exercises the whole
// constraint set (project / network / volume / override / command).
const SCENARIOS = [
  { slug: "owner/app", services: ["web", "db"], volumes: ["db-data", "uploads"] },
  { slug: "Owner/My.Repo", services: ["api"], volumes: ["data"] },
  { slug: "weird///path  case", services: ["svc"], volumes: [] },
  { slug: "__leading", services: [], volumes: ["only"] },
  { slug: "trailing---", services: ["web"], volumes: [] },
  { slug: "!!!", services: [], volumes: [] },
  { slug: "a".repeat(80), services: ["s1"], volumes: ["v1"] },
];

function runOffline(mods) {
  const failures = [];
  for (const sc of SCENARIOS) {
    failures.push(...validateOverride(sc.slug, sc.services, sc.volumes, mods));
    failures.push(...validateCommand(sc.slug, mods));
  }
  return { scenarios: SCENARIOS.length, failures };
}

// ---------------------------------------------------------------------------
// The docker layer
// ---------------------------------------------------------------------------
// An environment failure (daemon socket/pipe gone, permissions, timeout) says
// nothing about whether the override is valid, so it is classified separately
// from a compose verdict. Anything not matching this list that made `config`
// exit non-zero is treated as a REAL config rejection (exit 1).
const ENV_ERROR_RE =
  /cannot connect to the docker daemon|error during connect|docker[_./\\]sock|permission denied|operation not permitted|the system cannot find the|no such file or directory|is the docker daemon running|ECONNREFUSED|EACCES|EPERM/i;

export function classifyConfigFailure(output) {
  return ENV_ERROR_RE.test(output || "") ? "env" : "rejected";
}

const firstLine = (s) => (s || "").trim().split(/\r?\n/)[0].slice(0, 300);

function probeDocker() {
  const p = spawnSync("docker", ["compose", "version"], { encoding: "utf8", timeout: 30_000 });
  if (p.error && p.error.code === "ENOENT") return { usable: false, why: "docker CLI not on PATH" };
  if (p.error) return { usable: null, why: `probe could not run: ${p.error.message}` };
  if (p.status !== 0) {
    return { usable: false, why: `\`docker compose version\` exited ${p.status}: ${firstLine(p.stderr) || "no output"}` };
  }
  return { usable: true, version: p.stdout.trim() };
}

const BASE_FILE = `services:
  web:
    image: nginx:alpine
  db:
    image: postgres:16-alpine
    volumes:
      - db-data:/var/lib/postgresql/data
volumes:
  db-data:
`;

function runDockerLayer(mods) {
  const probe = probeDocker();
  if (probe.usable === null) return { status: "indeterminate", detail: probe.why };
  if (!probe.usable) return { status: "skipped", detail: probe.why };

  const slug = "owner/compose-check";
  const services = ["web", "db"];
  const volumes = ["db-data"];
  const project = mods.composeProjectName(slug);
  const network = mods.composeNetworkName(slug);

  const dir = mkdtempSync(join(tmpdir(), "devhub-check-compose-"));
  try {
    const base = join(dir, "docker-compose.yml");
    const ovr = join(dir, "devhub-isolation.yml");
    writeFileSync(base, BASE_FILE);
    writeFileSync(ovr, mods.isolatedOverride(slug, services, volumes));
    const run = spawnSync(
      "docker",
      ["compose", "-p", project, "-f", base, "-f", ovr, "config", "--format", "json"],
      { encoding: "utf8", timeout: 60_000, cwd: dir },
    );
    if (run.error) {
      return { status: "indeterminate", detail: `docker compose config could not be spawned: ${run.error.message}` };
    }
    if (run.status !== 0) {
      const err = `${run.stderr || ""}\n${run.stdout || ""}`.trim();
      if (classifyConfigFailure(err) === "env") {
        return { status: "indeterminate", detail: `docker reported an environment failure, not a config verdict: ${firstLine(err)}` };
      }
      return { status: "fail", detail: `docker compose config rejected the generated override: ${err.slice(0, 400)}` };
    }

    let resolved;
    try {
      resolved = JSON.parse(run.stdout);
    } catch (e) {
      return { status: "indeterminate", detail: `config exited 0 but its stdout is not JSON: ${e.message}` };
    }

    const problems = [];
    if (resolved.name !== project) {
      problems.push(`resolved project name \`${resolved.name}\` != \`${project}\``);
    }
    if (!resolved.networks || !resolved.networks[network]) {
      problems.push(`network \`${network}\` missing from the merged config`);
    }
    for (const svc of services) {
      const attached = resolved.services && resolved.services[svc] && resolved.services[svc].networks;
      if (!attached || !Object.keys(attached).includes(network)) {
        problems.push(`service \`${svc}\` is not attached to \`${network}\``);
      }
    }
    for (const vol of volumes) {
      const want = mods.composeVolumeName(slug, vol);
      const got = resolved.volumes && resolved.volumes[vol] && resolved.volumes[vol].name;
      if (got !== want) {
        problems.push(`volume \`${vol}\` resolves to name \`${got}\`, expected \`${want}\``);
      }
    }
    if (readFileSync(base, "utf8") !== BASE_FILE) {
      problems.push("the base docker-compose.yml was modified — the app must never rewrite a user's tree");
    }
    if (problems.length) return { status: "fail", detail: problems.join("; ") };
    return { status: "pass", detail: "fixture config resolved: project name, network attachment, volume names, base file untouched" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// --selftest: the detectors, on synthetic inputs (no repo state, no docker)
// ---------------------------------------------------------------------------
// The live run exercises the real module on every `pnpm check`; what must not
// regress here is the DETECTING side — every failure mode this checker claims
// to catch is injected by hand below and must be caught.
const GOOD_OVERRIDE = [
  "# Generated by DevHub (r20-N3). Do not edit by hand; the panel rewrites it.",
  "# Attach every service of this repository to one project-private network.",
  "networks:",
  "  owner-app_devhub:",
  "    external: false",
  "",
  "services:",
  "  web:",
  "    networks:",
  "      - owner-app_devhub",
  "  db:",
  "    networks:",
  "      - owner-app_devhub",
  "",
  "volumes:",
  "  db-data:",
  "    name: owner-app_db-data",
  "",
].join("\n");

function baseMods() {
  return {
    composeProjectName: () => "owner-app",
    composeNetworkName: () => "owner-app_devhub",
    // Folds the way the real module does (src/lib/compose.ts:57): the dirty-input
    // constraint rows must have a module that meets them, or the "healthy" case
    // would fail for the wrong reason and the sabotage cases would prove nothing.
    composeVolumeName: (_slug, volume) => {
      const name = String(volume).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+/, "");
      return `owner-app_${name || "data"}`;
    },
    isolatedOverride: () => GOOD_OVERRIDE,
    isolatedComposeCommand: () => "docker compose -p owner-app -f docker-compose.yml -f devhub-isolation.yml",
  };
}

export function runSelftest() {
  const withMods = (patch) => ({ ...baseMods(), ...patch });
  const fails = (slug, services, volumes, mods) => validateOverride(slug, services, volumes, mods);

  const cases = [
    {
      name: "healthy synthetic override → 0 failures",
      run: () => fails("owner/app", ["web", "db"], ["db-data"], baseMods()),
      expect: [],
    },
    {
      name: "a service attached to `default` instead of the project network → caught",
      run: () =>
        fails("owner/app", ["web", "db"], ["db-data"], withMods({
          isolatedOverride: () => GOOD_OVERRIDE.replace("      - owner-app_devhub", "      - default"),
        })),
      expect: [/attaches to \[default\]/],
    },
    {
      name: "generated-file comment header dropped → caught",
      run: () =>
        fails("owner/app", ["web", "db"], ["db-data"], withMods({
          isolatedOverride: () => GOOD_OVERRIDE.split("\n").slice(1).join("\n"),
        })),
      expect: [/marker comment/],
    },
    {
      name: "project name violating [a-z0-9][a-z0-9_-]* → caught",
      run: () => fails("owner/app", ["web", "db"], ["db-data"], withMods({ composeProjectName: () => "Bad Name!" })),
      expect: [/practice constraint/],
    },
    {
      name: "volume name not project-qualified → caught",
      run: () =>
        fails("owner/app", ["web", "db"], ["db-data"], withMods({
          isolatedOverride: () => GOOD_OVERRIDE.replace("    name: owner-app_db-data", "    name: db-data"),
        })),
      expect: [/project-qualified/],
    },
    {
      name: "`container_name` in the override → caught",
      run: () =>
        fails("owner/app", ["web", "db"], ["db-data"], withMods({
          isolatedOverride: () => `${GOOD_OVERRIDE}container_name: pinned\n`,
        })),
      expect: [/container_name/],
    },
    {
      name: "tab in the generated YAML → parse error, not silent acceptance",
      run: () => {
        const p = parseOverrideYaml("networks:\n\towner-app_devhub:\n    external: false\n");
        return p.error && /tab/.test(p.error) ? [] : ["a tab was accepted"];
      },
      expect: [],
    },
    {
      name: "wrong indent / duplicate key → parse error",
      run: () => {
        const bad1 = parseOverrideYaml("networks:\n owner-app_devhub:\n    external: false\n");
        const bad2 = parseOverrideYaml("networks:\n  a_devhub:\n    external: false\n  a_devhub:\n    external: false\n");
        const out = [];
        if (!bad1.error || !/indentation/.test(bad1.error)) out.push("a 1-space indent was accepted");
        if (!bad2.error || !/duplicate/.test(bad2.error)) out.push("a duplicate key was accepted");
        return out;
      },
      expect: [],
    },
    {
      name: "command missing `-p <project>` → caught",
      run: () => {
        const c = validateCommand("owner/app", withMods({ isolatedComposeCommand: () => "docker compose -f docker-compose.yml -f devhub-isolation.yml" }));
        return c.some((f) => f.includes("-p owner-app")) ? [] : ["missing -p was not caught"];
      },
      expect: [],
    },
    {
      name: "failure classifier: daemon/pipe errors are ENV (exit 2 class), compose rejections are FAIL",
      run: () => {
        const out = [];
        if (classifyConfigFailure("error during connect: open //./pipe/docker_engine: The system cannot find the file specified.") !== "env") {
          out.push("a daemon-pipe error was not classified as env");
        }
        if (classifyConfigFailure('yaml: line 3: did not find expected key while parsing a block mapping') !== "rejected") {
          out.push("a YAML rejection was not classified as a real rejection");
        }
        return out;
      },
      expect: [],
    },
  ];

  let failed = 0;
  for (const c of cases) {
    const produced = c.run();
    const problems = [];
    if (c.expect.length === 0) {
      if (produced.length) problems.push(`expected 0 findings, got: ${produced.join(" | ")}`);
    } else {
      for (const re of c.expect) {
        if (!produced.some((f) => re.test(f))) problems.push(`no finding matches ${re}`);
      }
    }
    if (problems.length) {
      failed += 1;
      console.log(`  FAIL  ${c.name}\n        ${problems.join("; ")}`);
    } else {
      console.log(`  ok    ${c.name}`);
    }
  }
  console.log(
    failed
      ? `\nFAIL: ${failed}/${cases.length} compose self-test scenario(s) broken`
      : `\nOK: ${cases.length} compose self-test scenarios`,
  );
  return failed;
}

if (argv.includes("--selftest")) {
  process.exit(runSelftest() ? 1 : 0);
}

// ---------------------------------------------------------------------------
// The real run
// ---------------------------------------------------------------------------
async function loadCompose() {
  try {
    return await import(pathToFileURL(join(ROOT, "src", "lib", "compose.ts")).href);
  } catch (e) {
    return { error: e };
  }
}

const mods = await loadCompose();
let exit = 0;
let docker = { status: "skipped", detail: "--offline" };
let offline = { scenarios: SCENARIOS.length, failures: ["(not run — src/lib/compose.ts could not be imported)"] };
let loadError = null;

if (mods.error) {
  // Exit 2, not 1: the module failing to load on an old Node is a machine fact,
  // not evidence that the override rules are broken.
  exit = 2;
  loadError = `${mods.error.code || mods.error.message} — src/lib/compose.ts could not be imported (type stripping needs Node >= 22.18 unflagged; measured on v22.19.0)`;
} else {
  offline = runOffline(mods);
  if (offline.failures.length) exit = 1;
  if (!OFFLINE_ONLY) docker = runDockerLayer(mods);
  if (exit === 0) {
    if (docker.status === "fail") exit = 1;
    else if (docker.status === "indeterminate") exit = 2;
  }
}

const status = exit === 0 ? "PASS" : exit === 1 ? "FAIL" : "INDETERMINATE";

if (AS_JSON) {
  console.log(
    JSON.stringify(
      {
        ok: exit === 0,
        status,
        offline: { scenarios: offline.scenarios, failures: offline.failures },
        docker: { status: docker.status, detail: docker.detail || "" },
        loadError,
        exit,
      },
      null,
      2,
    ),
  );
  process.exit(exit);
}

console.log("check-compose.mjs — the `compose config` validator for src/lib/compose.ts");
console.log(`  offline structure:  ${offline.scenarios} scenario(s), ${offline.failures.length} failure(s)`);
const dockerLine =
  docker.status === "pass"
    ? `RUN — docker compose config: PASS — ${docker.detail}`
    : docker.status === "fail"
      ? `RUN — docker compose config: FAIL — ${docker.detail}`
      : docker.status === "indeterminate"
        ? `INDETERMINATE — ${docker.detail}`
        : `SKIPPED — ${docker.detail} (layer not exercised; a skip is never claimed as a pass)`;
console.log(`  docker compose:     ${dockerLine}`);
if (loadError) console.log(`  module load:        ${loadError}`);

if (offline.failures.length) {
  console.log(`\nOFFLINE STRUCTURE FAILURES (${offline.failures.length}):`);
  for (const f of offline.failures) console.log(`  - ${f}`);
}
if (exit === 0) {
  console.log(
    docker.status === "pass"
      ? "OK: override structure matches src/lib/compose.ts, and docker compose config agrees"
      : "OK: override structure matches src/lib/compose.ts (docker layer SKIPPED — not exercised, not claimed)",
  );
} else if (exit === 1) {
  console.log(`\nFAIL: ${offline.failures.length} offline failure(s)${docker.status === "fail" ? "; docker compose config also rejected the override" : ""}`);
} else {
  console.log(`\nINDETERMINATE: ${docker.detail || loadError} — exit 2 is not a pass and not a rule failure; re-run once the environment answers`);
}
process.exit(exit);
