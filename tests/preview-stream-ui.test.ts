/**
 * Tauri v2 Channel 流式预览（r25-R2）的接线钉子。
 *
 * `.tsx` 不能在 `--experimental-strip-types` 下挂载（DEVELOPMENT.md §8.1），所以
 * 这里钉源码形状与 Rust 端的命令契约；行为由 `file_stream.rs` 的 7 条单测覆盖。
 *
 * 三件事必须在门禁里：
 *
 *   1. 前端确实用 `Channel` + `read_text_file_stream`，而不是又退回一次性字符串；
 *   2. 失败回退只在**一个 chunk 都没收到**时发生，收到一半再回退会让正文闪回；
 *   3. 后端命令确实走 `path_guard`（否则预览能读配置文件），并且按行发送。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const DIALOG = readFileSync("src/dialogs/RepoFilesDialog.tsx", "utf8");
const RUST = readFileSync("src-tauri/src/file_stream.rs", "utf8");
const LIB = readFileSync("src-tauri/src/lib.rs", "utf8");

test("前端: Channel 消息驱动预览，按文件代次丢弃迟到 chunk", () => {
  assert.match(DIALOG, /import \{ Channel, invoke \} from "@tauri-apps\/api\/core"/);
  assert.match(DIALOG, /const channel = new Channel<PreviewEvent>\(\)/);
  assert.match(DIALOG, /channel\.onmessage = \(ev\) => \{/);
  assert.match(DIALOG, /if \(gen !== previewSeq\.current \|\| ev\.kind !== "chunk"\) return/);
  assert.match(DIALOG, /received \+= ev\.text/);
  assert.match(DIALOG, /setPreview\(\{ state: "ok", text: received \}\)/);
  assert.match(DIALOG, /const gen = \+\+previewSeq\.current/);
  assert.match(DIALOG, /useEffect\(\(\) => \(\) => \{ previewSeq\.current \+= 1; \}, \[\]\)/);
});

test("前端: 调用新命令；只有零 chunk 时才回退一次性读取", () => {
  assert.match(
    DIALOG,
    /invoke<void>\("read_text_file_stream", \{ path: full, onEvent: channel \}\)/,
  );
  assert.match(DIALOG, /if \(received\) \{[\s\S]*?setPreview\(\{ state: "error", text: messageOf\(e\) \}\)/);
  assert.match(
    DIALOG,
    /void invoke<string>\("read_text_file", \{ path: full \}\)/,
    "no chunk arrived → one-shot fallback",
  );
});

test("后端: 命令在 generate_handler 注册，读文件走 path_guard", () => {
  assert.match(LIB, /file_stream::read_text_file_stream,/);
  assert.match(LIB, /mod file_stream;/);
  assert.match(RUST, /pub async fn read_text_file_stream\(/);
  assert.match(RUST, /on_event: Channel<PreviewEvent>/);
  assert.match(RUST, /crate::path_guard::guard\(&app, &path, crate::path_guard::Access::Read\)/);
});

test("后端: 按行读取并按 64 KiB 批量发送，拒绝非 UTF-8 与超限文件", () => {
  assert.match(RUST, /const CHUNK_BYTES: usize = 64 \* 1024;/);
  assert.match(RUST, /read_until\(b'\\n', &mut buf\)/);
  assert.match(RUST, /std::str::from_utf8\(&buf\)/);
  assert.match(RUST, /batch\.len\(\) >= CHUNK_BYTES/);
  assert.match(RUST, /const MAX_BYTES: u64 = 4_000_000;/);
  assert.match(RUST, /PreviewEvent::Started \{ bytes: meta\.len\(\) \}/);
  assert.match(RUST, /PreviewEvent::Done \{ bytes, lines \}/);
});

test("事件线形状与前端类型逐字对齐", () => {
  assert.match(RUST, /#\[serde\(tag = "kind", rename_all = "camelCase"\)\]/);
  assert.match(RUST, /Started \{ bytes: u64 \}/);
  assert.match(RUST, /Chunk \{ text: String \}/);
  assert.match(RUST, /Done \{ bytes: u64, lines: usize \}/);
  for (const kind of ["started", "chunk", "done"]) {
    assert.ok(DIALOG.includes(`kind: "${kind}"`), `前端类型缺少 ${kind}`);
  }
});
