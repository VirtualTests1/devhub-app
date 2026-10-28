/**
 * `src/lib/report-error.ts` — the one place a rejection becomes a sentence.
 *
 * These are the corners the hand-written `String(e)` calls got wrong, so they are
 * worth pinning: a Tauri command rejects with a bare `String` (fine for
 * `String()`), but a `SyntaxError` from the code above the `catch` came out with
 * its class name glued on, and a plain object came out as `[object Object]`. The
 * user then reads a toast that names an implementation detail instead of saying
 * what failed, and the report we get back is "提示看不懂".
 *
 * `reportError` is asserted through the real toast store rather than a mock,
 * because the whole point is that there is exactly one path to the screen.
 * `swallow` is asserted through the console, because its promise is that the
 * other path — the visible one — stays empty.
 */
import { mock, test } from "node:test";
import assert from "node:assert/strict";

import { messageOf, reportError, swallow } from "../src/lib/report-error.ts";
import { useToast } from "../src/store/toast.ts";

import { at } from "./helpers/definite.ts";

// The store arms its auto-dismiss ticker with `window.setInterval` on the first
// push. Node has no `window`, and a test that only wants to read the queue must
// not start a timer, so only the two calls the store makes are stubbed.
(globalThis as { window?: unknown }).window = {
  setInterval: () => 1,
  clearInterval: () => undefined,
};

/** Reads the queue and empties it, so each test sees only its own toast. */
function drainToasts() {
  const items = useToast.getState().items;
  useToast.setState({ items: [] });
  return items;
}

test("messageOf: a string rejection is the backend's own words, untouched", () => {
  // This is the overwhelmingly common case: every command is `Result<T, String>`.
  assert.equal(messageOf("目录不存在"), "目录不存在");
  assert.equal(messageOf("  已裁剪的空白  "), "已裁剪的空白", "surrounding whitespace is trimmed");
});

test("messageOf: an Error gives its message, not its class name", () => {
  // `String(new SyntaxError("x"))` is "SyntaxError: x" — the old shape of the bug.
  assert.equal(messageOf(new Error("解析失败")), "解析失败");
  assert.equal(messageOf(new SyntaxError("Unexpected end of JSON input")), "Unexpected end of JSON input");
  assert.equal(messageOf(new TypeError()), "TypeError", "an Error with no message falls back to its name");
});

test("messageOf: {code, message} is readable and keeps the code", () => {
  // Forward-compatible branch only: no command returns this shape today.
  assert.equal(messageOf({ code: "outside_root", message: "路径不在项目根目录内" }), "路径不在项目根目录内（outside_root）");
  assert.equal(messageOf({ message: "只有说明" }), "只有说明");
  assert.equal(messageOf({ code: "E13" }), "错误代码 E13", "a code with no prose is still a handle to quote");
  assert.equal(messageOf({ code: 42, message: "端口占用" }), "端口占用（42）");
});

test("messageOf: an empty object says so instead of printing nothing useful", () => {
  assert.equal(messageOf({}), "后端未返回原因");
  assert.equal(messageOf({ reason: "字段名不在约定里" }), "后端未返回原因");
});

test("messageOf: null and undefined are rejections too", () => {
  assert.equal(messageOf(null), "后端未返回原因");
  assert.equal(messageOf(undefined), "后端未返回原因");
  assert.equal(messageOf(""), "后端未返回原因", "an empty string is not a reason");
});

test("messageOf: a non-string message field never becomes [object Object]", () => {
  assert.equal(messageOf({ message: { text: "嵌套的对象" } }), "后端未返回原因");
  assert.equal(
    messageOf({ message: { text: "嵌套" }, code: "bad_payload" }),
    "错误代码 bad_payload",
    "the code is still worth showing",
  );
  assert.equal(messageOf({ message: 7 }), "7", "a primitive message is a reason on its own");
});

test("messageOf: primitives that are not strings still say something", () => {
  assert.equal(messageOf(404), "404");
  assert.equal(messageOf(false), "false");
  assert.equal(messageOf(Symbol("x")), "后端未返回原因", "a symbol has nothing honest to show");
});

test("messageOf: nothing readable comes out as the JS object dump", () => {
  for (const value of [{ a: 1 }, null, undefined, {}, Symbol("s"), new Map()]) {
    const text = messageOf(value);
    assert.notEqual(text, "[object Object]");
    assert.notEqual(text, "undefined");
    assert.notEqual(text, "null");
    assert.ok(text.length > 0);
  }
});

test("reportError: 动词 + 后端原话, on the error channel, one toast only", () => {
  reportError("端口段已被占用", "保存失败");
  const toast = at(drainToasts(), 0);
  assert.equal(toast.text, "保存失败：端口段已被占用");
  assert.equal(toast.kind, "error", "the toast must be the error kind, or it dismisses too fast to read");
  assert.equal(useToast.getState().items.length, 0, "the drain emptied the queue");
});

test("reportError: an unrecognised rejection still produces a sentence", () => {
  reportError({ status: 500 }, "刷新");
  const toast = at(drainToasts(), 0);
  assert.equal(toast.text, "刷新：后端未返回原因");
});

test("swallow: nothing reaches the toast queue", () => {
  // The whole contract of the silent path: a deliberate drop must not leave a
  // red border on screen, or the "已保存" that went before it reads as a lie.
  swallow("目录已经不存在", "回退后的补记，不影响结果");
  assert.deepEqual(drainToasts(), []);
});

test("swallow: the reason is logged next to the message it hides", () => {
  const seen: unknown[][] = [];
  mock.method(console, "debug", (...args: unknown[]) => {
    seen.push(args);
  });
  try {
    swallow(new Error("剪贴板不可用"), "复制是锦上添花，失败不该打断保存");
  } finally {
    mock.restoreAll();
  }
  assert.equal(seen.length, 1, "one line, and not via console.error");
  const line = String(at(at(seen, 0), 0));
  assert.match(line, /复制是锦上添花/);
  assert.match(line, /剪贴板不可用/);
});
