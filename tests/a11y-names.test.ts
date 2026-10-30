import { test } from "node:test";
import assert from "node:assert/strict";

import { findUnnamedButtons } from "../scripts/check-a11y-names.mjs";

/*
 * The classifier behind `pnpm check`'s a11y-names row.
 *
 * These are synthetic sources on purpose: the checker's real input is every
 * `.tsx` in the tree, and a test that asserted today's file set would go red the
 * day a legitimate icon-only button gains a label. What must stay pinned is the
 * *decision*: icon-only is unnamed, any of the four naming routes is named, and
 * a deliberate `aria-hidden` backdrop is out of scope.
 */

test("an icon-only button is unnamed", () => {
  const found = findUnnamedButtons(`<button type="button"><X className="h-4 w-4" /></button>`);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.line, 1);
});

test("each naming route is accepted", () => {
  const sources = [
    `<button aria-label={t("close")}><X /></button>`,
    `<button aria-labelledby={id}><X /></button>`,
    `<button title="Close"><X /></button>`,
    `<button>{t("open")}</button>`,
    `<button><span>{label}</span></button>`,
    `<button>{diagAction(t, issue.jump)}</button>`,
  ];
  for (const source of sources) {
    assert.deepEqual(findUnnamedButtons(source), [], source);
  }
});

test("a self-closing button with no label is unnamed", () => {
  assert.equal(findUnnamedButtons(`<button type="button" />`).length, 1);
});

test("aria-hidden backdrops are out of scope", () => {
  assert.deepEqual(
    findUnnamedButtons(`<button type="button" aria-hidden tabIndex={-1} onClick={close} />`),
    [],
  );
});

test("the reported line is the button's own line", () => {
  const source = `const x = 1;\n\n<button type="button"><Icon /></button>`;
  assert.equal(findUnnamedButtons(source, "a.tsx")[0]?.line, 3);
});
