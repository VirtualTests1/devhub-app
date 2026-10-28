import { test } from "node:test";
import assert from "node:assert/strict";
import { REPO_NOTE_LENGTH_LIMIT, sanitiseNote } from "../src/store/wall.ts";

test("note: trims, drops empty, caps at the documented limit", () => {
  assert.equal(sanitiseNote("  hello  "), "hello");
  assert.equal(sanitiseNote("   "), undefined);
  assert.equal(sanitiseNote(42), undefined);
  assert.equal(sanitiseNote("x".repeat(REPO_NOTE_LENGTH_LIMIT + 10))?.length, REPO_NOTE_LENGTH_LIMIT);
});
