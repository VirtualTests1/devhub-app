import { toast } from "../store/toast";
import { recordFailure, type FailureKind } from "../store/failures";

/**
 * One place that decides what a failure sounds like.
 *
 * Why: every view had written its own `catch (e) { toast.error(\`${verb}：${String(e)}\`) }`,
 * and `String()` is the part that lied. A Tauri command rejects with the plain
 * `String` the Rust side produced — verified against the command signatures, all
 * of which are `Result<T, String>` — so `String(e)` was right *there*, but a
 * `SyntaxError` thrown by the parse a few lines above came out as
 * "SyntaxError: Unexpected token …", and anything else came out as
 * "[object Object]" or "undefined". Those are not sentences a user can act on.
 *
 * The copy shape, so the same failure reads the same way everywhere:
 * `动词失败：后端原话`. Fullwidth colon, no space either side — the app's other
 * Chinese strings use it, and an ASCII colon in `失败: x` makes two half-width
 * characters sit inside a Chinese sentence.
 *
 * The verb is `动词失败`, never `无法动词` and never a bare reason: 记录页 and 设置页
 * put rejections in an inline banner with no heading of its own, so a message
 * without the verb there names nothing. The one exception, deliberate: a banner
 * that already prints its own label — the download panel's 下载失败 block — takes
 * the bare `messageOf` text, because repeating the verb under a heading that says
 * it would print it twice.
 *
 * The `{code, message}` branch below is FORWARD-COMPATIBLE ONLY. Nothing in the
 * backend sends that shape today (the Rust side has one error type, `String`);
 * when a command starts returning a structured error, this is the single place
 * that learns about it, and the call sites do not change.
 */

/** Shown when a rejection carries nothing a user could read. */
const NO_REASON = "后端未返回原因";

/** `Error` plus the shape a structured backend error would arrive as. */
type LooseError = { message?: unknown; code?: unknown };

/**
 * A value worth showing, or nothing.
 *
 * Strings are the only honest prose; numbers and booleans are at least a handle
 * (`{ message: 7 }` is not a sentence, but "7" is not "[object Object]" either).
 * Everything else — nested objects, symbols, functions — returns "" and lets the
 * caller fall through to the next candidate.
 */
function reasonOf(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return "";
}

/**
 * The readable half of any rejection: never `[object Object]`, never `undefined`.
 *
 * Order matters. A bare string is the overwhelmingly common case (every command
 * rejection), so it is checked first and returned untouched — the backend's own
 * words are the best copy we have, and re-wording them here is how "which layer
 * said that?" starts.
 */
export function messageOf(err: unknown): string {
  if (typeof err === "string") return reasonOf(err) || NO_REASON;
  if (err instanceof Error) return reasonOf(err.message) || err.name || NO_REASON;
  if (err === null || err === undefined) return NO_REASON;
  // A rejection that is just a primitive still says something ("404", "false"),
  // and printing it beats printing nothing.
  if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint") {
    return String(err);
  }
  if (typeof err === "object") {
    const { message, code } = err as LooseError;
    const text = reasonOf(message);
    // A code without prose is still a handle the user can quote back to us.
    const tag = reasonOf(code);
    if (text && tag) return `${text}（${tag}）`;
    if (text) return text;
    if (tag) return `错误代码 ${tag}`;
    return NO_REASON;
  }
  // Symbols and functions have nothing honest to show.
  return NO_REASON;
}

/**
 * Tells the user a command failed, in the one agreed shape — and writes it into
 * the failure history (r18 N1).
 *
 * The recording lives here, not at the 17 call sites, because this function is
 * already the single path a failure takes to the screen: anything that toasts a
 * rejection passes through, so anything that toasts is in the history, and no
 * call site can add a failure channel the panel does not see.
 *
 * `verb` is what the user was doing, not what threw: `保存失败`, `导入布局失败`.
 * Keeping it a parameter rather than deriving it from the stack is deliberate —
 * the verb is product copy, and the backend's sentence is the evidence.
 *
 * `kind` classifies the history row, not the toast (the toast has one visual
 * kind — error). It defaults to `"command"` because the existing call sites are
 * all command rejections; `main.tsx`'s two window-level listeners pass
 * `"runtime"` and `"rejection"` instead.
 */
export function reportError(err: unknown, verb: string, kind: FailureKind = "command"): void {
  const text = messageOf(err);
  toast.error(`${verb}：${text}`);
  recordFailure(kind, verb, text);
}

/**
 * Drops a failure on purpose, with the reason written at the call site.
 *
 * The swallow itself is not the defect — a `reveal_path` that fails after the
 * action already said "已保存" would be a lie if it toasted. The defect was that
 * nothing distinguished that case from a forgotten `catch`. So `because` is a
 * required parameter with no default: a call site that cannot fill it in is a
 * call site that should be using `reportError` instead.
 *
 * Which one to reach for, in the words of the round that wrote this: if the
 * rejected command IS the thing the user asked for, tell them. If it is only
 * bookkeeping beside a thing that already reported its own outcome, swallow it.
 */
export function swallow(err: unknown, because: string): void {
  // `console.debug` and not `console.error`: this line exists so a dev reading a
  // console can see the queue is not silently empty, and so the reason survives
  // into the built app instead of only into a comment.
  console.debug(`[devhub] 故意忽略一个失败（${because}）：${messageOf(err)}`);
}
