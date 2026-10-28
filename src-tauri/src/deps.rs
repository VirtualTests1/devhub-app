//! Repository dependency health check.
//!
//! Extracted from `lib.rs` in O3 (modularization). Detects the package manager
//! for a repository and lists outdated dependencies. Currently supports
//! npm / pnpm (`*outdated --json`) and pip (`pip list --outdated --format=json`).

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// One outdated dependency reported by the package manager.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dependency {
    pub name: String,
    pub current: String,
    pub wanted: String,
    pub latest: String,
}

/// The result of a dependency health check for one repository.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyReport {
    pub slug: String,
    /// `npm` | `pnpm` | `yarn` | `pip` | `uv` | `cargo` | `go` | `none`.
    ///
    /// `none` means no recognised manifest, not "no dependencies". A tool that is
    /// detected but missing from the machine (the `cargo-outdated` case on this box) keeps
    /// its manager name and puts the reason in `error` — reporting `none` there would
    /// tell the person their project has no dependencies to update.
    pub manager: String,
    pub outdated: Vec<Dependency>,
    pub error: Option<String>,
}

/// Detects the package manager for a repository and lists outdated dependencies.
///
/// npm/pnpm: `npm outdated --json` (pnpm delegates to npm's registry view; the
/// output shape is identical). pip: `pip list --outdated --format=json`.
/// Repos with no recognised manifest get `manager: "none"` and an empty list.
#[tauri::command]
pub async fn check_dependencies(slug: String) -> Result<DependencyReport, String> {
    let slug2 = slug.clone();
    tauri::async_runtime::spawn_blocking(move || check_dependencies_blocking(slug2))
        .await
        .map_err(|e| format!("依赖检查任务异常: {e}"))?
}

fn check_dependencies_blocking(slug: String) -> Result<DependencyReport, String> {
    let repo: PathBuf = crate::find_repo_any(&slug).ok_or_else(|| format!("未找到仓库: {slug}"))?;

    // npm/pnpm: a package.json with a node_modules is the signal that the user
    // has installed deps and an outdated check is meaningful.
    if repo.join("package.json").exists() {
        // r20-N2-3: yarn is its own manager now. The command shape is the same
        // (`yarn outdated --json` exists in yarn 1 — measured here at `yarn 1.22.22`),
        // but the output is an array of `{package, currentVersion, desiredVersion,
        // latestVersion}` objects rather than npm's keyed map, so it needs its own parser
        // and its own name in the report: a table that says "npm" for a yarn project
        // tells the person to run the wrong upgrade command.
        let manager = if repo.join("pnpm-lock.yaml").exists() {
            "pnpm"
        } else if repo.join("yarn.lock").exists() {
            "yarn"
        } else {
            "npm"
        };
        let mut cmd = crate::proc::silent(manager);
        cmd.args(["outdated", "--json"])
            .current_dir(&repo)
            .env("NO_COLOR", "1");
        // `npm outdated` exits 1 when there *are* outdated packages (and 0 when
        // everything is up to date), so a non-zero exit is not a failure.
        match crate::proc::output_timeout(&mut cmd, std::time::Duration::from_secs(30)) {
            Ok(Some(out)) => {
                let text = String::from_utf8_lossy(&out.stdout);
                let outdated = if manager == "yarn" {
                    parse_yarn_outdated(&text)
                } else {
                    parse_npm_outdated(&text)
                };
                Ok(DependencyReport {
                    slug,
                    manager: manager.into(),
                    outdated,
                    error: None,
                })
            }
            Ok(None) => Ok(DependencyReport {
                slug,
                manager: manager.into(),
                outdated: Vec::new(),
                error: Some("npm outdated 超时".into()),
            }),
            Err(e) => Ok(DependencyReport {
                slug,
                manager: manager.into(),
                outdated: Vec::new(),
                error: Some(format!("无法运行 {manager}: {e}")),
            }),
        }
    } else if repo.join("Cargo.toml").exists() {
        // cargo (r20-N2-1). `cargo outdated` is a subcommand that is **not part of cargo**:
        // a stock toolchain answers `no such command`, and that is the branch this machine
        // takes (measured: `cargo 1.95.0`, and the toolchain's bin directory holds
        // cargo/clippy/fmt/miri but no cargo-outdated). The report says which of the two
        // happened instead of pretending a check ran.
        let mut cmd = crate::proc::silent("cargo");
        cmd.args(["outdated", "--format", "json"])
            .current_dir(&repo)
            .env("CARGO_TERM_COLOR", "never");
        match crate::proc::output_timeout(&mut cmd, std::time::Duration::from_secs(60)) {
            Ok(Some(out)) if out.status.success() => {
                let text = String::from_utf8_lossy(&out.stdout);
                Ok(DependencyReport {
                    slug,
                    manager: "cargo".into(),
                    outdated: parse_cargo_outdated(&text),
                    error: None,
                })
            }
            Ok(Some(out)) => {
                let text = String::from_utf8_lossy(&out.stderr);
                let absent = text.contains("no such command");
                Ok(DependencyReport {
                    slug,
                    manager: "cargo".into(),
                    outdated: Vec::new(),
                    error: Some(if absent {
                        "未安装 cargo-outdated（cargo 不认识 `outdated` 子命令）".into()
                    } else {
                        text.trim().to_string()
                    }),
                })
            }
            Ok(None) => Ok(DependencyReport {
                slug,
                manager: "cargo".into(),
                outdated: Vec::new(),
                error: Some("cargo outdated 超时".into()),
            }),
            Err(e) => Ok(DependencyReport {
                slug,
                manager: "cargo".into(),
                outdated: Vec::new(),
                error: Some(format!("无法运行 cargo: {e}")),
            }),
        }
    } else if repo.join("go.mod").exists() {
        // go (r20-N2-2). `go list -m -u -json all` is the documented machine-readable
        // form (the `Module` struct in go.dev/ref/mod, quoted in docs/deps-ecosystems.md):
        // one JSON object per module with no enclosing array, and `Update` set only when a
        // newer version exists. Not executed here — this machine has no go toolchain.
        let mut cmd = crate::proc::silent("go");
        cmd.args(["list", "-m", "-u", "-json", "all"]).current_dir(&repo);
        match crate::proc::output_timeout(&mut cmd, std::time::Duration::from_secs(60)) {
            Ok(Some(out)) if out.status.success() => {
                let text = String::from_utf8_lossy(&out.stdout);
                Ok(DependencyReport {
                    slug,
                    manager: "go".into(),
                    outdated: parse_go_list_upgrades(&text),
                    error: None,
                })
            }
            Ok(Some(out)) => Ok(DependencyReport {
                slug,
                manager: "go".into(),
                outdated: Vec::new(),
                error: Some(String::from_utf8_lossy(&out.stderr).trim().to_string()),
            }),
            Ok(None) => Ok(DependencyReport {
                slug,
                manager: "go".into(),
                outdated: Vec::new(),
                error: Some("go list 超时".into()),
            }),
            Err(e) => Ok(DependencyReport {
                slug,
                manager: "go".into(),
                outdated: Vec::new(),
                error: Some(format!("无法运行 go: {e}")),
            }),
        }
    } else if repo.join("uv.lock").exists() {
        // uv (r20-N2-2). A `uv.lock` means the project is managed by uv, whose own
        // outdated listing has the same JSON shape pip's `--format=json` produces
        // (`[{name, version, latest_version, …}]`, which is why one parser serves both).
        // uv is installed on this machine (`uv 0.12.9`), so the *command* is real here
        // even though the answer depends on index access at run time.
        let mut cmd = crate::proc::silent("uv");
        cmd.args(["pip", "list", "--outdated", "--format", "json"])
            .current_dir(&repo);
        match crate::proc::output_timeout(&mut cmd, std::time::Duration::from_secs(30)) {
            Ok(Some(out)) if out.status.success() => {
                let text = String::from_utf8_lossy(&out.stdout);
                Ok(DependencyReport {
                    slug,
                    manager: "uv".into(),
                    outdated: parse_pip_outdated(&text),
                    error: None,
                })
            }
            Ok(Some(out)) => Ok(DependencyReport {
                slug,
                manager: "uv".into(),
                outdated: Vec::new(),
                error: Some(String::from_utf8_lossy(&out.stderr).trim().to_string()),
            }),
            Ok(None) => Ok(DependencyReport {
                slug,
                manager: "uv".into(),
                outdated: Vec::new(),
                error: Some("uv pip list 超时".into()),
            }),
            Err(e) => Ok(DependencyReport {
                slug,
                manager: "uv".into(),
                outdated: Vec::new(),
                error: Some(format!("无法运行 uv: {e}")),
            }),
        }
    } else if repo.join("requirements.txt").exists()
        || repo.join("pyproject.toml").exists()
        || repo.join("setup.py").exists()
    {
        // pip: try `pip` first, fall back to `python -m pip` for venvs where
        // the pip shim is not on PATH.
        let managers: &[&[&str]] = &[&["pip"], &["python", "-m", "pip"]];
        let mut last_err: Option<String> = None;
        for mgr in managers {
            let mut cmd = crate::proc::silent(mgr[0]);
            cmd.args(&mgr[1..])
                .args(["list", "--outdated", "--format=json"])
                .current_dir(&repo);
            match crate::proc::output_timeout(&mut cmd, std::time::Duration::from_secs(30)) {
                Ok(Some(out)) if out.status.success() => {
                    let text = String::from_utf8_lossy(&out.stdout);
                    let outdated = parse_pip_outdated(&text);
                    return Ok(DependencyReport {
                        slug,
                        manager: "pip".into(),
                        outdated,
                        error: None,
                    });
                }
                Ok(Some(out)) => {
                    last_err = Some(String::from_utf8_lossy(&out.stderr).trim().to_string());
                }
                Ok(None) => last_err = Some("pip list 超时".into()),
                Err(e) => last_err = Some(e.to_string()),
            }
        }
        Ok(DependencyReport {
            slug,
            manager: "pip".into(),
            outdated: Vec::new(),
            error: last_err,
        })
    } else {
        Ok(DependencyReport {
            slug,
            manager: "none".into(),
            outdated: Vec::new(),
            error: None,
        })
    }
}

/// Parses `npm outdated --json`: an object keyed by package name, each value a
/// `{current, wanted, latest, dependent, location}` map.
fn parse_npm_outdated(text: &str) -> Vec<Dependency> {
    let Ok(map) = serde_json::from_str::<std::collections::BTreeMap<String, serde_json::Value>>(text)
    else {
        return Vec::new();
    };
    map.into_iter()
        .filter_map(|(name, v)| {
            let obj = v.as_object()?;
            Some(Dependency {
                name,
                current: obj.get("current").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                wanted: obj.get("wanted").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                latest: obj.get("latest").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            })
        })
        .collect()
}

/// Parses `pip list --outdated --format=json`: an array of
/// `{name, version, latest_version, latest_filetype}`.
fn parse_pip_outdated(text: &str) -> Vec<Dependency> {
    let Ok(arr) = serde_json::from_str::<Vec<serde_json::Value>>(text) else {
        return Vec::new();
    };
    arr.into_iter()
        .filter_map(|v| {
            let obj = v.as_object()?;
            Some(Dependency {
                name: obj.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                current: obj.get("version").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                wanted: obj
                    .get("latest_version")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                latest: obj
                    .get("latest_version")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
            })
        })
        .collect()
}

/// Parses `cargo outdated --format json`.
///
/// Real-machine shape, pinned by the 2026-10-19 run on this repo (cargo-outdated
/// 0.19.0 from `vendor/`, fixture `tests/fixtures/deps/cargo-outdated.json`,
/// 398 rows): a single object `{"crate_name": …, "dependencies": […]}` whose
/// rows carry `name` (usually a `parent->child` chain), `project` (the version
/// in the tree), `compat` (newest version the current constraints allow, `"---"`
/// when none), `latest` (newest published, or the literal `"Removed"` for a
/// yanked crate), `kind`, `platform`. A `latest` that is not a version
/// (`Removed`/`---`) is skipped — reporting it would name an upgrade target that
/// cannot be installed. `wanted` takes `compat` (the `"---"` placeholder never
/// reaches the report) and falls back to `latest`.
///
/// The pre-0.19 `crate`-object spelling (`old`/`new`/`want`) is still accepted,
/// as an explicitly unverified tolerance rather than a second observation: only
/// the `project`/`latest` reading has machine evidence behind it. Unknown shapes
/// degrade to an empty list plus the tool's own stderr — never to a wrong version
/// number (before this run pinned the real fields, the parser read `old`/`new`
/// and the real 398-row file parsed to **zero** rows behind exit 0).
fn parse_cargo_outdated(text: &str) -> Vec<Dependency> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };
    let items: Vec<&serde_json::Value> = match value.as_array() {
        Some(arr) => arr.iter().collect(),
        None => value
            .get("dependencies")
            .and_then(|d| d.as_array())
            .map(|arr| arr.iter().collect())
            .unwrap_or_default(),
    };
    let mut out = Vec::new();
    for item in items {
        let c = item.get("crate").unwrap_or(item);
        let name = c.get("name").and_then(|v| v.as_str()).unwrap_or("");
        // `project` is a bool (workspace member flag) in the pre-0.19 spelling and
        // a version string in 0.19 — `as_str` on the bool returns None, so the
        // `old` fallback is reached exactly there.
        let current = c
            .get("project")
            .and_then(|v| v.as_str())
            .or_else(|| c.get("old").and_then(|v| v.as_str()))
            .unwrap_or("");
        let latest = c
            .get("latest")
            .and_then(|v| v.as_str())
            .or_else(|| c.get("new").and_then(|v| v.as_str()))
            .unwrap_or("");
        if name.is_empty() || latest.is_empty() || latest == current {
            continue;
        }
        if latest == "Removed" || latest == "---" {
            continue;
        }
        let compat = c.get("compat").and_then(|v| v.as_str()).unwrap_or("");
        let wanted = if !compat.is_empty() && compat != "---" {
            compat
        } else {
            c.get("want")
                .and_then(|v| v.as_str())
                .filter(|w| !w.is_empty())
                .unwrap_or(latest)
        };
        out.push(Dependency {
            name: name.to_string(),
            current: current.to_string(),
            wanted: wanted.to_string(),
            latest: latest.to_string(),
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Parses `go list -m -u -json all`: concatenated JSON objects with no enclosing array,
/// one per module. `Update.Version` is present only when a newer version exists, and
/// `Main: true` marks the module being built — which has nothing to upgrade.
fn parse_go_list_upgrades(text: &str) -> Vec<Dependency> {
    let mut out = Vec::new();
    let mut stream = serde_json::Deserializer::from_str(text).into_iter::<serde_json::Value>();
    while let Some(Ok(value)) = stream.next() {
        let path = value.get("Path").and_then(|v| v.as_str()).unwrap_or("");
        if path.is_empty() || value.get("Main").and_then(|v| v.as_bool()) == Some(true) {
            continue;
        }
        let Some(update) = value.get("Update") else { continue };
        let latest = update.get("Version").and_then(|v| v.as_str()).unwrap_or("");
        let current = value.get("Version").and_then(|v| v.as_str()).unwrap_or("");
        if latest.is_empty() || latest == current {
            continue;
        }
        out.push(Dependency {
            name: path.to_string(),
            current: current.to_string(),
            wanted: latest.to_string(),
            latest: latest.to_string(),
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Parses `yarn outdated --json` (yarn 1.22.22, real-machine measured
/// 2026-10-19 — fixture `tests/fixtures/deps/yarn-outdated.jsonl`): JSON-lines,
/// **not** an array (r20 assumed `[{package, …}]` without ever executing it; that
/// read yielded zero rows against the real output). One `{"type":"info", …}`
/// legend line precedes a `{"type":"table","data":{head, body}}`; columns are
/// located by their header names (`Package`/`Current`/`Wanted`/`Latest`), so
/// yarn's extra columns (`Package Type`/`URL`) or a reorder cannot shift the
/// read. Non-table lines are skipped, absent cells are dropped rather than
/// invented, and a row already at `Latest` is not outdated.
fn parse_yarn_outdated(text: &str) -> Vec<Dependency> {
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // yarn prints one JSON document per line; a line that is not one is dropped.
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if value.get("type").and_then(|t| t.as_str()) != Some("table") {
            continue;
        }
        let Some(data) = value.get("data") else { continue };
        let Some(head) = data.get("head").and_then(|h| h.as_array()) else { continue };
        let col = |label: &str| head.iter().position(|h| h.as_str() == Some(label));
        let (Some(i_pkg), Some(i_cur), Some(i_want), Some(i_lat)) =
            (col("Package"), col("Current"), col("Wanted"), col("Latest"))
        else {
            continue;
        };
        let Some(body) = data.get("body").and_then(|b| b.as_array()) else { continue };
        for row in body {
            let Some(cells) = row.as_array() else { continue };
            let name = cells.get(i_pkg).and_then(|c| c.as_str()).unwrap_or("");
            let current = cells.get(i_cur).and_then(|c| c.as_str()).unwrap_or("");
            let wanted = cells.get(i_want).and_then(|c| c.as_str()).unwrap_or("");
            let latest = cells.get(i_lat).and_then(|c| c.as_str()).unwrap_or("");
            if name.is_empty() || latest.is_empty() || latest == current {
                continue;
            }
            out.push(Dependency {
                name: name.to_string(),
                current: current.to_string(),
                wanted: if wanted.is_empty() { current } else { wanted }.to_string(),
                latest: latest.to_string(),
            });
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

#[cfg(test)]
mod ecosystem_tests {
    use super::{parse_cargo_outdated, parse_go_list_upgrades, parse_yarn_outdated};

    #[test]
    fn cargo_reads_the_crate_object_and_skips_uptodate_rows() {
        // Pre-0.19 spelling (`crate` object with `old`/`new`/`want`, `project` as a
        // bool flag) — kept as a defensive tolerance, NOT a machine observation:
        // this machine has only ever produced the `project`/`latest` shape, which
        // `cargo_real_machine_object_shape_is_read` pins. Unknown spellings must
        // keep degrading to fewer rows, never to a wrong version.
        let text = r#"[
          {"crate":{"name":"serde","project":false,"old":"1.0.100","want":"^1.0","new":"1.0.190","ignore":false}},
          {"crate":{"name":"log","project":false,"old":"0.4.20","want":"^0.4","new":"0.4.20","ignore":false}}
        ]"#;
        let got = parse_cargo_outdated(text);
        assert_eq!(got.len(), 1, "an up-to-date row is not an outdated dependency");
        assert_eq!(got[0].name, "serde");
        assert_eq!(got[0].current, "1.0.100");
        assert_eq!(got[0].latest, "1.0.190");
        assert_eq!(got[0].wanted, "^1.0");
    }

    #[test]
    fn cargo_accepts_the_wrapped_array_and_surprises_nothing() {
        assert!(parse_cargo_outdated("not json").is_empty());
        assert!(parse_cargo_outdated(r#"{"dependencies":[]}"#).is_empty());
        let wrapped = r#"{"dependencies":[{"name":"clippy","old":"0.1.0","new":"0.2.0"}]}"#;
        let got = parse_cargo_outdated(wrapped);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].wanted, "0.2.0", "a missing `want` falls back to `new`, not to empty");
    }

    /// 真机底稿（r21-R2-1：cargo-outdated 0.19.0 装入 vendor 后实跑本仓 src-tauri/，
    /// `cargo outdated --format json` exit 0、398 行；安装与执行读数见
    /// docs/deps-ecosystems.md §6.1 与 §6）。形状是单个对象 `{"crate_name",
    /// "dependencies"}`，行字段为 name/project/compat/latest/kind/platform——
    /// **没有** r20 假设的 `crate` 对象与 `old`/`new`。
    #[test]
    fn cargo_real_machine_object_shape_is_read() {
        let text = include_str!("../../tests/fixtures/deps/cargo-outdated.json");
        let got = parse_cargo_outdated(text);
        assert_eq!(got.len(), 298, "398 行输入，100 行 latest=Removed 被跳过，其余全收");
        assert!(got.iter().all(|d| d.latest != "Removed"), "已撤 crate 不是可安装的升级目标");
        assert!(got.iter().all(|d| d.wanted != "---"), "wanted 不能是占位符");
        let row = got
            .iter()
            .find(|d| d.name == "android_system_properties->libc")
            .expect("真机首行在 fixture 里");
        assert_eq!(row.current, "0.2.189");
        assert_eq!(row.wanted, "0.2.191");
        assert_eq!(row.latest, "0.2.191");
        // compat="---"（当前约束内无兼容版）：wanted 退回 latest，而不是把 "---" 显示给人。
        let no_compat = got.iter().find(|d| d.name == "fs4->rustix").expect("真机 compat=--- 行");
        assert_eq!(no_compat.current, "0.38.44");
        assert_eq!(no_compat.latest, "1.1.5");
        assert_eq!(no_compat.wanted, "1.1.5");
    }

    #[test]
    fn go_stream_reads_only_modules_with_an_update() {
        // Three documents back to back with no enclosing array — the shape `go list`
        // actually prints — plus the main module, which must never appear.
        // Fixture-only on purpose: this machine has no go toolchain (r21-R2-1
        // re-probed, spawnSync ENOENT — evidence in docs/deps-ecosystems.md §6.2),
        // so no real stdout exists to pin these fields; they rest on go.dev/ref/mod
        // alone, and §6.2 records that cost plus the alternatives.
        let text = r#"{
  "Path": "example.com/main",
  "Main": true,
  "Version": "v0.0.0"
}
{
  "Path": "golang.org/x/net",
  "Version": "v0.1.0",
  "Time": "2023-01-01T00:00:00Z"
}
{
  "Path": "github.com/gin-gonic/gin",
  "Version": "v1.7.0",
  "Update": {
    "Path": "github.com/gin-gonic/gin",
    "Version": "v1.9.1",
    "Time": "2023-06-01T00:00:00Z"
  }
}"#;
        let got = parse_go_list_upgrades(text);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name, "github.com/gin-gonic/gin");
        assert_eq!(got[0].current, "v1.7.0");
        assert_eq!(got[0].latest, "v1.9.1");
    }

    #[test]
    fn go_stream_tolerates_a_truncated_tail() {
        // A killed `go list` leaves half an object on stdout. Dropping it is right;
        // panicking or reporting a phantom version is not.
        let text = r#"{"Path":"a","Version":"v1","Update":{"Version":"v2"}}
{"Path":"b","Version":"v1","Up"#;
        let got = parse_go_list_upgrades(text);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name, "a");
    }

    /// 真机底稿（r21-R2-1：yarn 1.22.22，`.r2-scratch\yarn-demo` 临时工程，
    /// `yarn outdated --json` exit 1——yarn 用退出码 1 表示「有过期项」，同 npm）。
    /// 形状是 JSON-lines 两行：info 图例 + table 行，**不是** r20 假设的 `[{package,…}]`。
    #[test]
    fn yarn_real_machine_json_lines_table_is_read() {
        let text = include_str!("../../tests/fixtures/deps/yarn-outdated.jsonl");
        let got = parse_yarn_outdated(text);
        assert_eq!(got.len(), 1, "真机 table 里只有 ms 过期（left-pad 已最新，不进 body）");
        assert_eq!(got[0].name, "ms");
        assert_eq!(got[0].current, "0.7.3");
        assert_eq!(got[0].wanted, "0.7.3");
        assert_eq!(got[0].latest, "2.1.3");
    }

    #[test]
    fn yarn_skips_legend_lines_and_rows_already_current() {
        let text = concat!(
            r#"{"type":"info","data":"Color legend : ..."}"#,
            "\n",
            r#"{"type":"table","data":{"head":["Package","Current","Wanted","Latest","Package Type","URL"],"body":[["left-pad","1.3.0","1.3.0","1.3.0","dependencies","x"],["ms","0.7.3","0.7.3","2.1.3","dependencies","y"]]}}"#,
            "\n",
        );
        let got = parse_yarn_outdated(text);
        assert_eq!(got.len(), 1, "latest 与 current 相等的行不是过期依赖");
        assert_eq!(got[0].name, "ms");
        assert!(parse_yarn_outdated(r#"{"type":"info","data":"x"}"#).is_empty(), "非 table 行不是 yarn 的答案");
        assert!(parse_yarn_outdated("{}").is_empty());
    }

    #[test]
    fn yarn_columns_are_located_by_header_not_by_position() {
        // Table 的列顺序不是契约（yarn 还会打 Package Type/URL 列）：按表头名字找列，
        // 固定下标的实现会在这行上读串。
        let text =
            r#"{"type":"table","data":{"head":["Latest","Package","Current","Wanted"],"body":[["9.9.9","react","17.0.2","18.2.0"]]}}"#;
        let got = parse_yarn_outdated(text);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].name, "react");
        assert_eq!(got[0].current, "17.0.2");
        assert_eq!(got[0].wanted, "18.2.0");
        assert_eq!(got[0].latest, "9.9.9");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_npm_outdated_reads_current_wanted_latest() {
        let json = r#"{
            "react": {"current": "17.0.0", "wanted": "17.0.2", "latest": "18.2.0"},
            "left-pad": {"current": "1.0.0", "wanted": "1.0.0", "latest": "1.3.0"}
        }"#;
        let deps = parse_npm_outdated(json);
        assert_eq!(deps.len(), 2);
        assert_eq!(deps[0].name, "left-pad");
        assert_eq!(deps[0].latest, "1.3.0");
        assert_eq!(deps[1].name, "react");
        assert_eq!(deps[1].current, "17.0.0");
    }

    #[test]
    fn parse_npm_outdated_invalid_json_returns_empty() {
        assert!(parse_npm_outdated("{not json").is_empty());
    }

    /// 真机底稿（r21-R2-1：npm 10.9.3，本工作树 `npm outdated --json`，12 条）。
    /// fixture 已脱敏——location 的本机盘符换成 `<repo>`；parser 只读
    /// current/wanted/latest，location/dependent 被忽略，这正是脱敏不损测试的原因。
    #[test]
    fn npm_real_machine_fixture_reads_twelve_rows() {
        let text = include_str!("../../tests/fixtures/deps/npm-outdated.json");
        assert!(!text.contains("D:\\"), "fixture 不得带本机盘符");
        let deps = parse_npm_outdated(text);
        assert_eq!(deps.len(), 12);
        // npm 的 wanted 是 semver range 内最新：eslint 卡在 9.39.4，latest 已 10.13.0。
        let eslint = deps.iter().find(|d| d.name == "eslint").expect("真机 12 条含 eslint");
        assert_eq!(eslint.current, "9.39.4");
        assert_eq!(eslint.wanted, "9.39.4");
        assert_eq!(eslint.latest, "10.13.0");
    }

    /// 真机底稿（pnpm 10.33.0，同一工作树 `pnpm outdated --json`，12 条，含 pnpm
    /// 私有字段 isDeprecated/dependencyType，会被忽略）。pnpm 的 wanted 遵守
    /// lockfile（= current），npm 的 wanted 是 range 内最新——同一仓两种读数，
    /// 这里钉 pnpm 一侧。
    #[test]
    fn pnpm_real_machine_fixture_pins_lockfile_wanted() {
        let text = include_str!("../../tests/fixtures/deps/pnpm-outdated.json");
        let deps = parse_npm_outdated(text);
        assert_eq!(deps.len(), 12);
        let api = deps
            .iter()
            .find(|d| d.name == "@tauri-apps/api")
            .expect("真机 12 条含 @tauri-apps/api");
        assert_eq!(api.current, "2.12.1");
        assert_eq!(api.wanted, "2.12.1", "pnpm 的 wanted = lockfile 版本，与 current 同");
        assert_eq!(api.latest, "2.12.4");
    }

    /// 真机底稿（uv 0.12.10，临时 venv `uv pip list --outdated --format json`，
    /// 1 条）——与 pip `--format=json` 同形，故复用 parse_pip_outdated。
    #[test]
    fn uv_real_machine_fixture_reads_one_row() {
        let text = include_str!("../../tests/fixtures/deps/uv-outdated.json");
        let deps = parse_pip_outdated(text);
        assert_eq!(deps.len(), 1);
        assert_eq!(deps[0].name, "requests");
        assert_eq!(deps[0].current, "2.31.0");
        assert_eq!(deps[0].wanted, "2.34.2");
        assert_eq!(deps[0].latest, "2.34.2");
    }

    /// 真机底稿（pip 26.0.1 系统环境，`pip list --outdated --format=json` exit 0：
    /// stdout 就是空数组；stderr 的 `~treamlit` 警告不进 stdout——r21-R2 补跑
    /// 再次复现，原件 pip-outdated-raw.json 未入库，此 fixture 为其逐字节拷贝）。
    #[test]
    fn pip_real_machine_fixture_is_an_empty_array() {
        let text = include_str!("../../tests/fixtures/deps/pip-outdated.json");
        assert!(parse_pip_outdated(text).is_empty());
    }

    #[test]
    fn parse_pip_outdated_reads_version_and_latest() {
        let json = r#"[
            {"name": "requests", "version": "2.25.0", "latest_version": "2.31.0", "latest_filetype": "wheel"},
            {"name": "flask", "version": "1.0.0", "latest_version": "3.0.0", "latest_filetype": "wheel"}
        ]"#;
        let deps = parse_pip_outdated(json);
        assert_eq!(deps.len(), 2);
        assert_eq!(deps[0].name, "requests");
        assert_eq!(deps[0].current, "2.25.0");
        assert_eq!(deps[0].latest, "2.31.0");
    }

    #[test]
    fn parse_pip_outdated_invalid_json_returns_empty() {
        assert!(parse_pip_outdated("[not json").is_empty());
    }
}
