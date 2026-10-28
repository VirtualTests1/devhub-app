/**
 * `src/lib/utils.ts` — `cn`, the className helper every component routes through.
 *
 * It used to be two libraries bolted together (`clsx` + `tailwind-merge`); since
 * r21-o1 both halves live inside `utils.ts` itself, and the interesting part is
 * unchanged: one half decides *whether* a class is present, the other decides which
 * of two conflicting utilities survives. A regression here silently restyles the
 * whole app, because a lost `p-4` is invisible in a type check. The equivalence with
 * the old libraries is measured in the commit record of feat(o1-3) — this file is
 * the permanent, dependency-free half of that evidence.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { cn } from "../src/lib/utils.ts";

test("cn: joins truthy inputs and drops the falsy ones", () => {
  assert.equal(cn("a", "b"), "a b");
  assert.equal(cn("a", false, undefined, null, "", "b"), "a b");
  assert.equal(cn(false, null, undefined), "", "nothing left over from an all-falsy call");
});

test("cn: conditional object form", () => {
  assert.equal(cn("base", { on: true, off: false }), "base on");
  assert.equal(cn({ a: 1, b: 0 }), "a");
});

test("cn: arrays are flattened, nested to any depth", () => {
  assert.equal(cn("x", ["y", ["z"]]), "x y z");
});

test("cn: later Tailwind conflicts replace earlier ones instead of stacking", () => {
  // This is the whole reason the merge half of `cn()` exists. Plain concatenation
  // would emit both, and the stylesheet — not the caller — would decide the
  // padding, which is how "the setting did nothing" reports get opened.
  assert.equal(cn("p-2", "p-4"), "p-4");
  assert.equal(cn("px-2 py-1", "px-4"), "py-1 px-4");
  assert.equal(cn("text-sm", "text-lg"), "text-lg");
  assert.equal(cn("bg-red-500", "bg-blue-500"), "bg-blue-500");
});

test("cn: non-conflicting utilities are kept together", () => {
  assert.equal(cn("mt-2", "rounded"), "mt-2 rounded");
  assert.equal(cn("flex", "items-center", "gap-2"), "flex items-center gap-2");
});

test("cn: a caller-side override beats the base it replaces", () => {
  // The pattern used across the app is `cn(base, props.className)`, so the
  // trailing value must win — the opposite order would make every prop
  // `className` dead code.
  assert.equal(cn("grid grid-cols-3 gap-4", "grid-cols-2"), "grid gap-4 grid-cols-2");
});

test("cn: arbitrary values are passed through untouched", () => {
  // `[data-repo-path="off"]`-style utilities and `duration-[240ms]` are both
  // written into `cn` call sites; merging must not eat the brackets.
  assert.equal(cn("w-[232px]"), "w-[232px]");
  assert.equal(cn("w-[232px]", "w-[300px]"), "w-[300px]");
});
