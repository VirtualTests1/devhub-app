/**
 * Minimal ambient declarations for the Node built-ins this suite imports.
 *
 * WHY THIS FILE EXISTS, AND WHAT IT IS NOT.
 *
 * `@types/node` is not installed in this repository — measured, not assumed:
 * `node_modules/@types` contains exactly `react` and `react-dom`, and
 * `pnpm exec tsc -p tsconfig.tests.json` without this file emits 34 errors of the
 * form `TS2591: Cannot find name 'node:test'`, one per import line, in all 17 test
 * files. Installing `@types/node` is an `pnpm add`, and an install inside a linked
 * worktree is banned outright (shared `node_modules` junction; see
 * `docs/DEV-SYNC.md` §1), so the alternative is this file.
 *
 * It is therefore NOT a Node type surface: it declares the names `tests/**`
 * actually uses, no more, and it exists only so that the *real* value of
 * `pnpm typecheck:tests` — checking the calls these tests make into `src/` —
 * is not buried under 34 environment-gap errors of the kind that make a check
 * ignorable. Anything it declares is a subset of Node's documented behaviour.
 *
 * DELETE THIS FILE (and the `"types": []` in `tsconfig.tests.json`) as soon as
 * `@types/node` is a devDependency. It is a separate file rather than inline
 * declarations in a test precisely so that deleting it is one obvious step.
 */

declare module "node:test" {
  /**
   * The context a test receives. Declared because `tests/compose-config.test.ts`
   * reports "no docker on this machine" as a real `skip`, not as a passing no-op —
   * the distinction is this repo's report discipline (§5 of the verify skill:
   * 已实测 / 未实测 / 信息缺失), and a silent `return` would erase it.
   */
  export interface TestContext {
    skip(message?: string): void;
    diagnostic(message: string): void;
  }
  type TestFn = () => void | Promise<void>;
  type TestFnWithContext = (t: TestContext) => void | Promise<void>;

  /** `test(name, fn)` — the shape used here (no options object, no only/skip). */
  export function test(name: string, fn: TestFn): void;
  export function test(name: string, fn: TestFnWithContext): void;

  /** Runs before every `test()` in the file. */
  export function beforeEach(fn: () => void | Promise<void>): void;

  /** `mock.method` / `mock.restoreAll`, the two calls in `report-error.test.ts`. */
  export const mock: {
    /**
     * `target` is `object`, not an index-signature record: `report-error.test.ts:118`
     * mocks `console`, whose DOM-lib type is `Console` and has no index signature, so
     * a `Record<string, unknown>` parameter made a correct call look like a defect.
     */
    method(
      target: object,
      key: string,
      impl?: (...args: never[]) => unknown,
    ): unknown;
    restoreAll(): void;
  };
}

declare module "node:assert/strict" {
  interface StrictAssert {
    /** `strictEqual` under this submodule: no coercion, and it accepts a message. */
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    /** Structural deep comparison (strict about prototypes under this submodule). */
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    /** Declared as an assertion so `assert.ok(out)` narrows `out` for the lines after it. */
    ok(value: unknown, message?: string): asserts value;
    /** The suite passes a RegExp as the second argument; a predicate is Node-legal too. */
    throws(fn: () => unknown, pattern?: RegExp | ((error: unknown) => boolean), message?: string): void;
    match(value: string, pattern: RegExp, message?: string): void;
    /** Inverse of `match`; used in worktree-warning and fatal-policy tests. */
    doesNotMatch(value: string, pattern: RegExp, message?: string): void;
    /** Unconditional failure; used as a callback body that must never run. */
    fail(message?: string): never;
    /**
     * Inverse of `throws` for promises. Used by `tests/cover-gate.test.ts`, where the
     * property under test is that a *rejected* task still gives its slot back — the
     * assertion has to await the rejection to be meaningful.
     */
    rejects(fn: () => Promise<unknown>, message?: string): Promise<void>;
  }
  const assert: StrictAssert;
  export default assert;
}

declare function setImmediate(fn: (...args: never[]) => void): number;

declare module "node:fs" {
  export function readdirSync(path: string): string[];
  export function readFileSync(path: string, encoding: "utf8"): string;
  /** Raw bytes (Node's default is a Buffer, declared as its Uint8Array supertype
   *  here) — the offline comparison hashes the gold file for FNV-1a64. */
  export function readFileSync(path: string): Uint8Array;
  export function statSync(path: string): { isDirectory(): boolean };
  /** Used by `checker-contract.test.ts` to detect a built `dist/` cheaply. */
  export function existsSync(path: string): boolean;
  /** Used by `checkers.test.ts` to build the hooks-state fixtures in the temp dir. */
  export function writeFileSync(path: string, data: string): void;
  /** Only the release-manifest link test uses this; the target/type are platform-provided. */
  export function symlinkSync(target: string, path: string, type?: "dir" | "file" | "junction"): void;
  /** `recursive: true` only — the suite never creates a tree it does not name. */
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  /** The only way to get a collision-free fixture path without a third-party dep. */
  export function mkdtempSync(prefix: string): string;
  /**
   * `recursive: true` only, and only for a directory `mkdtempSync` handed out —
   * `tests/compose-config.test.ts` cleans its fixture in a `finally`. Deleting a
   * directory this test did not create is exactly the mistake `docs/worktrees.md`
   * records twice, so the option is typed but the call site is the guard.
   */
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
}

declare module "node:os" {
  /** Used by `checkers.test.ts`: fixtures go to the OS temp dir, never into the repo. */
  export function tmpdir(): string;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
  /** Used by `checkers.test.ts` to address scripts absolutely, independent of cwd. */
  export function resolve(...parts: string[]): string;
  /** Used by source-scanning tests to anchor the repo root from `import.meta.url`. */
  export function dirname(path: string): string;
}

declare module "node:url" {
  /** Used by the lazy-locale test to hand a Windows-safe module URL to a child. */
  export function pathToFileURL(path: string): { href: string };
  /** Used with `dirname` so a test can anchor the repo root without cwd. */
  export function fileURLToPath(url: string | URL): string;
}

declare module "node:child_process" {
  /** The subset of `SpawnSyncReturns<string>` that `checkers.test.ts` reads. */
  export type SpawnSyncResult = {
    /** `null` when the child was killed by the `timeout` option. */
    status: number | null;
    stdout: string;
    stderr: string;
    error?: { message: string };
  };
  export function spawnSync(
    command: string,
    args?: string[],
    options?: {
      encoding?: "utf8";
      cwd?: string;
      timeout?: number;
      shell?: boolean;
      /** The lazy-locale child sets DEVHUB_TEST_SKIP_ENGLISH through this. */
      env?: Record<string, string | undefined>;
    },
  ): SpawnSyncResult;
}

/** The members the tests actually read: two on `process`, plus `version` (r21-R1-2
 *  asserts the bake-off's recorded node version against the runner's own). */
declare const process: {
  /** The suite is documented to run from the repo root (DEVELOPMENT.md 验证矩阵). */
  cwd(): string;
  execPath: string;
  /** e.g. `v22.19.0` — Node's own version string, as `process.version`. */
  version: string;
  /** Environment passed through to a child process; read, never mutated here. */
  env: Record<string, string | undefined>;
};
