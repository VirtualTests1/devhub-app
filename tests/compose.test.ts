/**
 * The Docker isolation naming rules (r20-N3-1) and their real validation against
 * `docker compose config` are split across this file and `tests/compose-config.test.ts`.
 * These cases are the pure half: what a hostile slug becomes, and that nothing two
 * repositories produce can collide.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  composeDeclarations,
  composeNetworkName,
  composeProjectName,
  composeVolumeName,
  isolatedComposeCommand,
  isolatedOverride,
} from "../src/lib/compose.ts";

test("composeProjectName folds a slug into a name compose accepts", () => {
  assert.equal(composeProjectName("Owner/My.Repo"), "owner-my-repo");
  assert.equal(composeProjectName("weird///path  case"), "weird-path-case");
  // A slug that is only punctuation must not become the empty string (compose rejects
  // it and the container never starts); one that merely *starts* with punctuation loses
  // the punctuation, which is exactly what compose's own name rule wants.
  assert.equal(composeProjectName("__leading"), "leading");
  assert.equal(composeProjectName("!!!"), "repo");
  assert.equal(composeProjectName("trailing---"), "trailing");
  assert.equal(composeProjectName("a".repeat(80)).length, 40, "long names are truncated");
});

test("two repositories never share a network or a volume name", () => {
  const a = composeNetworkName("owner/app");
  const b = composeNetworkName("owner/app-dev");
  assert.notEqual(a, b);
  assert.equal(a, "owner-app_devhub");
  // The collision that matters: two repositories that both call their volume `db-data`.
  assert.notEqual(composeVolumeName("owner/a", "db-data"), composeVolumeName("owner/b", "db-data"));
  assert.equal(composeVolumeName("owner/a", "db-data"), "owner-a_db-data");
  assert.equal(composeVolumeName("owner/a", ""), "owner-a_data", "an empty name still qualifies");
});

test("isolatedOverride names the network and re-qualifies every volume", () => {
  const text = isolatedOverride("owner/app", ["web", "db"], ["db-data", "uploads"]);
  assert.match(text, /^networks:\n {2}owner-app_devhub:\n {4}external: false/m);
  assert.match(text, /^services:\n {2}web:\n {4}networks:\n {6}- owner-app_devhub/m);
  assert.match(text, / {2}db-data:\n {4}name: owner-app_db-data/);
  assert.match(text, / {2}uploads:\n {4}name: owner-app_uploads/);
  assert.ok(!text.includes("container_name"), "the app does not rename containers");
});

test("isolatedOverride with nothing to say is still a valid network stanza", () => {
  // A repository whose compose file has no services listed yet still needs the network
  // pinned, and an empty `services:`/`volumes:` block is a YAML error, not a no-op.
  const text = isolatedOverride("owner/app", [], []);
  assert.match(text, /networks:/);
  assert.ok(!text.includes("services:"), "no services means no services key");
  assert.ok(!text.includes("volumes:"), "no volumes means no volumes key");
});

// ---------------------------------------------------------------------------
// r21-N2-2 — the run command and the scanner the 项目设置 panel reads with.

test("isolatedComposeCommand is the two-file line a person actually runs", () => {
  assert.equal(
    isolatedComposeCommand("Owner/My.Repo"),
    "docker compose -p owner-my-repo -f docker-compose.yml -f devhub-isolation.yml",
  );
  // The base file comes from `project_has_compose`'s answer, so the second -f is
  // always the override and the order is the one compose documents (-f a -f b,
  // b wins).
  assert.equal(
    isolatedComposeCommand("owner/app", "compose.yaml", "iso.yml"),
    "docker compose -p owner-app -f compose.yaml -f iso.yml",
  );
  // The -p in the command and the network in the override must come from the same
  // fold, or the command starts a project whose network the override never names.
  const slug = "Owner/My.Repo";
  const command = isolatedComposeCommand(slug);
  const override = isolatedOverride(slug, ["web"], []);
  assert.ok(command.includes(`-p ${composeProjectName(slug)}`), "-p 用的就是同一个折叠名");
  assert.ok(
    override.includes(composeNetworkName(slug)),
    "override 声明的网络与 -p 一致，否则两者合起来指向两个项目",
  );
});

/** A conventional compose file: two services with bodies, two named volumes. */
const CONVENTIONAL = [
  "services:",
  "  web:",
  "    image: nginx:alpine",
  "    ports:",
  '      - "8080:80"',
  "  db:",
  "    image: postgres:16",
  "    environment:",
  "      POSTGRES_PASSWORD: x",
  "",
  "volumes:",
  "  db-data:",
  "  uploads:",
  "",
].join("\n");

test("composeDeclarations: a conventional file reads both blocks", () => {
  assert.deepEqual(composeDeclarations(CONVENTIONAL), {
    services: ["web", "db"],
    volumes: ["db-data", "uploads"],
  });
});

test("composeDeclarations: an absent top-level key is [], not null", () => {
  // [] means "this file declares none" — a real, usable answer the panel renders
  // as 「没有声明命名卷」. It must not be confused with the unreadable case below.
  assert.deepEqual(composeDeclarations("services:\n  web:\n    image: x\n"), {
    services: ["web"],
    volumes: [],
  });
});

test("composeDeclarations: a shape it cannot read is null, never []", () => {
  // Flow style, an anchor on a key, tab indentation, an inline mapping — in each
  // case the block IS there, so answering "declares none" would make the panel
  // draw an override that silently drops a service or a volume pin.
  const unreadable = [
    "services: { web: { image: x } }\n",
    "services:\n  web: &def\n    image: x\n",
    "services:\n\tweb:\n\t\timage: x\n",
    "volumes:\n  db-data: { name: x }\n",
    "volumes:\n  db-data: some-scalar\n",
  ];
  for (const text of unreadable) {
    const got = composeDeclarations(text);
    const key = text.startsWith("volumes") ? "volumes" : "services";
    assert.equal(got[key], null, JSON.stringify(text));
  }
});

test("composeDeclarations: comments, quoted keys, CRLF and the next top-level key", () => {
  const text = [
    "# services live here",
    "services:   # the edge",
    "  'web': # the edge service",
    '  "db":',
    "",
    "x-something:",
    "  a: 1",
    "volumes:",
    "  data:",
    "",
  ].join("\r\n");
  assert.deepEqual(composeDeclarations(text), { services: ["web", "db"], volumes: ["data"] });
});
