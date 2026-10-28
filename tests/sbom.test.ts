/**
 * r18-R2 — the SBOM generator's CLI contract and the shape of what it produces.
 *
 * Spawned as a subprocess rather than imported, for the same reason tests/supply-chain.test.ts
 * spawns license-report.mjs and tests/checkers.test.ts spawns the five checkers: these scripts
 * run their CLI on import, and a checker's contract is its argv plus its exit code, which only a
 * subprocess observes.
 *
 * What is pinned here is behaviour that a later edit could break silently:
 *   - the three-state exit policy (0 generated-and-valid / 1 generated-but-invalid /
 *     2 cannot determine). A generator that answers 0 when it never read a lockfile is the
 *     failure mode that makes an SBOM useless, so it is asserted directly.
 *   - deterministic `serialNumber` (the generator derives it from component content with a
 *     name-based UUID per RFC 4122 §4.3, so an unchanged dependency set must not mint a new
 *     identity for the same bill of materials).
 *   - referential integrity of the graph over THIS repo's real lockfiles. The counts themselves
 *     are not asserted: they change with every dependency bump, and pinning them would turn a
 *     routine `pnpm add` into a red gate — the same "测试钉错东西" trap this repo already recorded.
 *   - that an unrecognised flag is rejected rather than ignored.
 *
 * `--selftest` (the generator's own fixture suite, which reads no repo state) is run through the
 * CLI too, because the script is only useful if that entry point keeps working from a spawned
 * node with no loader flags.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `pnpm test` runs from the repo root (package.json:18), which is what every other checker
// test in this suite relies on; tests/supply-chain.test.ts:29 does the same.
const ROOT = process.cwd();
const SCRIPT = join(ROOT, "scripts", "sbom.mjs");
const TMP = mkdtempSync(join(tmpdir(), "devhub-sbom-"));

interface Run {
  code: number;
  out: string;
  err: string;
  elapsedMs: number;
}

function run(args: string[], cwd = ROOT): Run {
  const started = Date.now();
  const child = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    cwd,
    shell: false,
    timeout: 180_000,
  });
  const elapsedMs = Date.now() - started;
  if (child.error) {
    // A timeout is reported with its elapsed time rather than as a bare "failed", per the
    // rule tests/supply-chain.test.ts:40-59 established on this machine: a loaded box must not
    // turn the gate into a coin toss whose cause nobody can read afterwards.
    assert.fail(`scripts/sbom.mjs ${args.join(" ")} did not run (${child.error.message}) after ${elapsedMs} ms`);
  }
  return { code: child.status ?? -1, out: child.stdout, err: child.stderr, elapsedMs };
}

test("sbom --selftest passes and says so", () => {
  const r = run(["--selftest"]);
  assert.equal(r.code, 0, `selftest exited ${r.code} in ${r.elapsedMs} ms:\n${r.out}\n${r.err}`);
  assert.match(r.out, /selftest: PASS/);
});

test("sbom --help exits 0 and states the exit codes", () => {
  const r = run(["--help"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /exit 0 = ok/);
  assert.match(r.out, /1 = a checked constraint failed/);
  assert.match(r.out, /2 = cannot determine/);
});

test("sbom rejects an unknown flag instead of ignoring it", () => {
  const r = run(["--frobnicate"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown flag: --frobnicate/);
});

test("sbom answers 2, not 0, when an input is missing", () => {
  const missing = join(TMP, "there-is-no-such-lock.yaml");
  assert.equal(existsSync(missing), false, "the fixture path used for the cannot-determine case must not exist");
  const r = run(["--check", "--lock", missing]);
  assert.equal(r.code, 2, `a missing lockfile must not read as green:\n${r.out}\n${r.err}`);
  assert.match(r.err, /CANNOT DETERMINE/);
});

test("sbom --check over this repo's lockfiles emits a valid CycloneDX 1.6 document", () => {
  const r = run(["--check", "--json"]);
  assert.equal(r.code, 0, `--check exited ${r.code} after ${r.elapsedMs} ms:\n${r.out}\n${r.err}`);
  const bom = JSON.parse(r.out) as {
    bomFormat: string;
    specVersion: string;
    serialNumber: string;
    components: { "bom-ref": string; type: string; name: string; version?: string; purl?: string; hashes?: { alg: string; content: string }[] }[];
    dependencies: { ref: string; dependsOn?: string[] }[];
    metadata: { component: { "bom-ref": string }; tools: unknown };
  };
  assert.equal(bom.bomFormat, "CycloneDX");
  assert.equal(bom.specVersion, "1.6");
  assert.match(bom.serialNumber, /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.ok(bom.components.length > 100, "this repo has hundreds of transitive dependencies; a tiny component list means a parser stopped seeing the lockfile");

  const refs = new Set(bom.components.map((c) => c["bom-ref"]));
  refs.add(bom.metadata.component["bom-ref"]);
  assert.equal(refs.size, bom.components.length + 1, "bom-refs must be unique");
  const graphRefs = new Set(bom.dependencies.map((d) => d.ref));
  assert.equal(graphRefs.size, bom.dependencies.length, "the dependency graph must not repeat a ref");
  for (const ref of refs) assert.ok(graphRefs.has(ref), `component ${ref} is missing from the dependency graph`);
  for (const d of bom.dependencies) {
    for (const on of d.dependsOn ?? []) assert.ok(refs.has(on), `dependency ${d.ref} points at ${on}, which is not in the BOM`);
  }

  const hexish = (s: string) => /^[a-f0-9]+$/.test(s) && [32, 40, 64, 96, 128].includes(s.length);
  const npm = bom.components.filter((c) => (c.purl ?? "").startsWith("pkg:npm/"));
  const cargo = bom.components.filter((c) => (c.purl ?? "").startsWith("pkg:cargo/"));
  assert.ok(npm.length > 0 && cargo.length > 0, `both ecosystems must be present (npm ${npm.length}, cargo ${cargo.length})`);
  for (const c of [...npm, ...cargo]) {
    assert.ok(c.version, `component ${c["bom-ref"]} without a version cannot be matched to an advisory`);
    for (const h of c.hashes ?? []) {
      assert.ok(["SHA-1", "SHA-256", "SHA-384", "SHA-512"].includes(h.alg), `unexpected hash alg ${h.alg} on ${c["bom-ref"]}`);
      assert.ok(hexish(h.content), `hash content for ${c["bom-ref"]} is not the hex form the schema's pattern requires (${h.content.length} chars)`);
    }
  }
  // Scoped packages are the purl case people get wrong: the spec README's own example is
  // pkg:npm/%40angular/animation@12.3.1.
  const scoped = npm.find((c) => c.name.startsWith("@"));
  assert.ok(scoped, "expected at least one scoped npm dependency");
  assert.equal(scoped!.purl, `pkg:npm/%40${scoped!.name.slice(1)}@${scoped!.version}`);
});

test("sbom serialNumber is stable across runs and changes with the component set", () => {
  const first = JSON.parse(run(["--check", "--json"]).out) as { serialNumber: string };
  const second = JSON.parse(run(["--check", "--json"]).out) as { serialNumber: string };
  assert.equal(first.serialNumber, second.serialNumber, "two runs over the same lockfiles minted different serial numbers");
  // A lockfile that names one more component must produce a different serial number; done by
  // generating from a copy with an extra packages: entry rather than by editing the repo's lock.
  const tmp = join(TMP, "ghost-lock.yaml");
  const lines = readFileSync(join(ROOT, "pnpm-lock.yaml"), "utf8").split(/\r?\n/);
  const at = lines.findIndex((l) => l === "packages:");
  assert.ok(at >= 0, "the lockfile has no top-level `packages:` block to inject into");
  lines.splice(at + 1, 0, "", "  'ghost-pkg@9.9.9':", "    resolution: {integrity: sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=}");
  // The fixture goes to the OS temp dir like `checkers.test.ts` does: nothing is written
  // inside the repo, and the repo's own lockfile is only ever read.
  writeFileSync(tmp, lines.join("\n"));
  const changed = JSON.parse(run(["--check", "--json", "--lock", tmp]).out) as { serialNumber: string };
  assert.notEqual(changed.serialNumber, first.serialNumber, "adding a component left the serial number untouched");
});
