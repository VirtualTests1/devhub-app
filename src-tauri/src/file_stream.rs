//! Streaming text-file preview over a Tauri v2 `Channel` (r25-R2).
//!
//! ## Why this exists
//!
//! `read_text_file` returns a whole file as one JSON string. At the 4 MB cap the
//! webview builds that string in one `JSON.parse`, after the backend already held
//! the whole file in memory, and the dialog shows nothing until both are done.
//! The dialog only needs the first screenful quickly, so this module sends the
//! same text in bounded **line batches** through `tauri::ipc::Channel`.
//!
//! ## Why lines and not byte chunks
//!
//! The payload is a JSON string: a fixed-size byte chunk can split a UTF-8 code
//! point and turn valid text into a replacement character or an error. Reading
//! whole lines keeps every chunk valid text and preserves the existing contract
//! ("not UTF-8 → show the error") exactly — a file that fails here would also
//! fail `read_text_file`'s `String::from_utf8`.
//!
//! ## What is not streaming
//!
//! The file is still read from disk on a blocking thread and the whole preview
//! eventually crosses the IPC boundary; only the *message size* is bounded. The
//! win measured here is therefore serialization / allocation shape, not disk
//! I/O — `docs/r25-preview-stream.md` records what was and was not measured.
//!
//! `stream_text` takes a sink closure instead of a `Channel` so the ordering,
//! batching, UTF-8 and cancellation rules are testable without a webview.

use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::path::Path;
use tauri::ipc::Channel;

/// Text carried by one IPC message. A 4 MB file becomes ~64 messages instead of
/// one 4 MB string, and the first one reaches the dialog before the read ends.
const CHUNK_BYTES: usize = 64 * 1024;

/// Same ceiling as `read_text_file`; a preview is not a binary-file browser.
const MAX_BYTES: u64 = 4_000_000;

/// One message to the webview. The `kind` tag is the frontend's discriminant.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PreviewEvent {
    /// Sent before the first chunk so the dialog can say how big the file is.
    Started { bytes: u64 },
    /// A run of whole lines. Concatenating every chunk reproduces the file.
    Chunk { text: String },
    /// The final message; `lines` counts newline-terminated runs plus a last
    /// unterminated line, matching how the dialog numbers rows.
    Done { bytes: u64, lines: usize },
}

/// What `stream_text` read, returned to the command for logging-free symmetry.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct StreamSummary {
    pub bytes: u64,
    pub lines: usize,
}

/// Reads `path` line by line and hands batches to `sink`.
///
/// `sink` returns `false` when the receiver is gone (the dialog closed or the
/// webview was torn down). That is a cancellation, not an error: the read stops
/// and no `Done` is sent. A size cap failure and invalid UTF-8 are errors, and
/// they happen before any guarantee that earlier chunks were not delivered — the
/// caller shows the error and drops the partial text, same as the one-shot
/// command would have shown nothing.
pub(crate) fn stream_text<F>(path: &Path, sink: &mut F) -> Result<StreamSummary, String>
where
    F: FnMut(PreviewEvent) -> bool,
{
    let meta = std::fs::metadata(path).map_err(|e| format!("读取失败: {e}"))?;
    if !meta.is_file() {
        return Err("预览路径不是文件".to_string());
    }
    if meta.len() > MAX_BYTES {
        return Err("文件过大".to_string());
    }

    let file = std::fs::File::open(path).map_err(|e| format!("读取失败: {e}"))?;
    let mut reader = BufReader::new(file);
    if !sink(PreviewEvent::Started { bytes: meta.len() }) {
        return Ok(StreamSummary { bytes: 0, lines: 0 });
    }

    let mut batch = String::new();
    let mut buf = Vec::new();
    let mut lines = 0usize;
    let mut bytes = 0u64;
    loop {
        buf.clear();
        let read = reader
            .read_until(b'\n', &mut buf)
            .map_err(|e| format!("读取失败: {e}"))?;
        if read == 0 {
            break;
        }
        let line = std::str::from_utf8(&buf).map_err(|_| "文件不是 UTF-8 文本".to_string())?;
        batch.push_str(line);
        bytes += read as u64;
        lines += 1;
        if batch.len() >= CHUNK_BYTES
            && !sink(PreviewEvent::Chunk {
                text: std::mem::take(&mut batch),
            })
        {
            return Ok(StreamSummary { bytes, lines });
        }
    }
    if !batch.is_empty()
        && !sink(PreviewEvent::Chunk {
            text: std::mem::take(&mut batch),
        })
    {
        return Ok(StreamSummary { bytes, lines });
    }
    // The read is over: whether the final `Done` reaches a closed receiver no
    // longer changes anything, so its bool is deliberately ignored.
    sink(PreviewEvent::Done { bytes, lines });
    Ok(StreamSummary { bytes, lines })
}

/// Reads a UTF-8 text file the user chose, streaming it over `on_event`.
///
/// Guarded exactly like `read_text_file`: unguarded, this could point at
/// `devhub-config.json`. The guard runs inside the blocking task because it
/// canonicalizes roots (real filesystem work).
#[tauri::command]
pub async fn read_text_file_stream(
    app: tauri::AppHandle,
    path: String,
    on_event: Channel<PreviewEvent>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<StreamSummary, String> {
        let target = crate::path_guard::guard(&app, &path, crate::path_guard::Access::Read)?;
        let mut sink = |event: PreviewEvent| on_event.send(event).is_ok();
        stream_text(&target, &mut sink)
    })
    .await
    .map_err(|e| format!("读取任务异常: {e}"))??;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("devhub-stream-{name}"));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn chunks(events: &[PreviewEvent]) -> String {
        events
            .iter()
            .filter_map(|e| match e {
                PreviewEvent::Chunk { text } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn streams_whole_lines_and_reproduces_the_file() {
        let root = temp_root("lines");
        let file = root.join("a.txt");
        let content = "第一行\nsecond line\n\n尾行";
        std::fs::write(&file, content).unwrap();

        let mut events = Vec::new();
        let mut sink = |ev: PreviewEvent| {
            events.push(ev);
            true
        };
        let summary = stream_text(&file, &mut sink).unwrap();

        assert_eq!(summary.bytes, content.len() as u64);
        assert_eq!(summary.lines, 4, "three newline runs plus the unterminated last line");
        assert!(matches!(
            events.first(),
            Some(PreviewEvent::Started { bytes }) if *bytes == content.len() as u64
        ));
        assert_eq!(chunks(&events), content, "chunks are the file, in order");
        assert!(matches!(
            events.last(),
            Some(PreviewEvent::Done { bytes, lines })
                if *bytes == content.len() as u64 && *lines == 4
        ));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_empty_file_sends_no_chunk() {
        let root = temp_root("empty");
        let file = root.join("empty.txt");
        std::fs::write(&file, "").unwrap();
        let mut events = Vec::new();
        let mut sink = |ev: PreviewEvent| {
            events.push(ev);
            true
        };
        let summary = stream_text(&file, &mut sink).unwrap();
        assert_eq!(summary.lines, 0);
        assert!(chunks(&events).is_empty());
        assert!(matches!(events.last(), Some(PreviewEvent::Done { lines: 0, .. })));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn refuses_non_utf8_and_files_over_the_cap() {
        let root = temp_root("refusals");
        let binary = root.join("binary.txt");
        std::fs::write(&binary, [b'o', b'k', 0xff]).unwrap();
        assert!(
            stream_text(&binary, &mut |_| true).unwrap_err().contains("UTF-8"),
            "a non-UTF-8 file is refused, same as read_text_file"
        );

        let huge = root.join("huge.txt");
        let f = std::fs::File::create(&huge).unwrap();
        f.set_len(MAX_BYTES + 1).unwrap();
        assert!(
            stream_text(&huge, &mut |_| true).unwrap_err().contains("过大"),
            "the size cap is checked before reading"
        );

        assert!(
            stream_text(&root.join("missing.txt"), &mut |_| true)
                .unwrap_err()
                .contains("读取失败")
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_large_file_uses_more_than_one_chunk_without_splitting_text() {
        let root = temp_root("large");
        let file = root.join("large.txt");
        let line = "中文行\n";
        let content = line.repeat(20_000); // ~200 KB
        std::fs::write(&file, &content).unwrap();

        let mut events = Vec::new();
        let mut sink = |ev: PreviewEvent| {
            events.push(ev);
            true
        };
        let summary = stream_text(&file, &mut sink).unwrap();
        let chunk_count = events
            .iter()
            .filter(|e| matches!(e, PreviewEvent::Chunk { .. }))
            .count();
        assert!(chunk_count >= 2, "200 KB must cross the 64 KiB batch size: {chunk_count}");
        assert_eq!(chunks(&events), content);
        assert_eq!(summary.lines, 20_000);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_closed_receiver_stops_the_read_without_a_done_event() {
        let root = temp_root("cancel");
        let file = root.join("large.txt");
        std::fs::write(&file, "行\n".repeat(20_000)).unwrap();
        let mut events = Vec::new();
        let mut sink = |ev: PreviewEvent| {
            let stop = matches!(ev, PreviewEvent::Chunk { .. });
            events.push(ev);
            !stop
        };
        let summary = stream_text(&file, &mut sink).unwrap();
        assert!(!events.iter().any(|e| matches!(e, PreviewEvent::Done { .. })));
        assert!(summary.lines < 20_000, "the read stopped at the first batch");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn preview_events_serialize_with_a_camel_case_kind_tag() {
        // The frontend switches on `kind`; this is the wire contract.
        assert_eq!(
            serde_json::to_value(PreviewEvent::Started { bytes: 12 }).unwrap(),
            serde_json::json!({ "kind": "started", "bytes": 12 })
        );
        assert_eq!(
            serde_json::to_value(PreviewEvent::Chunk { text: "a".into() }).unwrap(),
            serde_json::json!({ "kind": "chunk", "text": "a" })
        );
        assert_eq!(
            serde_json::to_value(PreviewEvent::Done { bytes: 12, lines: 3 }).unwrap(),
            serde_json::json!({ "kind": "done", "bytes": 12, "lines": 3 })
        );
    }
}
