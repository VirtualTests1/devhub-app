/**
 * The real check behind r20-N3: does `docker compose` accept the override this app
 * generates, and does it resolve to the names the app intended?
 *
 * This is not a unit test of string building — `tests/compose.test.ts` does that. It
 * asks the actual Compose implementation to merge a repository's own file with the
 * generated override, which is the only way to learn whether the YAML is valid, whether
 * `name:` re-qualifies a volume the way the panel claims, and whether the project
 * network survives the merge.
 *
 * `config` is client-side: it needs no daemon. Measured here on `docker 28.4.0` with
 * `Docker Compose version v2.39.2-desktop.1`, while the Docker daemon was **not**
 * running (`docker info` failed with the named pipe missing) — so this test exercises
 * exactly the path that does not depend on a daemon, and skipping when `docker` is
 * absent is honest rather than a false green.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";

import {
  composeNetworkName,
  composeProjectName,
  composeVolumeName,
  isolatedOverride,
} from "../src/lib/compose.ts";

const DOCKER = (() => {
  const probe = spawnSync("docker", ["compose", "version"], { encoding: "utf8" });
  return probe.status === 0 ? probe.stdout.trim() : null;
})();

const BASE_FILE = `services:
  web:
    image: nginx:alpine
    ports:
      - "8080:80"
    depends_on:
      - db
  db:
    image: postgres:16-alpine
    volumes:
      - db-data:/var/lib/postgresql/data
volumes:
  db-data:
`;

test("docker compose accepts the generated override and resolves the intended names", (t: TestContext) => {
  if (!DOCKER) {
    t.skip("docker CLI not on PATH — the client-side `compose config` check cannot run");
    return;
  }
  const slug = "owner/compose-check";
  const dir = mkdtempSync(join(tmpdir(), "devhub-compose-"));
  try {
    writeFileSync(join(dir, "docker-compose.yml"), BASE_FILE);
    writeFileSync(join(dir, "devhub-isolation.yml"), isolatedOverride(slug, ["web", "db"], ["db-data"]));
    const run = spawnSync(
      "docker",
      [
        "compose",
        "-p",
        composeProjectName(slug),
        "-f",
        join(dir, "docker-compose.yml"),
        "-f",
        join(dir, "devhub-isolation.yml"),
        "config",
        "--format",
        "json",
      ],
      { encoding: "utf8", timeout: 120_000 },
    );
    assert.equal(run.status, 0, `docker compose config failed: ${run.stderr.slice(0, 400)}`);
    const resolved = JSON.parse(run.stdout) as {
      name: string;
      networks: Record<string, { name?: string }>;
      services: Record<string, { networks?: unknown }>;
      volumes: Record<string, { name?: string }>;
    };
    // 1. the project name is the folded slug, not the temp directory's name
    assert.equal(resolved.name, composeProjectName(slug));
    // 2. the private network exists and every service is attached to it
    const network = composeNetworkName(slug);
    assert.ok(resolved.networks[network], `expected network ${network} in the merged config`);
    for (const svc of ["web", "db"]) {
      assert.ok(
        resolved.services[svc]?.networks && Object.keys(resolved.services[svc].networks as object).includes(network),
        `${svc} is not attached to ${network}`,
      );
    }
    // 3. the volume is project-qualified, which is the claim the panel makes
    assert.equal(resolved.volumes["db-data"]?.name, composeVolumeName(slug, "db-data"));
    // 4. the base file was not rewritten by anything here (the app does not touch it)
    assert.equal(readFileSync(join(dir, "docker-compose.yml"), "utf8"), BASE_FILE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
