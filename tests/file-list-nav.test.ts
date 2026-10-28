import { test } from "node:test";
import assert from "node:assert/strict";
import { moveFileIndex } from "../src/lib/file-list-nav.ts";

test("file list nav: arrows move one row and clamp at the ends", () => {
  assert.equal(moveFileIndex(0, "ArrowDown", 3), 1);
  assert.equal(moveFileIndex(2, "ArrowDown", 3), 2);
  assert.equal(moveFileIndex(1, "ArrowUp", 3), 0);
  assert.equal(moveFileIndex(0, "ArrowUp", 3), 0);
});

test("file list nav: Home and End jump to the boundaries", () => {
  assert.equal(moveFileIndex(2, "Home", 5), 0);
  assert.equal(moveFileIndex(0, "End", 5), 4);
});

test("file list nav: nothing focused starts at the first row", () => {
  assert.equal(moveFileIndex(-1, "ArrowDown", 3), 0);
  assert.equal(moveFileIndex(-1, "ArrowUp", 3), 0);
});

test("file list nav: empty lists and unrelated keys do nothing", () => {
  assert.equal(moveFileIndex(0, "ArrowDown", 0), null);
  assert.equal(moveFileIndex(0, "Enter", 3), null);
  assert.equal(moveFileIndex(0, "a", 3), null);
});
