// Builds a synthetic project container for scale measurements (r33-D8).
//
// The real wall has 13 repositories on this machine, which is not enough to see
// where `collect_repos` or the repo index starts to hurt. This writes the same
// shape the walker understands - `<root>/<owner>/<repo>/.git` plus a marker - so
// `devhub-app.exe --scan-check <runs> <root>` can be pointed at it without
// touching a real container or cloning anything from the network.
//
//   node scripts/scale-fixture.mjs --root .pack/scale-fixture --count 1000
//   node scripts/scale-fixture.mjs --root .pack/scale-fixture --clean
//
// The fixture root is normally under `.pack/` (gitignored). Nothing here is a
// test fixture used by the suite; it is a measurement input, and the research
// note records the numbers produced from it.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const opt = { root: ".pack/scale-fixture", count: 1000, clean: false };
for (let i = 0; i < argv.length; i += 1) {
  const flag = argv[i];
  if (flag === "--clean") opt.clean = true;
  else if (flag === "--root") opt.root = argv[++i];
  else if (flag === "--count") opt.count = Number(argv[++i]);
  else {
    console.error(`scale-fixture.mjs: unrecognised argument '${flag}' (accepted: --root --count --clean)`);
    process.exit(2);
  }
}
if (!Number.isInteger(opt.count) || opt.count < 1 || opt.count > 20000) {
  console.error("scale-fixture.mjs: --count must be an integer in 1..20000");
  process.exit(2);
}

const root = resolve(opt.root);
if (opt.clean) {
  rmSync(root, { recursive: true, force: true });
  console.log(`removed ${root}`);
  process.exit(0);
}

const owners = Math.max(1, Math.min(100, Math.ceil(opt.count / 25)));
for (let o = 0; o < owners; o += 1) {
  const owner = `owner${String(o).padStart(3, "0")}`;
  for (let r = 0; r < Math.ceil(opt.count / owners); r += 1) {
    const index = o * Math.ceil(opt.count / owners) + r;
    if (index >= opt.count) break;
    const repo = `project${String(index).padStart(4, "0")}`;
    const dir = join(root, owner, repo);
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(
      join(dir, ".devhub.json"),
      `${JSON.stringify(
        {
          slug: `github.com/${owner}/${repo}`,
          url: `https://github.com/${owner}/${repo}.git`,
          clonedAt: "2026-01-01T00:00:00Z",
          portBase: 20000 + (index % 100) * 10,
          services: [],
        },
        null,
        2,
      )}\n`,
    );
  }
}
console.log(`created ${opt.count} repositories under ${root} (${owners} owners)`);
