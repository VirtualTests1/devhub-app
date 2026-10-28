// DevHub ESLint configuration — FLAT config (ESLint 9+).
//
// ─────────────────────────────────────────────────────────────────────────
// STATUS: INSTALLED AND ENFORCED (was "NOT YET EXECUTED" until round 15).
//
// `eslint`, `@typescript-eslint/parser`, `@typescript-eslint/eslint-plugin`
// and `eslint-plugin-react-hooks` are now devDependencies (installed in the
// ROOT checkout at commit ef29ca4), and `pnpm lint` runs this file for real.
// The rule set below is no longer "unverified-until-install": it was written
// without a runner, has since been executed against the tree, and where it
// disagreed with reality the config was corrected (not the tree). Every count
// cited here is a measured `pnpm lint` result, not a documented guess.
//
// What runs where:
//
//     pnpm lint                     raw `eslint .` — shows every problem,
//                                   including the grandfathered pre-existing
//                                   debt, so it exits non-zero while debt exists.
//     node scripts/check-lint.mjs   the RATCHET that the gate actually calls
//                                   (via `pnpm check`): a NEW violation in a
//                                   file, or any violation in a file that used to
//                                   be clean, fails; paying debt down is free.
//
// If a dependency is ever removed from the root install, `pnpm exec eslint`
// fails with MODULE_NOT_FOUND — that is the signal this file is back to
// unverified-until-install.
//
// The reason `pnpm check` calls the ratchet rather than `eslint .` directly is
// the same reason check-invariants.mjs carries per-file baselines: a bare gate
// that fails on pre-existing debt gets muted by whoever is blocked by it, while a
// per-file ceiling lets the debt be paid file-by-file and never lets a new
// violation in. `react-hooks/exhaustive-deps` and
// `@typescript-eslint/no-non-null-assertion` are promoted to "error" on exactly
// that basis — the ratchet in check-lint.mjs is what carries them so the
// promotion is a real ceiling rather than a red wall.
//
// Regenerate the grandfathered set after paying any of it down:
//
//     node scripts/check-lint.mjs --baseline
//
// DO NOT run `pnpm add`/`pnpm install` from a linked worktree. This repository's
// worktrees each carry a `node_modules` junction pointing at the single root
// `node_modules`, and pnpm writes its `.bin` shims with relative entry points
// — whoever installs last decides the depth, and the other checkouts then die
// with MODULE_NOT_FOUND at a path *above* the project. Install once, in the
// root checkout. (See DEVELOPMENT.md, 验证矩阵.)
//
// Deliberately restricted to those four packages: the config imports no
// `@eslint/js` and no `typescript-eslint` meta-package, because pnpm does not
// hoist transitive dependencies, so a config that imported them would fail to
// load after exactly that install. The `eslint:recommended` baseline is
// reproduced as a short hand-picked list instead of an import.
// ─────────────────────────────────────────────────────────────────────────

import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import reactHooks from "eslint-plugin-react-hooks";

/**
 * A short list of browser globals, kept for any rule that consults `globals`
 * (and so `no-undef` could be re-enabled later if this file ever went back to
 * plain JS). It is NOT relied on for `no-undef` in the TS block: this app uses
 * many more DOM globals than fit here — measured this round, `src/` references
 * `HTMLElement` (28×), `CSS` (26×), `Node` (14×), `KeyboardEvent` (13×),
 * `HTMLDivElement` (11×), `PointerEvent` (10×), `MouseEvent`/`HTMLInputElement`/
 * `EventTarget` (4× each), `Selection`/`Image`/`Element`/`innerHeight` (3× each),
 * `matchMedia`/`DOMRect` (2× each), `ResizeObserver` (1×) — and a hand-maintained
 * whitelist for them is exactly the brittle thing typescript-eslint tells you not
 * to do. See the `no-undef` reason in the TS block below.
 */
const browserGlobals = {
  window: "readonly",
  document: "readonly",
  navigator: "readonly",
  location: "readonly",
  localStorage: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  requestAnimationFrame: "readonly",
  cancelAnimationFrame: "readonly",
  MutationObserver: "readonly",
  getComputedStyle: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  fetch: "readonly",
  console: "readonly",
  structuredClone: "readonly",
};

// Globals for the Node side (scripts/**, vite.config.ts, eslint.config.js).
// The scripts block turns `no-undef` ON (there are no types there, so an
// undefined name is a real typo risk), which makes this list load-bearing: an
// incomplete whitelist reports a legitimate `setTimeout` as a bug. Every entry
// below is an identifier a `pnpm lint` run actually hit — the pre-fix count was
// 24 `no-undef` errors in `scripts/**` + `vite.config.ts`, all of them Node
// built-ins missing from the earlier five-entry list (`setTimeout`, `fetch`,
// `WebSocket`, `setImmediate`). Each timer is listed with its `clear`/`cancel`
// sibling so the next one does not arrive as a fresh "error".
const nodeGlobals = {
  console: "readonly",
  process: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly",
  TextDecoder: "readonly",
  TextEncoder: "readonly",
  Buffer: "readonly",
  // Node timers/immediates: the value-position `setTimeout`/`setImmediate` calls
  // in `vite.config.ts` and the tests. (Type-position references like
  // `React.KeyboardEvent`/`Storage` are NOT listed here on purpose — those are
  // owned by the gate's `tsc`, which owns undefined names in TS, matching the
  // `src/` block's stance.)
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  setImmediate: "readonly",
  clearImmediate: "readonly",
  queueMicrotask: "readonly",
  // Node ≥18 globals the CDP driver (`scripts/cdp.mjs`) uses against the
  // webview's devtools endpoint, plus the Web-API globals a `pnpm lint` run
  // reported as undefined under `scripts/**`.
  fetch: "readonly",
  AbortController: "readonly",
  Blob: "readonly",
  crypto: "readonly",
  performance: "readonly",
  structuredClone: "readonly",
  WebSocket: "readonly",
};

export default [
  {
    // Global ignores. THIS OBJECT MUST CONTAIN NOTHING ELSE: ESLint 9 treats
    // `ignores` as a global ignore only when it is the sole key in the object
    // (https://eslint.org/docs/latest/use/configure/ignore-syntax). It used to sit
    // here next to `linterOptions`, and that silently demoted it to a per-config
    // exclusion — so `eslint .` still traversed `.worktrees/**` and
    // `src-tauri/target/**` and reported 40 parse errors from other checkouts'
    // mid-edit files and from cargo's generated JS (measured 2026-10-16: 21 in a
    // worktree's scenarios/contextmenu.mjs plus 19 tauri-codegen-assets files).
    // Any ratchet built on that run measures the wrong tree, and an agent deleting
    // a worktree could make the gate fail with an ENOENT.
    ignores: [
      "node_modules/**",
      "dist/**",
      ".worktrees/**",
      ".wt/**",
      ".cdpfixtures/**",
      ".cardshow/**",
      ".gittest/**",
      "portable/**",
      "src-tauri/target/**",
      "public/**",
      // The rest of the gitignored local scratch roots. `.pack/` is the one that
      // bit first: it holds real cloned repositories from packaging runs, and
      // `eslint .` reached into `.pack/项目/<repo>/packages/cli/src/commands/
      // contrast-audit.browser.js` and reported it as a NEW problem file, which
      // failed the lint ratchet over a directory that is not this project's source
      // at all (measured 2026-10-16, right after the global-ignore demotion was
      // fixed). Mirroring `.gitignore` here is the rule: anything git never sees,
      // lint never sees.
      ".pack/**",
      ".shots/**",
      ".searchtest/**",
      ".launchtest/**",
      ".cleartest/**",
      ".devroot*/**",
      ".workbuddy/**",
      "logs/**",
    ],
  },
  {
    // A stale `eslint-disable` (one that no longer suppresses anything) is
    // invisible unless this is turned on. `check-invariants.mjs`'s `eslint-config`
    // row only COUNTS suppression sites; it cannot tell a load-bearing disable from
    // an orphan, and its comment used to claim the orphan signal came "for free"
    // once a config existed — it does not. This option is what actually makes the
    // signal exist, so ESLint reports a disable directive that matched no problem.
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
  },

  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: "latest",
      sourceType: "module",
      globals: browserGlobals,
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      "react-hooks": reactHooks,
    },
    rules: {
      // --- the rule this repository was already suppressing -----------------
      // Measured this round: the `as any` / `as never` casts were removed in a
      // prior round and the `escape-hatches` ratchet sits at 0 — `grep -rn "as any|
      // as never|<any>" src/` finds only commentary, no live casts (re-verified
      // round 13 d6-5). The two `no-explicit-any` suppressions this file's older
      // comment described are therefore gone, and the rule can now be promoted to
      // "error" without turning `pnpm lint` into a wall: there is nothing for it to
      // fail on today, and a NEW cast fails loudly in review instead of silently.
      //
      // `exhaustive-deps` was "warn" until round 15 and is now "error". This is
      // safe ONLY because the gate calls check-lint.mjs (the per-file ratchet), not
      // `eslint .`: measured on this tree it fires 7×, all in `src/**` files this
      // round's infra stream does not own, and every one of those 7 is grandfathered
      // by the ratchet's baseline, so the promotion turns each into a ceiling a NEW
      // missing dep must respect rather than a fresh red wall. `pnpm lint` (raw) does
      // show them as errors — that is intended, it is the developer's full-debt view.
      // If the ratchet is ever removed, this rule must go back to "warn".
      "react-hooks/exhaustive-deps": "error",
      "@typescript-eslint/no-explicit-any": "error",

      // --- correctness worth the noise, hand-picked from eslint:recommended --
      // Not the full `eslint:recommended` set: without `@eslint/js` there is no
      // baseline to spread, so every rule here is chosen on purpose. Add to this
      // list rather than reaching for a preset that is not installed.
      //
      // `no-undef` is OFF for TS/TSX on purpose. typescript-eslint's own guidance is
      // to disable it in TypeScript files: the compiler (`tsc --noEmit`, which the
      // gate runs) already owns undefined names, and ESLint's base rule does not
      // understand type positions, so it false-fires on every DOM type (`HTMLElement`,
      // `KeyboardEvent`, `Selection`, `ResizeObserver`, `matchMedia`, `DOMRect`,
      // `MouseEvent`, …) that the lib.dom typings provide but the hand-written
      // `browserGlobals` above does not list. Completing that whitelist for `no-undef`
      // is the brittle alternative; we take the recommended route and let tsc decide.
      "no-undef": "off",
      "no-dupe-keys": "error",
      "no-duplicate-case": "error",
      "no-unreachable": "error",
      "no-self-compare": "error",
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-fallthrough": "off", // tsconfig's noFallthroughCasesInSwitch already owns this
      "use-isnan": "error",
      "valid-typeof": "error",
      "no-await-in-loop": "off", // the download queue awaits per task by design
      eqeqeq: ["error", "smart"],
      "prefer-const": "error",
      "no-var": "error",
      "object-shorthand": "error",

      // --- TypeScript-owned concerns ---------------------------------------
      // `no-unused-vars` is off for the base rule because the parser cannot see
      // type-only usage; the TS version below does. The ignore patterns are load-
      // bearing: `src/store/wall.ts` deliberately destructures
      // `const { index: _index, ...rest }` to drop a field, which the base rule
      // would report as dead code.
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "after-used",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      "@typescript-eslint/no-empty-function": "off",
      // Promoted "warn" → "error" in round 15 on the same basis as
      // `exhaustive-deps` above: measured 3× on this tree, all in `src/**`, all
      // grandfathered by check-lint.mjs's per-file baseline, so the rule now sets a
      // ceiling new `!` assertions must respect while `pnpm check` stays green.
      "@typescript-eslint/no-non-null-assertion": "error",

      // --- React -----------------------------------------------------------
      // rules-of-hooks is the one genuinely hard failure in this list: a hook
      // called conditionally is a runtime crash, not a style opinion.
      "react-hooks/rules-of-hooks": "error",
    },
  },

  {
    // Scripts and the Vite config run under Node, not the browser.
    files: ["scripts/**/*.mjs", "vite.config.ts", "eslint.config.js"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: "latest",
      sourceType: "module",
      globals: nodeGlobals,
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      "no-undef": "error",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { args: "after-used", argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      "no-console": "off", // these scripts ARE the reporting layer
    },
  },

  {
    // The test suite, plain-`.mjs` half: Node built-ins + top-level await, base
    // `no-undef` is the right tool for JS. (The `.ts` half lives in the block
    // below: the base rule cannot read TS type positions, so it is swapped for
    // the type-aware variant there.)
    files: ["tests/**/*.mjs"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...nodeGlobals, globalThis: "readonly" },
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      // `no-undef` is OFF here for exactly the reason the `src` block gives: these
      // are TypeScript files the gate already type-checks with
      // `tsc -p tsconfig.tests.json --noEmit`, and ESLint's base `no-undef` does not
      // understand type positions or the DOM lib, so it false-fired on `Storage`
      // (tests/helpers/storage.ts references the DOM `Storage` interface) and on the
      // `React` namespace `tests/number-keys.test.ts` uses in JSX/type positions —
      // 5 errors that were the rule being wrong, not the tests. tsc owns undefined
      // names in TS; leaving this on would have forced editing files this round does
      // not own. The Node built-ins the tests do use (`setImmediate`, …) are covered
      // by `nodeGlobals` above.
      "no-undef": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { args: "after-used", argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      // Characterization tests deliberately pin today's questionable corners
      // (formatBytes(NaN) === "NaN GB"), so a rule that made them unreadable
      // would defeat the point.
      "no-constant-condition": "off",
    },
  },

  {
    // The test suite, `.ts`/`.tsx` half.
    //
    // The base `no-undef` cannot tell a type annotation (`fake: Storage`,
    // `as React.KeyboardEvent`) from a value reference, so it false-fires on
    // every DOM/React *type* the hand-written `nodeGlobals` does not list.
    // Off here on purpose, matching the `src/` block's documented stance: the
    // gate's `tsc -p tsconfig.tests.json` owns undefined names in TS, and
    // `nodeGlobals` above still guards the genuine value-position built-ins
    // (timers, `globalThis`, …) these tests use.
    files: ["tests/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...nodeGlobals, globalThis: "readonly" },
    },
    plugins: { "@typescript-eslint": tsPlugin },
    rules: {
      "no-undef": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { args: "after-used", argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      "no-constant-condition": "off",
    },
  },
];
