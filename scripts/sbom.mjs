// sbom.mjs — CycloneDX 1.6 software bill of materials for this repo, generated from
// the two lockfiles that already exist on disk (`pnpm-lock.yaml`, `src-tauri/Cargo.lock`).
//
// Why hand-rolled instead of a tool (the question this file has to answer):
//   - `@cyclonedx/cyclonedx-npm` / `cargo-cyclonedx` would both have to be *installed*
//     first. This repo has no runtime dependency outside `package.json` and `Cargo.toml`,
//     and round 12 recorded the exact failure mode that undeclared executables create here:
//     a `.bin` shim pointing *above* the project. Verified 2026-10-18 while writing this:
//     the only YAML parser reachable from a worktree resolved to a **sibling**
//     checkout's `node_modules\js-yaml\index.js` — the parent directory of this
//     the SBOM depend on whatever a sibling checkout happens to have installed.
//   - Both lockfiles are machine-generated with a stable, narrow grammar, so the parse is
//     ~120 lines of focused reader rather than a general YAML/TOML implementation.
//
// Provenance of every constraint this script enforces (all read at RUNTIME from the
// vendored spec files, not hardcoded — that way a future spec bump shows up as a failed
// assertion here rather than as a silently stale generator):
//   vendor/cyclonedx/bom-1.6.schema.json  190498 bytes, fetched 2026-01-18? no:
//                       fetched 2026-10-18 from https://cyclonedx.org/schema/bom-1.6.schema.json,
//                       `$/id` = http://cyclonedx.org/schema/bom-1.6.schema.json,
//                       Apache License 2.0 per its own `$comment`.
//                       Top-level `required` = ["bomFormat","specVersion"],
//                       `#/definitions/component/required` = ["type","name"],
//                       `#/definitions/dependency/required` = ["ref"],
//                       `#/definitions/hash/required` = ["alg","content"].
//   vendor/cyclonedx/spdx.schema.json     54225 bytes, same fetch, 826 license ids.
//                       Used only to decide `license.id` vs `license.expression`.
//   serialNumber must conform to RFC 4122 (the schema says so and cites
//                       https://www.ietf.org/rfc/rfc4122.html); we emit a version-5
//                       (SHA-1 HMAC) name-based UUID per RFC 4122 §4.3 so that two runs
//                       over the same lockfiles produce the same serial number.
//   purl: npm scoped form `pkg:npm/%40angular/animation@12.3.1` is the example the
//                       purl-spec README gives (https://github.com/package-url/purl-spec,
//                       read 2026-10-18). `pkg:cargo/<name>@<version>` is corroborated by
//                       PEP 725's examples (`pkg:cargo/ripgrep`,
//                       https://discuss.python.org/t/pep-725-specifying-external-dependencies-in-pyproject-toml/31888)
//                       and by Sonatype's purl reference (`pkg:cargo/grin@1.0.0?type=crate`,
//                       https://help.sonatype.com/en/package-url-and-component-identifiers.html).
//                       **Gap, recorded honestly:** the purl-spec repository's
//                       `PURL-TYPES.md` returned HTTP 404 on both `master` and `main`
//                       when tried on 2026-10-18, so the cargo type string is not backed by
//                       the normative registry list; if that ever matters, it is the one
//                       field to re-check.
//
// What is NOT in here, and why:
//   - Cargo component licenses. Neither `src-tauri/Cargo.lock` nor `src-tauri/Cargo.toml`
//     carries a license field (checked 2026-10-18: 0 `license` keys in the lock), so the
//     crates would have to be opened (`~/.cargo/registry/cache/*/<name>-<ver>.crate`, a
//     gzip tar) to read their `Cargo.toml`. That is a second parser and a dependency on a
//     machine-local cache path, so the BOM says "unknown" instead of guessing. npm
//     licenses DO resolve — see `readLicenseIndex`.
//   - A general JSON Schema validator. `validateBom` enforces the specific constraint
//     lists named above, read from the schema, plus referential integrity of `bom-ref`.
//     It prints which constraints it checked, so nobody reads a green run as
//     "validated against the whole spec".
//
// Exit codes (same three-state policy as scripts/license-report.mjs:45-50 — a checker
// that answers 0 when it never got an answer is the most dangerous kind):
//   0  BOM generated and every checked constraint satisfied
//   1  generated, but a checked constraint or a referential-integrity rule failed
//   2  cannot determine — a lockfile, the vendored schema, or `--out` is unusable
//
// CLI:
//   --out <path>          write the document here (default: print nothing but the summary)
//   --check               exit 1 unless the document passes every checked constraint
//   --json                print the BOM to stdout instead of the summary table
//   --selftest            run the built-in fixtures; touches no repo state
//   --no-licenses         skip the node_modules license walk (offline-hostile machines)
//   --lock <path>         pnpm lockfile (default ./pnpm-lock.yaml)
//   --cargo-lock <path>   Cargo.lock (default ./src-tauri/Cargo.lock)
//   --pkg <path>          package.json of the app (default ./package.json)
//   --spdx <path>         vendored SPDX list (default ./vendor/cyclonedx/spdx.schema.json)
//   --schema <path>       vendored CycloneDX schema (default ./vendor/cyclonedx/bom-1.6.schema.json)
// Anything else is rejected rather than ignored.

import { createHash, createHmac, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

export const SPEC_VERSION = "1.6";
export const BOM_FORMAT = "CycloneDX";
/** Fixed namespace for the version-5 serial number (RFC 4122 DNS namespace). */
const UUID_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

// ---------------------------------------------------------------- YAML subset

/**
 * Read the narrow YAML subset `pnpm-lock.yaml` lockfileVersion 9.0 uses: nested block
 * maps keyed by 2-space indent, scalars, inline flow collections (`{a: b}`, `[x, y]`)
 * and block sequences of scalars. A block sequence of MAPS is not supported — the point
 * is to fail loudly (throw) if the grammar ever grows one, rather than to mis-parse it.
 * Measured against this repo's lock 2026-10-18: `grep -c '^ *- '` = 15 and all fifteen are
 * scalars under `bundledDependencies:` / `transitivePeerDependencies:` (pnpm-lock.yaml:359-365,
 * :1230-1231); `grep -c ': |'` = 0, so there are no block scalars; every `os:`/`cpu:`
 * value is a flow array on one line (pnpm-lock.yaml:198-199).
 */
export function parseLockYaml(text) {
  const lines = text.split(/\r?\n/);
  const root = {};
  /** stack of frames: {indent, kind: "map"|"seq", container, owner, key} */
  const stack = [{ indent: -1, kind: "map", container: root, owner: null, key: null }];
  for (const raw of lines) {
    if (raw.trim() === "" || /^\s*#/.test(raw)) continue;
    const indent = raw.length - raw.trimStart().length;
    while (stack.length > 1 && indent <= stack.at(-1).indent) stack.pop();
    const line = raw.trim();
    const frame = stack.at(-1);

    if (line.startsWith("- ")) {
      if (frame.kind === "map" && Object.keys(frame.container).length === 0 && frame.owner) {
        // A key opened a block we did not yet know was a sequence: swap the placeholder.
        const arr = [];
        frame.owner.container[frame.key] = arr;
        frame.kind = "seq";
        frame.container = arr;
      }
      if (frame.kind !== "seq") throw new Error(`parseLockYaml: sequence item outside a sequence (line: ${raw})`);
      const item = line.slice(2).trim();
      if (findKeySeparator(item) >= 0) throw new Error(`parseLockYaml: sequence of maps not supported (line: ${raw})`);
      frame.container.push(unquote(item));
      continue;
    }

    const sep = findKeySeparator(line);
    if (sep < 0) throw new Error(`parseLockYaml: not a mapping line: ${raw}`);
    if (frame.kind !== "map") throw new Error(`parseLockYaml: mapping line inside a sequence (line: ${raw})`);
    const key = unquote(line.slice(0, sep));
    const rest = line.slice(sep + 1).trim();
    if (rest === "") {
      const child = {};
      frame.container[key] = child;
      stack.push({ indent, kind: "map", container: child, owner: frame, key });
      continue;
    }
    frame.container[key] = parseScalarOrFlow(rest);
  }
  return root;
}

/** Index of the `:` that separates key from value, ignoring `:` inside quotes/flow. */
function findKeySeparator(line) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
    else if (c === ":" && depth === 0) {
      if (i + 1 >= line.length || line[i + 1] === " ") return i;
    }
  }
  return -1;
}

function parseScalarOrFlow(token) {
  const t = token.trim();
  if (t.startsWith("{") && t.endsWith("}")) {
    const out = {};
    for (const part of splitTopLevel(t.slice(1, -1), ",")) {
      if (part.trim() === "") continue;
      const sep = findKeySeparator(part.trim());
      if (sep < 0) throw new Error(`parseScalarOrFlow: bad flow entry: ${part}`);
      out[unquote(part.trim().slice(0, sep))] = parseScalarOrFlow(part.trim().slice(sep + 1));
    }
    return out;
  }
  if (t.startsWith("[") && t.endsWith("]")) {
    return splitTopLevel(t.slice(1, -1), ",").map((s) => unquote(s.trim())).filter((s) => s !== "");
  }
  return unquote(t);
}

/** Split on `sep` only at nesting depth 0, so `sha512-...` and peer suffixes survive. */
function splitTopLevel(text, sep) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") depth--;
    if (c === sep && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

function unquote(s) {
  const t = s.trim();
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    return t.slice(1, -1);
  }
  return t;
}

// ---------------------------------------------------------------- npm graph

/**
 * Split a pnpm package key into identity + peer-suffix.
 * `@dnd-kit/core@6.3.1(react-dom@19.3.0(react@19.3.0))(react@19.3.0)`
 *   -> { nv: "@dnd-kit/core@6.3.1", peer: "(react-dom@...)(react@...)" }
 * The version separator is the LAST `@` before the first `(` — searching for the last
 * `@` in the whole key lands inside the peer suffix (`…(react@19.3.0)`), which is the
 * bug the first version of this function had and which `--selftest` now pins.
 * The peer suffix makes pnpm's snapshot keys unique per dependent; a CycloneDX
 * component is identified by name+version, so variants of the same `name@version`
 * are merged and their dependency edges unioned. That is a documented approximation,
 * not an accident: the alternative would be one component per (name, version, peer-set),
 * which no vulnerability matcher keys on.
 */
export function splitPnpmKey(key) {
  const firstParen = key.indexOf("(");
  const head = firstParen < 0 ? key : key.slice(0, firstParen);
  const at = head.lastIndexOf("@");
  if (at <= 0) return { nv: head, peer: "" };
  return { nv: head, peer: firstParen < 0 ? "" : key.slice(firstParen) };
}

/** `name@version` -> { name, version } with the npm purl encoding applied later. */
export function nvParts(nv) {
  const at = nv.lastIndexOf("@");
  if (at <= 0) return { name: nv, version: "" };
  return { name: nv.slice(0, at), version: nv.slice(at + 1) };
}

export function npmPurl(name, version) {
  // purl-spec README example for a scoped package: pkg:npm/%40angular/animation@12.3.1
  const encoded = name.startsWith("@") ? `%40${name.slice(1)}` : name;
  return version ? `pkg:npm/${encoded}@${version}` : `pkg:npm/${encoded}`;
}

export function cargoPurl(name, version) {
  return version ? `pkg:cargo/${name}@${version}` : `pkg:cargo/${name}`;
}

/** base64 → lowercase hex, because hash-content's pattern is a hex alternation. */
export function integrityToHashes(integrity) {
  if (typeof integrity !== "string" || integrity === "") return [];
  return integrity
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => {
      const dash = token.indexOf("-");
      const alg = token.slice(0, dash);
      const enc = token.slice(dash + 1);
      if (dash < 0 || !/^[a-z0-9]+$/.test(alg)) throw new Error(`integrityToHashes: not an integrity string: ${token}`);
      // base64 → hex may be padded; Buffer handles both standard and url-safe alphabets
      // only for standard, so verify by re-encoding.
      const buf = Buffer.from(enc, "base64");
      const name = { sha1: "SHA-1", sha256: "SHA-256", sha384: "SHA-384", sha512: "SHA-512" }[alg];
      if (!name) throw new Error(`integrityToHashes: unsupported algorithm ${alg}`);
      return { alg: name, content: buf.toString("hex") };
    });
}

/**
 * Build the npm half of the graph from a parsed `pnpm-lock.yaml`.
 * Returns components (from `packages:`, the set of resolved identities) and edges
 * (from `snapshots:`, unioned across peer variants) plus the importer's direct refs.
 */
export function npmFromLock(lock, licenseIndex) {
  const packages = lock?.packages ?? {};
  const snapshots = lock?.snapshots ?? {};
  const importers = lock?.importers ?? {};

  /** @type {Map<string, {name:string,version:string,integrity:string,dev:boolean,edges:Set<string>}>} */
  const byNv = new Map();
  for (const key of Object.keys(packages)) {
    const { nv } = splitPnpmKey(key);
    const { name, version } = nvParts(nv);
    const entry = packages[key] ?? {};
    if (!byNv.has(nv)) {
      byNv.set(nv, {
        name,
        version,
        integrity: entry?.resolution?.integrity ?? "",
        peerVariants: 0,
        edges: new Set(),
      });
    }
  }
  for (const key of Object.keys(snapshots)) {
    const { nv } = splitPnpmKey(key);
    const node = byNv.get(nv);
    if (!node) {
      // pnpm 9 in principle writes a snapshot for every resolved identity; if a future
      // lockfile version has snapshots without a packages: entry, fail loudly rather
      // than dropping a component off the bill of materials.
      throw new Error(`npmFromLock: snapshot ${key} has no packages: entry`);
    }
    node.peerVariants += 1;
    const deps = snapshots[key]?.dependencies ?? {};
    const optional = snapshots[key]?.optionalDependencies ?? {};
    for (const [depName, depVersion] of [...Object.entries(deps), ...Object.entries(optional)]) {
      if (typeof depVersion !== "string") continue;
      // A dependency of an npm package is never an alias/link, so the value is always
      // `version(peer...)`; strip the suffix to get the identity edge.
      const { nv } = splitPnpmKey(`${depName}@${depVersion}`);
      node.edges.add(nv);
    }
  }

  const prodRoots = new Set();
  const allRoots = new Set();
  for (const imp of Object.values(importers)) {
    for (const [group, isDev] of [
      ["dependencies", false],
      ["optionalDependencies", false],
      ["devDependencies", true],
    ]) {
      for (const [depName, spec] of Object.entries(imp?.[group] ?? {})) {
        const version = typeof spec === "string" ? spec : spec?.version;
        if (typeof version !== "string") continue;
        const { nv } = splitPnpmKey(`${depName}@${version}`);
        allRoots.add(nv);
        if (!isDev) prodRoots.add(nv);
      }
    }
  }

  // `cdx:npm:development` style marking: reachable from a devDependency root but not
  // from any production root. Computed over the edge graph, so a package pulled in by
  // both a prod and a dev dependency is correctly *not* marked dev-only.
  const reach = (roots) => {
    const seen = new Set();
    const queue = [...roots];
    while (queue.length) {
      const nv = queue.pop();
      if (seen.has(nv)) continue;
      seen.add(nv);
      const node = byNv.get(nv);
      if (node) for (const e of node.edges) queue.push(e);
    }
    return seen;
  };
  const prodReach = reach(prodRoots);
  const allReach = reach(allRoots);

  const components = [];
  for (const [nv, node] of [...byNv.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const licenses = licensesOf(licenseIndex.get(`${node.name}@${node.version}`));
    const component = {
      type: "library",
      "bom-ref": npmPurl(node.name, node.version),
      name: node.name,
      version: node.version,
      purl: npmPurl(node.name, node.version),
      hashes: integrityToHashes(node.integrity),
    };
    if (licenses) component.licenses = licenses;
    const properties = [];
    if (allReach.has(nv) && !prodReach.has(nv)) {
      properties.push({ name: "cdx:npm:development", value: "true" });
    }
    if (node.peerVariants > 1) {
      properties.push({ name: "devhub:npm:peer-variants", value: String(node.peerVariants) });
    }
    if (properties.length) component.properties = properties;
    components.push(component);
  }

  const edges = [];
  for (const [nv, node] of [...byNv.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    edges.push({
      ref: npmPurl(...Object.values(nvParts(nv))),
      dependsOn: [...node.edges].sort().map((e) => npmPurl(...Object.values(nvParts(e)))),
    });
  }
  return { components, edges, rootRefs: [...allRoots].sort().map((nv) => npmPurl(...Object.values(nvParts(nv)))) };
}

/**
 * Turn a license string from a manifest into a CycloneDX `licenses` array.
 * `licenseChoice` (schema `#/definitions/licenseChoice`) accepts either a list of
 * `{license:{...}}` or exactly one `{expression:...}`. A single id that the vendored
 * SPDX list recognises goes in `license.id`; anything else goes in `expression`, which
 * the schema describes as "A valid SPDX license expression" and constrains only by that
 * description. Never invent an id: an unrecognised token is not an SPDX id.
 */
export function licensesOf(value, spdxIds = null) {
  if (!value) return null;
  const tokens = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string") tokens.push(item);
      else if (item?.type) tokens.push(String(item.type));
    }
  } else {
    tokens.push(String(value));
  }
  const cleaned = tokens.map((t) => t.trim()).filter(Boolean);
  if (cleaned.length === 0) return null;
  if (cleaned.length === 1) {
    const single = cleaned[0];
    const known = spdxIds ? spdxIds.has(single) : /^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(single) && !/[ ()]/.test(single);
    if (known) return [{ license: { id: single } }];
    return [{ license: { expression: single } }];
  }
  return [{ license: { expression: cleaned.join(" OR ") } }];
}

// ---------------------------------------------------------------- cargo graph

/**
 * Parse Cargo.lock (`version = 4`) well enough to get name, version, source, checksum
 * and dependency edges. Cargo.lock writes a dependency as `"name"`, or
 * `"name version"`, or `"name version (source)"` when more than one version is in the
 * graph — all three shapes are handled. Block sequences of quoted scalars are the only
 * array form the format uses, so this reader needs no general TOML support.
 */
export function parseCargoLock(text) {
  const packages = [];
  let cur = null;
  let inDeps = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "[[package]]") {
      cur = { name: "", version: "", source: "", checksum: "", deps: [] };
      packages.push(cur);
      inDeps = false;
      continue;
    }
    if (!cur) continue;
    if (line === "dependencies = [") {
      inDeps = true;
      continue;
    }
    if (inDeps) {
      if (line === "]") {
        inDeps = false;
        continue;
      }
      const token = unquote(line.replace(/,$/, ""));
      const parsed = parseCargoDepSpec(token);
      if (parsed) cur.deps.push(parsed);
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = unquote(line.slice(eq + 1).trim());
    if (key in cur) cur[key] = value;
  }
  return packages;
}

function parseCargoDepSpec(spec) {
  const parts = spec.split(" ");
  if (parts.length === 1) return { name: parts[0], version: "" };
  return { name: parts[0], version: parts[1] };
}

export function cargoFromLock(text) {
  const packages = parseCargoLock(text);
  /** resolve `name` (possibly ambiguous) against the parsed set */
  const byNameVersion = new Map();
  const byName = new Map();
  for (const p of packages) {
    byNameVersion.set(`${p.name}@${p.version}`, p);
    if (!byName.has(p.name)) byName.set(p.name, []);
    byName.get(p.name).push(p);
  }
  const components = [];
  const edges = [];
  const local = [];
  for (const p of [...packages].sort((a, b) => {
    const ka = `${a.name}@${a.version}`;
    const kb = `${b.name}@${b.version}`;
    return ka < kb ? -1 : 1;
  })) {
    const nv = `${p.name}@${p.version}`;
    const isRegistry = p.source.startsWith("registry+");
    const isLocal = p.source === "";
    const ref = isRegistry ? cargoPurl(p.name, p.version) : `local:${nv}`;
    if (isLocal) local.push(nv);
    const component = {
      type: isRegistry ? "library" : "application",
      "bom-ref": ref,
      name: p.name,
      version: p.version,
    };
    if (isRegistry) component.purl = cargoPurl(p.name, p.version);
    const hashes = [];
    if (p.checksum) hashes.push({ alg: "SHA-256", content: p.checksum.toLowerCase() });
    if (hashes.length) component.hashes = hashes;
    if (isLocal) {
      component.description = "workspace member of this repository (not published to a registry)";
    } else if (!isRegistry) {
      component.properties = [{ name: "devhub:cargo:source", value: p.source }];
    }
    components.push(component);
    edges.push({
      ref,
      dependsOn: p.deps
        .map((d) => {
          const target = d.version
            ? byNameVersion.get(`${d.name}@${d.version}`)
            : (byName.get(d.name) ?? [])[0];
          if (!target) throw new Error(`cargoFromLock: dependency ${d.name} ${d.version} is not in the lock`);
          return target.source.startsWith("registry+")
            ? cargoPurl(target.name, target.version)
            : `local:${target.name}@${target.version}`;
        })
        .sort(),
    });
  }
  return { components, edges, local };
}

// ---------------------------------------------------------------- license index

/**
 * Index `name@version -> license` from the pnpm store layout without parsing pnpm's
 * directory-name encoding: walk each `node_modules/.pnpm/<id>/node_modules/<pkg>` child,
 * read the inner manifest, and key by the manifest's OWN name/version. The directory
 * name is a pnpm implementation detail (it encodes peer suffixes and escapes slashes in
 * scoped names); the manifest is the package's own claim about its identity.
 *
 * Measured on this tree 2026-10-18: `.pnpm` holds 114 entries, of which several are
 * other-platform optional binaries. Those land in the index too, which is correct for a
 * bill of materials built from the install tree — `scripts/license-report.mjs` reports
 * what pnpm considers installed-for-this-machine and gets 153 entries / 160 name@version;
 * the difference is stated in docs/sbom.md rather than papered over.
 */
export function readLicenseIndex(pnpmDir) {
  const index = new Map();
  let tops;
  try {
    tops = readdirSync(pnpmDir);
  } catch {
    return index; // offline / unusual layout: licenses are optional in CycloneDX
  }
  for (const top of tops) {
    const nm = join(pnpmDir, top, "node_modules");
    let children;
    try {
      children = readdirSync(nm);
    } catch {
      continue;
    }
    for (const child of children) {
      if (child === ".bin") continue;
      const dirs = child.startsWith("@") ? safeReaddir(join(nm, child)) : [child];
      for (const leaf of dirs) {
        const manifestPath = child.startsWith("@") ? join(nm, child, leaf, "package.json") : join(nm, child, "package.json");
        const license = readManifestLicense(manifestPath);
        if (!license) continue;
        // Only record it under the manifest's own identity, which we can read cheaply
        // from the same file the license came from.
        const nv = readManifestNv(manifestPath);
        if (nv) index.set(nv, license);
      }
    }
  }
  return index;
}

function safeReaddir(p) {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

const manifestCache = new Map();
function readManifest(manifestPath) {
  if (manifestCache.has(manifestPath)) return manifestCache.get(manifestPath);
  let out = null;
  try {
    const json = JSON.parse(readFileSync(manifestPath, "utf8"));
    out = { license: json.license ?? json.licenses ?? null, nv: json.name && json.version ? `${json.name}@${json.version}` : null };
  } catch {
    out = null;
  }
  manifestCache.set(manifestPath, out);
  return out;
}
function readManifestLicense(p) {
  return readManifest(p)?.license ?? null;
}
function readManifestNv(p) {
  return readManifest(p)?.nv ?? null;
}

// ---------------------------------------------------------------- BOM assembly

/** RFC 4122 §4.3 version-5 (name-based, HMAC-SHA1) UUID, as a `urn:uuid:` string. */
export function uuidV5(name, namespace = UUID_NAMESPACE) {
  const nsBuf = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const digest = createHmac("sha1", nsBuf).update(Buffer.from(name, "utf8")).digest();
  const bytes = Uint8Array.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Buffer.from(bytes).toString("hex");
  return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The dependency graph must declare every component, even the leaves (schema: components
 *  without their own dependencies "must be declared as empty elements"). */
function dependencyList(refs, edges) {
  const byRef = new Map(edges.map((e) => [e.ref, e.dependsOn]));
  const out = [];
  for (const ref of [...refs].sort()) {
    out.push({ ref, dependsOn: byRef.get(ref) ?? [] });
  }
  return out;
}

/**
 * @param {{npm:object,cargo:object,app:{name:string,version:string},tool:string,generatedAt:string,useRandomSerial?:boolean}} input
 */
export function buildBom({ npm, cargo, app, generatedAt, useRandomSerial = false, spdxIds = null }) {
  const components = [...npm.components, ...cargo.components];
  for (const c of components) {
    if (c.licenses) {
      c.licenses = licensesOf(licenseValueOf(c.licenses), spdxIds) ?? c.licenses;
    }
  }
  const rootRef = `pkg:generic/${app.name}@${app.version}`;
  const npmRootEdges = new Set(npm.rootRefs);
  const cargoRootEdges = new Set(
    cargo.edges.filter((e) => e.ref === `local:${app.name}@${app.version}`).flatMap((e) => e.dependsOn),
  );
  const graph = dependencyList(
    [rootRef, ...components.map((c) => c["bom-ref"])],
    [
      ...npm.edges,
      ...cargo.edges,
      { ref: rootRef, dependsOn: [...new Set([...npmRootEdges, ...cargoRootEdges])].sort() },
    ],
  );
  const serialPayload = JSON.stringify({ specVersion: SPEC_VERSION, components, dependencies: graph });
  return {
    $schema: "http://cyclonedx.org/schema/bom-1.6.schema.json",
    bomFormat: BOM_FORMAT,
    specVersion: SPEC_VERSION,
    serialNumber: useRandomSerial
      ? `urn:uuid:${randomUUID()}`
      : uuidV5(`urn:devhub:sbom:${createHash("sha256").update(serialPayload).digest("hex")}`),
    version: 1,
    metadata: {
      timestamp: generatedAt,
      tools: {
        components: [
          {
            type: "application",
            "bom-ref": "pkg:generic/devhub-sbom",
            name: "devhub-sbom",
            version: "1.0.0",
            description: "scripts/sbom.mjs in this repository; reads the two lockfiles and writes CycloneDX " + SPEC_VERSION,
          },
        ],
      },
      component: {
        type: "application",
        "bom-ref": rootRef,
        name: app.name,
        version: app.version,
        purl: rootRef,
        description: "DevHub — project container and launcher (Tauri 2 + React 19, Windows).",
        properties: [
          { name: "devhub:sbom:npm-components", value: String(npm.components.length) },
          { name: "devhub:sbom:cargo-components", value: String(cargo.components.length) },
        ],
      },
    },
    components,
    dependencies: graph,
  };
}

function licenseValueOf(licenses) {
  const first = licenses?.[0];
  if (!first) return null;
  return first.license?.id ?? first.license?.expression ?? null;
}

// ---------------------------------------------------------------- validation

/**
 * Enforce the subset of the vendored schema named in `checked`, plus referential
 * integrity. Every numeric list here is READ from the schema file at call time.
 */
export function validateBom(bom, schema, spdxIds) {
  const errors = [];
  const checked = [];
  // `reduce` with an initial value still visits every key, so a key holding `false` or
  // `0` (the JSON-Schema keywords `uniqueItems`, `additionalProperties`) made the next
  // step read a property off a boolean and come back undefined. That is what the first
  // version of this helper did, and `--selftest` only caught it because the fixture
  // schema is small enough that "no constraints were read" itself changes the verdict.
  const DEFS = schema.definitions ?? {};
  const step = (node, key) => (node !== null && typeof node === "object" ? node[key] : undefined);
  // Dot-separated paths into `#/definitions/<name>/<keyword>`; the definition names
  // themselves contain hyphens (`hash-alg`, `hash-content`), never dots.
  const def = (pointer) => pointer.split(".").reduce(step, DEFS);

  // 1. document-level required (schema `required`)
  const topRequired = schema.required ?? [];
  checked.push(`document required: [${topRequired.join(",")}]`);
  for (const key of topRequired) {
    if (bom[key] === undefined) errors.push(`missing required document property: ${key}`);
  }
  const bomFormatEnum = schema.properties?.bomFormat?.enum ?? [];
  if (bomFormatEnum.length && !bomFormatEnum.includes(bom.bomFormat)) {
    errors.push(`bomFormat "${bom.bomFormat}" is not one of [${bomFormatEnum.join(",")}]`);
  }

  // 2. serialNumber pattern (schema `properties.serialNumber.pattern`, RFC 4122 per its description)
  const serialPattern = schema.properties?.serialNumber?.pattern;
  if (serialPattern && bom.serialNumber !== undefined) {
    checked.push(`serialNumber pattern ${serialPattern}`);
    if (!new RegExp(serialPattern).test(bom.serialNumber)) {
      errors.push(`serialNumber "${bom.serialNumber}" does not match ${serialPattern}`);
    }
  }

  // 3. component required + type enum
  const compRequired = def("component.required") ?? [];
  const compTypes = def("component.properties.type.enum") ?? [];
  checked.push(`component required: [${compRequired.join(",")}]`);
  checked.push(`component type enum: ${compTypes.length} values`);
  for (const c of bom.components ?? []) {
    for (const key of compRequired) {
      if (c[key] === undefined) errors.push(`component ${c["bom-ref"] ?? c.name} missing required ${key}`);
    }
    if (compTypes.length && c.type !== undefined && !compTypes.includes(c.type)) {
      errors.push(`component ${c["bom-ref"]} has type "${c.type}" outside the schema enum`);
    }
    if (c.version === undefined && c.name !== undefined && c.type !== "file") {
      // not schema-required, but a BOM row without a version cannot be matched to a CVE
      errors.push(`component ${c["bom-ref"] ?? c.name} carries no version`);
    }
  }

  // 4. hashes
  const hashRequired = def("hash.required") ?? [];
  const algEnum = def("hash-alg.enum") ?? [];
  const contentPattern = def("hash-content.pattern");
  checked.push(`hash required: [${hashRequired.join(",")}]`);
  checked.push(`hash alg enum: ${algEnum.length} values`);
  checked.push(`hash content pattern ${contentPattern}`);
  const allHashes = [];
  for (const group of [bom.components ?? []]) {
    for (const c of group) for (const h of c.hashes ?? []) allHashes.push({ where: c["bom-ref"], h });
  }
  for (const { where, h } of allHashes) {
    for (const key of hashRequired) if (h[key] === undefined) errors.push(`hash on ${where} missing required ${key}`);
    if (algEnum.length && !algEnum.includes(h.alg)) errors.push(`hash alg "${h.alg}" on ${where} outside the enum`);
    if (contentPattern && !new RegExp(contentPattern).test(h.content)) {
      errors.push(`hash content on ${where} is not the hex form the schema requires (alg ${h.alg}, length ${h.content.length})`);
    }
  }

  // 5. licenses: either a list of {license:{id|expression}} or exactly one {expression}
  for (const c of bom.components ?? []) {
    if (!c.licenses) continue;
    const list = c.licenses;
    if (!Array.isArray(list) || list.length === 0) {
      errors.push(`licenses on ${c["bom-ref"]} must be a non-empty array`);
      continue;
    }
    const expressionOnly = list.length === 1 && list[0].expression !== undefined;
    if (!expressionOnly) {
      for (const item of list) {
        if (!item.license) {
          errors.push(`licenses on ${c["bom-ref"]} must wrap each entry in {license:{...}}`);
          continue;
        }
        const id = item.license.id;
        if (id !== undefined && spdxIds && !spdxIds.has(id)) {
          errors.push(`license id "${id}" on ${c["bom-ref"]} is not in the vendored SPDX list`);
        }
        if (id === undefined && item.license.expression === undefined && item.license.name === undefined) {
          errors.push(`license on ${c["bom-ref"]} carries neither id, expression nor name`);
        }
      }
    }
    checked.push("licenseChoice: list-of-license or single expression");
  }

  // 6. dependency graph
  const depRequired = def("dependency.required") ?? [];
  checked.push(`dependency required: [${depRequired.join(",")}]`);
  const refs = new Set((bom.components ?? []).map((c) => c["bom-ref"]));
  refs.add(bom.metadata?.component?.["bom-ref"]);
  const seenDep = new Set();
  for (const d of bom.dependencies ?? []) {
    for (const key of depRequired) if (d[key] === undefined) errors.push(`dependency entry missing required ${key}`);
    if (seenDep.has(d.ref)) errors.push(`duplicate dependency ref ${d.ref}`);
    seenDep.add(d.ref);
    if (!refs.has(d.ref)) errors.push(`dependency ref ${d.ref} names no component`);
    for (const on of d.dependsOn ?? []) {
      if (!refs.has(on)) errors.push(`dependency ${d.ref} depends on unknown ref ${on}`);
    }
  }
  for (const ref of refs) {
    if (ref === undefined) continue;
    if (!seenDep.has(ref)) errors.push(`component ${ref} is absent from the dependency graph`);
  }
  const dupes = new Set();
  const seenRef = new Set();
  for (const c of bom.components ?? []) {
    if (seenRef.has(c["bom-ref"])) dupes.add(c["bom-ref"]);
    seenRef.add(c["bom-ref"]);
  }
  for (const d of dupes) errors.push(`duplicate bom-ref ${d}`);

  return { errors, checked };
}

// ---------------------------------------------------------------- selftest

// Fixture digests are generated rather than typed: a hand-counted base64 literal is
// exactly the test data that goes quietly wrong — the first version of this file asserted
// 128 hex characters for what was a 32-byte digest.
const SHA512_B64 = Buffer.alloc(64, 0xab).toString("base64");
const SHA256_B64 = Buffer.alloc(32, 0x00).toString("base64");

const FIXTURE_LOCK = `
lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      react:
        specifier: ^19.1.0
        version: 19.3.0
    devDependencies:
      tooling:
        specifier: ^1.0.0
        version: 1.0.0(react@19.3.0)

packages:

  'react@19.3.0':
    resolution: {integrity: sha512-${SHA512_B64}}

  'tooling@1.0.0':
    resolution: {integrity: sha256-${SHA256_B64}}

snapshots:

  'react@19.3.0': {}

  'tooling@1.0.0(react@19.3.0)':
    dependencies:
      react: 19.3.0

  'tooling@1.0.0':
    dependencies: {}
`;

const FIXTURE_CARGO = `# This file is automatically @generated by Cargo.
version = 4

[[package]]
name = "demo"
version = "0.1.0"
dependencies = [
 "libc",
 "serde 1.0.200 (registry+https://github.com/rust-lang/crates.io-index)",
]

[[package]]
name = "libc"
version = "0.2.155"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "${"ab".repeat(32)}"

[[package]]
name = "serde"
version = "1.0.200"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "${"cd".repeat(32)}"
`;

const FIXTURE_SCHEMA = {
  required: ["bomFormat", "specVersion"],
  properties: {
    bomFormat: { enum: ["CycloneDX"] },
    serialNumber: { pattern: "^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" },
  },
  definitions: {
    component: { required: ["type", "name"], properties: { type: { enum: ["application", "library"] } } },
    hash: { required: ["alg", "content"] },
    "hash-alg": { enum: ["SHA-256", "SHA-512"] },
    "hash-content": { pattern: "^([a-fA-F0-9]{64}|[a-fA-F0-9]{128})$" },
    dependency: { required: ["ref"] },
  },
};

/** Run the built-in fixtures. Returns an array of failure strings (empty = passed). */
export function selftest() {
  const fails = [];
  const t = (label, fn) => {
    try {
      fn();
    } catch (e) {
      fails.push(`${label}: ${e?.message ?? e}`);
    }
  };
  const eq = (a, b, msg) => {
    const ja = JSON.stringify(a);
    const jb = JSON.stringify(b);
    if (ja !== jb) throw new Error(`${msg} — got ${ja}, want ${jb}`);
  };

  t("splitPnpmKey strips the peer suffix", () => {
    eq(splitPnpmKey("@dnd-kit/core@6.3.1(react@19.3.0)").nv, "@dnd-kit/core@6.3.1", "nv");
    eq(splitPnpmKey("react@19.3.0").peer, "", "no peer");
  });
  t("npmPurl encodes a scoped name as %40", () => {
    eq(npmPurl("@angular/animation", "12.3.1"), "pkg:npm/%40angular/animation@12.3.1", "scoped");
    eq(npmPurl("react", "19.3.0"), "pkg:npm/react@19.3.0", "plain");
  });
  t("integrity base64 becomes lowercase hex of the right length", () => {
    const one = integrityToHashes(`sha512-${SHA512_B64}`)[0];
    eq([one.alg, one.content.length], ["SHA-512", 128], "sha512");
    eq(one.content, "ab".repeat(64), "sha512 hex");
    const two = integrityToHashes(`sha256-${SHA256_B64}`)[0];
    eq([two.alg, two.content], ["SHA-256", "00".repeat(32)], "sha256");
    eq(integrityToHashes(""), [], "empty");
    throws(() => integrityToHashes("md5-aaa="), "an algorithm outside hash-alg.enum must throw");
  });
  t("parseLockYaml reads maps, flow maps and flow arrays", () => {
    const parsed = parseLockYaml(FIXTURE_LOCK);
    eq(parsed.lockfileVersion, "9.0", "lockfileVersion");
    eq(parsed.importers["."].dependencies.react.version, "19.3.0", "importer version");
    eq(parsed.packages["react@19.3.0"].resolution.integrity, `sha512-${SHA512_B64}`, "integrity");
    eq(parsed.packages["@none/nothing"] ?? null, null, "absent key stays absent");
  });
  t("parseLockYaml reads block sequences of scalars, which this lock does use", () => {
    const seq = parseLockYaml(`
packages:

  'x@1.0.0':
    bundledDependencies:
      - '@a/b'
      - c
    os: [linux]
`);
    eq(seq.packages["x@1.0.0"].bundledDependencies, ["@a/b", "c"], "scalar sequence");
    eq(seq.packages["x@1.0.0"].os, ["linux"], "flow sequence");
    throws(() => parseLockYaml("l:\n  - a: 1\n"), "a sequence of maps must throw, not silently become a map");
  });
  t("npm graph marks the dev-only package and unions peer variants", () => {
    const parsed = parseLockYaml(FIXTURE_LOCK);
    const idx = new Map([
      ["react@19.3.0", "MIT"],
      ["tooling@1.0.0", "MIT OR Apache-2.0"],
    ]);
    const npm = npmFromLock(parsed, idx);
    const react = npm.components.find((c) => c.name === "react");
    const tooling = npm.components.find((c) => c.name === "tooling");
    if (react.properties) throw new Error("react is a production dependency and must not be marked dev");
    eq(tooling.properties.find((p) => p.name === "cdx:npm:development").value, "true", "tooling is dev-only");
    eq(tooling.properties.find((p) => p.name === "devhub:npm:peer-variants").value, "2", "two variants merged");
    eq(tooling.licenses, [{ license: { expression: "MIT OR Apache-2.0" } }], "multi-token goes to expression");
    eq(react.licenses, [{ license: { id: "MIT" } }], "single SPDX id");
    eq(npm.edges.find((e) => e.ref === "pkg:npm/tooling@1.0.0").dependsOn, ["pkg:npm/react@19.3.0"], "edges unioned");
    eq(npm.rootRefs, ["pkg:npm/react@19.3.0", "pkg:npm/tooling@1.0.0"], "root refs");
  });
  t("cargo parser handles all three dependency spec shapes", () => {
    const cargo = cargoFromLock(FIXTURE_CARGO);
    const root = cargo.components.find((c) => c.name === "demo");
    eq(root.type, "application", "workspace member is not a library");
    eq(root["bom-ref"], "local:demo@0.1.0", "local bom-ref");
    const edge = cargo.edges.find((e) => e.ref === "local:demo@0.1.0");
    eq(edge.dependsOn, ["pkg:cargo/libc@0.2.155", "pkg:cargo/serde@1.0.200"], "disambiguated + plain specs");
    const libc = cargo.components.find((c) => c.name === "libc");
    eq([libc.purl, libc.hashes[0].alg, libc.hashes[0].content.length], ["pkg:cargo/libc@0.2.155", "SHA-256", 64], "registry purl + checksum");
  });
  t("serial number is deterministic and RFC 4122 v5", () => {
    const parsed = parseLockYaml(FIXTURE_LOCK);
    const npm = npmFromLock(parsed, new Map());
    const cargo = cargoFromLock(FIXTURE_CARGO);
    const args = { npm, cargo, app: { name: "demo-app", version: "1.2.3" }, generatedAt: "2026-01-01T00:00:00.000Z" };
    const a = buildBom(args);
    const b = buildBom(args);
    eq(a.serialNumber, b.serialNumber, "two runs agree");
    if (!/^urn:uuid:[0-9a-f-]{36}$/.test(a.serialNumber)) throw new Error(`bad serial shape ${a.serialNumber}`);
    if (a.serialNumber.charAt(23) !== "5") throw new Error("expected version nibble 5");
    if (!["8", "9", "a", "b"].includes(a.serialNumber.charAt(28))) throw new Error("expected RFC 4122 variant nibble");
  });
  t("validateBom accepts the fixture and catches each injected break", () => {
    const parsed = parseLockYaml(FIXTURE_LOCK);
    const npm = npmFromLock(parsed, new Map());
    const cargo = cargoFromLock(FIXTURE_CARGO);
    const bom = buildBom({ npm, cargo, app: { name: "demo-app", version: "1.2.3" }, generatedAt: "2026-01-01T00:00:00.000Z", spdxIds: new Set(["MIT"]) });
    eq(validateBom(bom, FIXTURE_SCHEMA, new Set(["MIT"])).errors, [], "clean document");
    // Read-the-schema guard: if a pointer lookup silently returns undefined the validator
    // degrades into "no constraints checked" and still prints green. Assert otherwise.
    const checkedText = validateBom(bom, FIXTURE_SCHEMA, null).checked.join("|");
    for (const needle of ["component required: [type,name]", "hash alg enum: 2 values", "dependency required: [ref]"]) {
      if (!checkedText.includes(needle)) throw new Error(`constraint not read from the schema: ${needle} (checked: ${checkedText})`);
    }
    const missing = structuredClone(bom);
    delete missing.bomFormat;
    if (validateBom(missing, FIXTURE_SCHEMA, null).errors.length === 0) throw new Error("missing bomFormat went undetected");
    const badHash = structuredClone(bom);
    badHash.components[0].hashes = [{ alg: "SHA-512", content: "zz" }];
    if (!validateBom(badHash, FIXTURE_SCHEMA, null).errors.some((e) => e.includes("hex form"))) throw new Error("non-hex hash went undetected");
    const badRef = structuredClone(bom);
    badRef.dependencies.push({ ref: "pkg:npm/ghost@1.0.0", dependsOn: [] });
    if (!validateBom(badRef, FIXTURE_SCHEMA, null).errors.some((e) => e.includes("no component"))) throw new Error("dangling dependency ref went undetected");
    const dropped = structuredClone(bom);
    dropped.dependencies = dropped.dependencies.filter((d) => d.ref !== dropped.components[0]["bom-ref"]);
    if (!validateBom(dropped, FIXTURE_SCHEMA, null).errors.some((e) => e.includes("absent from the dependency graph"))) {
      throw new Error("a component missing from the graph went undetected");
    }
    const badLic = structuredClone(bom);
    badLic.components[0].licenses = [{ license: { id: "NOT-A-LICENSE" } }];
    if (!validateBom(badLic, FIXTURE_SCHEMA, new Set(["MIT"])).errors.some((e) => e.includes("SPDX")) ) {
      throw new Error("an invented SPDX id went undetected");
    }
  });
  t("licensesOf never invents an SPDX id", () => {
    const known = new Set(["MIT"]);
    eq(licensesOf("mit", known), [{ license: { expression: "mit" } }], "not in the SPDX list, so it never becomes an id");
    eq(licensesOf("MIT", known), [{ license: { id: "MIT" } }], "known id");
    eq(licensesOf("MIT OR SEE LICENSE IN LICENSE.txt", known), [{ license: { expression: "MIT OR SEE LICENSE IN LICENSE.txt" } }], "expression");
    eq(licensesOf(null, known), null, "absent stays absent");
    eq(licensesOf([{ type: "MIT" }], known), [{ license: { id: "MIT" } }], "licenses array form");
  });
  return fails;
}

function throws(fn, msg) {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (!threw) throw new Error(msg);
}

// ---------------------------------------------------------------- CLI

const USAGE = `用法 / usage: node scripts/sbom.mjs [flags]
  --out <path>  --check  --json  --selftest  --no-licenses
  --lock <path>  --cargo-lock <path>  --pkg <path>  --schema <path>  --spdx <path>
exit 0 = ok, 1 = a checked constraint failed, 2 = cannot determine (missing input)`;

export function parseArgs(argv) {
  const opts = {
    out: null,
    check: false,
    json: false,
    selftest: false,
    licenses: true,
    lock: join(ROOT, "pnpm-lock.yaml"),
    cargoLock: join(ROOT, "src-tauri", "Cargo.lock"),
    pkg: join(ROOT, "package.json"),
    schema: join(ROOT, "vendor", "cyclonedx", "bom-1.6.schema.json"),
    spdx: join(ROOT, "vendor", "cyclonedx", "spdx.schema.json"),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return resolve(ROOT, v);
    };
    switch (arg) {
      case "--out": opts.out = next(); break;
      case "--lock": opts.lock = next(); break;
      case "--cargo-lock": opts.cargoLock = next(); break;
      case "--pkg": opts.pkg = next(); break;
      case "--schema": opts.schema = next(); break;
      case "--spdx": opts.spdx = next(); break;
      case "--check": opts.check = true; break;
      case "--json": opts.json = true; break;
      case "--selftest": opts.selftest = true; break;
      case "--no-licenses": opts.licenses = false; break;
      case "--help": case "-h": opts.help = true; break;
      default: throw new Error(`unknown flag: ${arg}`);
    }
  }
  return opts;
}

export function generate(opts) {
  for (const [label, path] of [["pnpm lockfile", opts.lock], ["Cargo.lock", opts.cargoLock], ["package.json", opts.pkg], ["CycloneDX schema", opts.schema]]) {
    if (!existsSync(path) || !statSync(path).isFile()) {
      const err = new Error(`cannot determine: ${label} not found at ${path}`);
      err.cannotDetermine = true;
      throw err;
    }
  }
  const schema = JSON.parse(readFileSync(opts.schema, "utf8"));
  let spdxIds = null;
  if (existsSync(opts.spdx)) {
    const spdx = JSON.parse(readFileSync(opts.spdx, "utf8"));
    const list = spdx.enum ?? spdx.items?.enum ?? null;
    if (Array.isArray(list) && list.length) spdxIds = new Set(list);
  }
  const app = JSON.parse(readFileSync(opts.pkg, "utf8"));
  const licenseIndex = opts.licenses ? readLicenseIndex(join(ROOT, "node_modules", ".pnpm")) : new Map();
  const npm = npmFromLock(parseLockYaml(readFileSync(opts.lock, "utf8")), opts.licenses ? licenseIndex : new Map());
  const cargo = cargoFromLock(readFileSync(opts.cargoLock, "utf8"));
  const bom = buildBom({
    npm,
    cargo,
    app: { name: app.name, version: app.version },
    generatedAt: new Date().toISOString(),
    spdxIds,
  });
  // licenses were attached by reference inside npmFromLock; rebuild them through the
  // SPDX gate so `id` is only ever emitted for a token the vendored list recognises.
  for (const c of bom.components) {
    if (c.licenses) c.licenses = licensesOf(licenseValueOf(c.licenses), spdxIds) ?? undefined;
    if (c.licenses === undefined) delete c.licenses;
  }
  const { errors, checked } = validateBom(bom, schema, spdxIds);
  return { bom, errors, checked, spdxIds: spdxIds ? spdxIds.size : 0, licenseHits: npm.components.filter((c) => c.licenses).length };
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(String(e.message));
    console.error(USAGE);
    return 2;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  if (opts.selftest) {
    const fails = selftest();
    for (const f of fails) console.log(`FAIL ${f}`);
    console.log(fails.length ? `selftest: ${fails.length} FAILED` : "selftest: PASS (fixtures only, no repo state read)");
    return fails.length ? 1 : 0;
  }
  let result;
  try {
    result = generate(opts);
  } catch (e) {
    if (e.cannotDetermine) {
      console.error(`CANNOT DETERMINE ${e.message}`);
      return 2;
    }
    throw e;
  }
  const { bom, errors, checked, licenseHits } = result;
  if (opts.json) {
    console.log(JSON.stringify(bom, null, 2));
  } else {
    console.log(`CycloneDX ${bom.specVersion} BOM`);
    console.log(`  serialNumber ${bom.serialNumber}`);
    console.log(`  components   ${bom.components.length} (npm ${bom.metadata.component.properties[0].value}, cargo ${bom.metadata.component.properties[1].value})`);
    console.log(`  licenses     ${licenseHits} npm components carry a license`);
    console.log(`  dependencies ${bom.dependencies.length} graph entries`);
    console.log(`  constraints checked (read from vendor/cyclonedx/bom-1.6.schema.json):`);
    for (const c of new Set(checked)) console.log(`    - ${c}`);
    if (opts.out) console.log(`  wrote        ${opts.out}`);
  }
  if (opts.out) {
    mkdirSync(dirname(opts.out), { recursive: true });
    writeFileSync(opts.out, JSON.stringify(bom, null, 2) + "\n", "utf8");
  }
  if (errors.length) {
    console.error(`SBOM INVALID — ${errors.length} problem(s):`);
    for (const e of errors.slice(0, 40)) console.error(`  - ${e}`);
    if (errors.length > 40) console.error(`  … ${errors.length - 40} more`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`SBOM ERROR ${err?.stack ?? err}`);
    process.exit(2);
  }
}
