//! Activity-history commands, extracted from lib.rs (r24-O1-1).
//!
//! These nine commands all read or write the same JSONL log through `activity`;
//! keeping them beside the storage layer makes the ownership visible, and takes
//! the largest self-contained command cluster out of the composition root.

use crate::activity;
use crate::settings_cmd::{activity_path, write_atomic};
use crate::{netpath, path_guard, read_config, record_activity, Log, SRC_RECORDS};

/// Activity history, newest first, already pruned to the retention window.
///
/// Async: `list` reads the whole log and rewrites it when the retention window
/// pruned something or an entry needed an id backfilled. A synchronous command
/// runs that disk work on the main thread.
///
/// `force` bypasses the in-process parse cache: the 记录 page's manual 刷新 button
/// uses it so the user sees the bytes currently on disk, not the cached answer.
#[tauri::command]
pub async fn list_activity(force: Option<bool>) -> Result<Vec<activity::ActivityEntry>, String> {
    let path = activity_path();
    let days = read_config().activity_retention_days;
    let force = force.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        if force {
            activity::cache_invalidate();
        }
        activity::list(&path, days)
    })
    .await
    .map_err(|e| format!("读取记录失败: {e}"))?
}

#[tauri::command]
pub async fn clear_activity() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        let path = activity_path();
        let res = activity::clear(&path);
        if res.is_ok() {
            record_activity(
                Log::new("settings", "清空全部操作记录", SRC_RECORDS)
                    .path(&path)
                    .undo(activity::Undo::none("历史已整体删除，没有可恢复的内容")),
            );
        }
        res
    })
    .await
    .map_err(|e| format!("任务异常: {e}"))?
}

/// Removes exactly one entry by id.
///
/// Deliberately not recorded: the reason a row gets deleted is that it should
/// not be in the history, and writing a fresh row about the deletion would undo
/// that. The 清空 action *is* recorded because it is a bulk, harder-to-notice
/// operation.
#[tauri::command]
pub async fn delete_activity(id: String) -> Result<(), String> {
    let path = activity_path();
    tauri::async_runtime::spawn_blocking(move || activity::delete(&path, &id))
        .await
        .map_err(|e| format!("删除记录任务异常: {e}"))?
}

/// Deletes a batch of records in one rewrite.
///
/// The single-row endpoint re-read and re-wrote the file per click, so "select
/// twenty and delete" was twenty rewrites. Returns `(removed, requested)` so the
/// UI can say "已删除 18 条（2 条已不存在）" instead of reporting a clean success
/// for rows that had already aged out.
#[tauri::command]
pub async fn delete_activity_many(ids: Vec<String>) -> Result<(usize, usize), String> {
    let path = activity_path();
    let requested = ids.len();
    let removed = tauri::async_runtime::spawn_blocking(move || activity::delete_many(&path, &ids))
        .await
        .map_err(|e| format!("删除记录任务异常: {e}"))??;
    record_activity(
        Log::new("clear", "批量删除操作记录", SRC_RECORDS)
            .detail(&format!("删除 {removed} 条"))
            .target("activity.batch")
            .path(&activity_path())
            .undo(activity::Undo::none("被删除的记录无法恢复")),
    );
    Ok((removed, requested))
}

/// What reverting one record would do, or why it cannot be done.
///
/// The plan is computed here rather than guessed by the UI from the tag, so a
/// record written by an older build (no `undo` field) and a record that is
/// genuinely irreversible produce the same honest answer with a reason attached.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoPlan {
    id: String,
    action: String,
    undo: Option<activity::Undo>,
    reason: String,
}

#[tauri::command]
pub async fn undo_plan(id: String) -> Result<UndoPlan, String> {
    let path = activity_path();
    let entries = tauri::async_runtime::spawn_blocking(move || activity::list(&path, 0))
        .await
        .map_err(|e| format!("读取记录失败: {e}"))?
        .map_err(|e| format!("读取记录失败: {e}"))?;
    match entries.into_iter().find(|e| e.id == id) {
        Some(e) => {
            let reason = match &e.undo {
                Some(u) if u.kind == "none" => u.reason.clone(),
                Some(_) => String::new(),
                None => "这条记录是在支持回退之前写入的，没有留下可回滚的前值".to_string(),
            };
            Ok(UndoPlan {
                id: e.id,
                action: e.action,
                undo: e.undo,
                reason,
            })
        }
        None => Err("找不到这条记录".to_string()),
    }
}

/// Stamps one entry as undone after its 回退 was applied.
///
/// The frontend calls this only once `applyUndo` has actually succeeded, so a
/// failed revert never marks its record and the user can retry or see the
/// honest failure record instead. A missing id is not an error here: the entry
/// may have aged out between the plan and the apply.
#[tauri::command]
pub async fn mark_activity_undone(id: String) -> Result<bool, String> {
    let path = activity_path();
    tauri::async_runtime::spawn_blocking(move || activity::mark_undone(&path, &id))
        .await
        .map_err(|e| format!("记录任务异常: {e}"))?
}

/// Lets the frontend record an operation the backend never saw.
///
/// 外观 and 界面 changes live entirely in the webview (localStorage), so nothing
/// passed through Rust to be logged — which is why the report said 记录 only
/// covers downloads and settings. This endpoint exists so those rows are
/// recorded with the same before/after/undo shape as everything else.
///
/// It writes only to the activity log: it cannot change settings, which is the
/// whole reason a webview-originated record is safe to accept.
#[tauri::command]
pub fn log_activity(
    tag: String,
    action: String,
    detail: String,
    target: String,
    before: String,
    after: String,
    slug: String,
    source: String,
    undo_value: String,
    undo_key: String,
) -> Result<(), String> {
    let mut entry = activity::ActivityEntry::now(
        if tag.is_empty() { "settings" } else { &tag },
        &action,
        &detail,
        &slug,
        if source.is_empty() { "界面" } else { &source },
        "",
    );
    if !target.is_empty() {
        entry = entry.with_target(&target);
    }
    if !before.is_empty() || !after.is_empty() {
        entry = entry.with_change(&before, &after);
    }
    if !undo_key.is_empty() {
        entry = entry.with_undo(activity::Undo::value("ui", &undo_key, &undo_value));
    }
    activity::append(&activity_path(), &entry)
}

/// Exports the history to a file the user picked.
///
/// The path comes from the save dialog on the frontend; writing happens here
/// because the webview has no filesystem access (the `opener`/`dialog` plugins
/// are the only frontend plugins wired up, and neither writes bytes).
/// Returns how many entries were written.
///
/// The dialog's answer is still a string the page can forge, so the target is
/// contained by `path_guard` like the other two filesystem endpoints.
///
/// The export itself is recorded with the written file as its 路径 - it is the
/// one operation here that produces an artefact outside the app.
#[tauri::command]
pub async fn export_activity(app: tauri::AppHandle, path: String, kind: String) -> Result<usize, String> {
    let log = activity_path();
    let days = read_config().activity_retention_days;
    let entries = tauri::async_runtime::spawn_blocking(move || activity::list(&log, days))
        .await
        .map_err(|e| format!("读取记录失败: {e}"))??;
    let text = match kind.as_str() {
        k if k.eq_ignore_ascii_case("markdown") => activity::to_markdown(&entries),
        k if k.eq_ignore_ascii_case("markdown-grouped") => activity::to_markdown_grouped(&entries),
        k if k.eq_ignore_ascii_case("csv") => activity::to_csv(&entries),
        _ => activity::to_jsonl(&entries),
    };
    // The count the user is told must be the count that is in the file: `to_jsonl`
    // skips a row it cannot serialize, so `entries.len()` could exceed what was
    // actually written. Computed here, before `text` moves to the writer thread.
    let is_jsonl = !kind.eq_ignore_ascii_case("markdown")
        && !kind.eq_ignore_ascii_case("markdown-grouped")
        && !kind.eq_ignore_ascii_case("csv");
    let written_count = if is_jsonl {
        text.lines().filter(|l| !l.trim().is_empty()).count()
    } else {
        entries.len()
    };
    // Containment in the same blocking task as the write: `guard` canonicalizes
    // the roots (real fs work) that must not run on an async runtime thread.
    let shown = tauri::async_runtime::spawn_blocking({
        let app2 = app.clone();
        // The error type is spelled out: with two `?` in the body rustc cannot
        // infer it from `Ok(shown)` alone, and `cargo test --lib` failed here with
        // E0282/E0283 once the containment check moved into this same task.
        move || -> Result<String, String> {
            let target = path_guard::guard(&app2, &path, path_guard::Access::Write)?;
            let shown = netpath::strip_verbatim(&target).display().to_string();
            write_atomic(&target, text.as_bytes()).map_err(|e| format!("写入导出文件失败: {e}"))?;
            Ok(shown)
        }
    })
    .await
    .map_err(|e| format!("导出任务异常: {e}"))?;
    let shown = shown?;
    record_activity(
        Log::new("settings", "导出操作记录", SRC_RECORDS)
            .detail(&format!(
                "{} 条，{}{}",
                written_count,
                match kind.as_str() {
                    k if k.eq_ignore_ascii_case("markdown") => "Markdown",
                    k if k.eq_ignore_ascii_case("markdown-grouped") => "Markdown（按对象归并）",
                    k if k.eq_ignore_ascii_case("csv") => "CSV",
                    _ => "JSONL",
                },
                if written_count != entries.len() {
                    format!(
                        "（读取 {} 条，{} 条无法序列化）",
                        entries.len(),
                        entries.len() - written_count
                    )
                } else {
                    String::new()
                }
            ))
            .path_str(&shown),
    );
    Ok(written_count)
}

#[cfg(test)]
mod tests {
    use super::UndoPlan;

    /// The frontend's `UndoPlan` type reads `{id, action, undo, reason}`; `undo`
    /// is the same camelCase `Undo` shape the log stores. A rename here would
    /// leave the 回退 dialog rendering empty fields with no type error, because
    /// the payload crosses IPC as JSON.
    #[test]
    fn undo_plan_serializes_with_camel_case_undo_payload() {
        let plan = UndoPlan {
            id: "e1".into(),
            action: "修改设置".into(),
            undo: Some(crate::activity::Undo::none("不可回退")),
            reason: "不可回退".into(),
        };
        let value = serde_json::to_value(&plan).expect("UndoPlan is serializable");
        assert_eq!(value["id"], "e1");
        assert_eq!(value["action"], "修改设置");
        assert_eq!(value["undo"]["kind"], "none");
        assert_eq!(value["undo"]["reason"], "不可回退");
        assert_eq!(value["reason"], "不可回退");
    }
}
