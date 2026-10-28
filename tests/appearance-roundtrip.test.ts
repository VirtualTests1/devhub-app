/**
 * E1/E2 — template import/export roundtrip tests.
 *
 * `exportTemplateBlob` → JSON string → `importTemplateBlob` must be
 * byte-identical for a well-formed v1 template. Malformed input
 * (extra keys, wrong types, v2 schema) is sanitised, not rejected.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  exportTemplateBlob,
  importTemplateBlob,
  templateRoundtrip,
  sanitizeTemplateValues,
  type AppearanceTemplate,
} from "../src/store/appearance.ts";

const mkTemplate = (overrides: Partial<AppearanceTemplate> = {}): AppearanceTemplate => ({
  id: "tpl-test-001",
  name: "Test Skin",
  createdAt: "2026-10-18T00:00:00.000Z",
  values: {
    theme: "dark",
    fontScale: "md",
    uiFontPx: 16,
    ...overrides,
  } as never,
});

test("E2: exportTemplateBlob produces a v1 schema blob", () => {
  const tpl = mkTemplate();
  const raw = exportTemplateBlob(tpl);
  const parsed = JSON.parse(raw);
  assert.equal(parsed.schema, 1);
  assert.equal(parsed.template.id, "tpl-test-001");
  assert.equal(parsed.template.name, "Test Skin");
});

test("E2: importTemplateBlob round-trips a well-formed template", () => {
  const tpl = mkTemplate();
  const raw = exportTemplateBlob(tpl);
  const back = importTemplateBlob(raw);
  assert.ok(back, "import must not return null for a valid blob");
  assert.equal(back!.id, tpl.id);
  assert.equal(back!.name, tpl.name);
  assert.equal(back!.createdAt, tpl.createdAt);
  assert.deepEqual(
    JSON.parse(JSON.stringify(back!.values)),
    JSON.parse(JSON.stringify(sanitizeTemplateValues(tpl.values))),
  );
});

test("E2: templateRoundtrip returns true for a valid template", () => {
  const tpl = mkTemplate();
  assert.equal(templateRoundtrip(tpl), true);
});

test("E2: importTemplateBlob rejects non-v1 schema", () => {
  const raw = JSON.stringify({ schema: 2, template: mkTemplate() });
  assert.equal(importTemplateBlob(raw), null);
});

test("E2: importTemplateBlob rejects non-JSON input", () => {
  assert.equal(importTemplateBlob("not json at all"), null);
  assert.equal(importTemplateBlob(""), null);
  assert.equal(importTemplateBlob("42"), null);
  assert.equal(importTemplateBlob('["array"]'), null);
});

test("E2: importTemplateBlob sanitises extra keys on re-import", () => {
  const tpl = mkTemplate();
  const raw = exportTemplateBlob(tpl);
  const parsed = JSON.parse(raw);
  // Inject a key that is not in TEMPLATE_KEYS.
  parsed.template.values = {
    ...parsed.template.values,
    someFutureKey: "v2-only",
  };
  const back = importTemplateBlob(JSON.stringify(parsed));
  assert.ok(back);
  assert.equal((back!.values as Record<string, unknown>).someFutureKey, undefined,
    "unknown keys must be dropped by the sanitiser");
});

test("E2: importTemplateBlob tolerates missing createdAt (back-fills now)", () => {
  const tpl = mkTemplate();
  const raw = exportTemplateBlob(tpl);
  const parsed = JSON.parse(raw);
  delete parsed.template.createdAt;
  const back = importTemplateBlob(JSON.stringify(parsed));
  assert.ok(back);
  assert.ok(typeof back!.createdAt === "string" && back!.createdAt.length > 0);
});
