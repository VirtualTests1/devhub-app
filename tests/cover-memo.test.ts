import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  COVER_FAILURE_TTL_MS,
  clearCoverFailures,
  coverFailureCount,
  coverFailureFor,
  forgetCoverFailure,
  rememberCoverFailure,
} from "../src/lib/cover-memo";

beforeEach(() => clearCoverFailures());

test("a remembered failure is returned inside the TTL", () => {
  rememberCoverFailure("o/r", "获取封面图失败: 404", 1_000);
  assert.equal(coverFailureFor("o/r", 1_000 + COVER_FAILURE_TTL_MS - 1), "获取封面图失败: 404");
});

test("the TTL boundary lets the next mount retry", () => {
  rememberCoverFailure("o/r", "x", 1_000);
  assert.equal(coverFailureFor("o/r", 1_000 + COVER_FAILURE_TTL_MS), null);
  assert.equal(coverFailureCount(), 0, "an expired row is dropped on read");
});

test("an empty reason is still a remembered failure", () => {
  rememberCoverFailure("o/r", "", 5);
  assert.equal(coverFailureFor("o/r", 6), "");
});

test("a success forgets the failure", () => {
  rememberCoverFailure("o/r", "x", 1);
  forgetCoverFailure("o/r");
  assert.equal(coverFailureFor("o/r", 2), null);
});

test("slugs do not share failures", () => {
  rememberCoverFailure("a/one", "x", 1);
  assert.equal(coverFailureFor("b/two", 2), null);
});
