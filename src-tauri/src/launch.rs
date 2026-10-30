//! Launch-command inference.
//!
//! The agreed flow is: inspect the repository, propose candidate commands **with
//! the evidence for each**, let the user confirm or edit, then persist the
//! choice. Nothing here runs automatically.
//!
//! Why inference and not execution: README files are unstructured prose. A guess
//! is useful only as a starting point, so every candidate carries the file and
//! (where possible) the line it came from, and the UI must show that evidence.
//! Claiming reliable automatic detection would be false.

use serde::{Deserialize, Serialize};
use std::path::Path;

/// How long one sequential launch step may run before the launcher gives up
/// on it.
///
/// Generous — an `npm install` step legitimately takes minutes — but
/// bounded: the old bare `child.wait()` here had no deadline, so a wedged
/// step parked the whole `launch_steps_all` command forever and the UI never
/// saw a failure. This mirrors the rule the downloader's pull/clone loops
/// already follow (`PULL_TIMEOUT`/`CLONE_TIMEOUT`): every wait in this crate
/// is a deadline. Parallel steps are unaffected — they are handed to the
/// registry and never waited on.
pub const SEQUENTIAL_STEP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30 * 60);

/// Deadline for `<interpreter> -m venv <dir>`.
///
/// Deliberately far above [`PROBE_TIMEOUT`]-style probes: `venv` bootstraps pip
/// via ensurepip, which downloads and unpacks. Three minutes is generous next to
/// a healthy machine yet still a deadline — the dialog has already committed to
/// waiting, and an interpreter that hangs would otherwise hold a blocking thread
/// and a reserved venv path for the rest of the session.
pub const VENV_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LaunchKind {
    /// Run in the foreground, streaming output to the app.
    Run,
    /// Install dependencies first, then run.
    InstallThenRun,
    /// Start a long-running server.
    Serve,
    /// Build artefacts.
    Build,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub command: String,
    /// Human-readable origin, e.g. "package.json scripts.dev" or "README.md:42".
    pub evidence: String,
    pub kind: LaunchKind,
    /// Higher means more trustworthy. Used only for ordering.
    pub confidence: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectionReport {
    /// Detected ecosystem, for display, e.g. "node", "python", "rust".
    pub project_type: Option<String>,
    pub candidates: Vec<Candidate>,
    /// Files that were inspected, so the UI can explain a negative result.
    pub inspected: Vec<String>,
    /// Anything that could not be read.
    pub notes: Vec<String>,
    /// Risk hits keyed by the exact command string, so the candidate list can
    /// show *why* a proposal needs a second look. Empty candidates are omitted;
    /// lookups treat a missing command as "no hits".
    #[serde(default)]
    pub risks: Vec<CandidateRisk>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateRisk {
    pub command: String,
    pub hits: Vec<crate::launch_risk::RiskHit>,
}

/// Command prefixes that mean "run the project". Separated so the README parser
/// can look for the same verbs the manifests use.
const RUN_VERBS: &[&str] = &[
    "npm run",
    "pnpm",
    "yarn",
    "bun run",
    "cargo run",
    "go run",
    "python",
    "uvicorn",
    "flask run",
    "docker compose up",
    "make",
];

fn read_trimmed(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

/// Which package manager a Node repository asks for, and what installing with it
/// is actually called. Returns `(manager, install command, lockfile found)`.
///
/// Used twice on purpose - the candidate inference below and 装依赖
/// ([`install_plan`]) - because two places choosing a manager independently is how
/// the app ends up installing with npm what it launches with pnpm.
fn node_manager(root: &Path) -> (&'static str, &'static str, Option<&'static str>) {
    if root.join("pnpm-lock.yaml").is_file() {
        ("pnpm", "pnpm install", Some("pnpm-lock.yaml"))
    } else if root.join("yarn.lock").is_file() {
        ("yarn", "yarn", Some("yarn.lock"))
    } else if root.join("bun.lockb").is_file() {
        ("bun", "bun install", Some("bun.lockb"))
    } else if root.join("package-lock.json").is_file() {
        ("npm", "npm install", Some("package-lock.json"))
    } else {
        ("npm", "npm install", None)
    }
}

/// The dependency install step of a repository, with the evidence behind it.
///
/// This is 需求 8.4's half of the bargain: the candidates the inference produces
/// are proposals, and REQUIREMENTS §3.2 makes the user's confirmation the
/// correctness guarantee. So the plan carries the **exact** command and every file
/// it was derived from, and nothing here executes anything - running it goes
/// through the same confirmed-step path as any other launch step.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallPlan {
    /// What will be run, verbatim, in the repository's own directory.
    pub command: String,
    /// One line saying why this command: the lockfile or manifest that chose it.
    pub evidence: String,
    /// Every file consulted, so a wrong guess is falsifiable without re-reading code.
    pub inspected: Vec<String>,
    /// `node` | `python`, for the label next to the command.
    pub ecosystem: String,
    /// A manager that is not on this machine: the plan is still shown (the user may
    /// install it), but the UI must say the tool is missing.
    pub tool_present: bool,
    pub tool_name: String,
}

/// venv-aware install plan. `venv` is the repository's own environment
/// when one exists (`lib::venv_for` already refuses a directory that is not one).
pub fn install_plan_for(root: &Path, venv: Option<&Path>) -> Option<InstallPlan> {
    // Node wins when a repository carries both, which is the same precedence
    // `detect_launch` uses to label the project - an inconsistent answer between
    // the two would be a bug the user sees as "它把我的 Python 项目当 npm 装了".
    if root.join("package.json").is_file() {
        let (manager, install, lockfile) = node_manager(root);
        let mut inspected = vec!["package.json".to_string()];
        if let Some(l) = lockfile {
            inspected.push(l.to_string());
        }
        let evidence = match lockfile {
            Some(l) => format!("{l} 存在 → 用 {manager} 安装依赖"),
            None => "package.json 存在但没有任何锁文件 → 按 npm 约定安装".to_string(),
        };
        return Some(InstallPlan {
            command: install.to_string(),
            evidence,
            inspected,
            ecosystem: "node".to_string(),
            tool_name: manager.to_string(),
            tool_present: which_one(&[manager]).is_some(),
        });
    }
    // Python, in the order a reader would expect the file names to matter.
    for (file, cmd, why) in [
        ("requirements.txt", "pip install -r requirements.txt", "requirements.txt 存在"),
        (
            "pyproject.toml",
            "pip install -e .",
            "pyproject.toml 存在（可编辑安装，含依赖声明）",
        ),
        ("Pipfile", "pipenv install", "Pipfile 存在 → 项目用 pipenv"),
        ("uv.lock", "uv sync", "uv.lock 存在 → 项目用 uv"),
        ("environment.yml", "conda env create -f environment.yml", "environment.yml 存在 → conda 环境"),
    ] {
        if root.join(file).is_file() {
            let tool = cmd.split_whitespace().next().unwrap_or("pip");
            // 需求 8.5 + REQUIREMENTS §5.2: a dependency install must not land in
            // the machine's interpreter. When the repository has an environment, the
            // step runs that environment's own `python -m pip` (bare `pip` resolves
            // through PATH, which is exactly the thing this app promises not to
            // depend on or pollute). When it has none, the plan says so instead of
            // offering a command that would write into a system Python.
            let (command, evidence) = match (venv, cmd.strip_prefix("pip")) {
                (Some(v), Some(tail)) => {
                    let py = v.join("Scripts").join("python.exe");
                    (
                        format!("\"{}\" -m pip {}", py.display(), tail.trim_start()),
                        format!("{why}，装入该仓库的虚拟环境（{}）", v.display()),
                    )
                }
                (None, Some(_)) => (
                    cmd.to_string(),
                    format!(
                        "{why}；该仓库还没有虚拟环境，直接执行会装进系统解释器（违反「不污染用户环境」）——\
                         请先在 项目设置 → Python 创建环境"
                    ),
                ),
                _ => (cmd.to_string(), why.to_string()),
            };
            return Some(InstallPlan {
                command,
                evidence,
                inspected: vec![file.to_string()],
                ecosystem: "python".to_string(),
                tool_name: tool.to_string(),
                tool_present: which_one(&[tool]).is_some(),
            });
        }
    }
    None
}

/// Reads `package.json` and proposes every non-trivial npm script.
///
/// Scripts are ranked: dev/serve/start first (that is what "run" means for a web
/// project), then build, then anything else.
fn detect_node(
    root: &Path,
    inspected: &mut Vec<String>,
    notes: &mut Vec<String>,
) -> Vec<Candidate> {
    let pkg = root.join("package.json");
    if !pkg.is_file() {
        return Vec::new();
    }
    inspected.push("package.json".to_string());

    let text = match read_trimmed(&pkg) {
        Some(t) => t,
        None => {
            notes.push("package.json 存在但无法读取".to_string());
            return Vec::new();
        }
    };
    let json: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => {
            notes.push(format!("package.json 解析失败: {e}"));
            return Vec::new();
        }
    };

    let (manager, _, lockfile) = node_manager(root);
    if let Some(l) = lockfile {
        inspected.push(l.to_string());
    }

    let mut out = Vec::new();
    let scripts = match json.get("scripts").and_then(|v| v.as_object()) {
        Some(s) => s,
        None => {
            notes.push("package.json 没有 scripts 字段".to_string());
            // Still useful: many repos expect `npm start` implicitly.
            out.push(Candidate {
                command: format!("{manager} start"),
                evidence: "package.json 无 scripts；npm 默认 start 约定".to_string(),
                kind: LaunchKind::Run,
                confidence: 40,
            });
            return out;
        }
    };

    // Map of script name -> (kind, confidence bump)
    let rank = |name: &str| -> Option<(LaunchKind, u8)> {
        match name {
            "dev" | "develop" => Some((LaunchKind::Run, 30)),
            "start" => Some((LaunchKind::Run, 28)),
            "serve" => Some((LaunchKind::Serve, 26)),
            "preview" => Some((LaunchKind::Serve, 10)),
            "build" => Some((LaunchKind::Build, 0)),
            _ => None,
        }
    };

    let mut names: Vec<&String> = scripts.keys().collect();
    // Deterministic order, then ranked by the table above.
    names.sort();
    names.sort_by_key(|n| std::cmp::Reverse(rank(n).map(|(_, c)| c).unwrap_or(1)));

    let install = match manager {
        "pnpm" => "pnpm install",
        "yarn" => "yarn",
        "bun" => "bun install",
        _ => "npm install",
    };

    for name in names {
        let body = scripts.get(name).and_then(|v| v.as_str()).unwrap_or("");
        if body.trim().is_empty() {
            continue;
        }
        let (kind, bonus) = rank(name).unwrap_or((LaunchKind::Run, 1));
        let run_cmd = match manager {
            "yarn" => format!("yarn {name}"),
            "bun" => format!("bun run {name}"),
            "pnpm" => format!("pnpm run {name}"),
            _ => format!("npm run {name}"),
        };
        out.push(Candidate {
            command: run_cmd.clone(),
            evidence: format!("package.json scripts.{name} = \"{}\"", truncate(body, 60)),
            kind,
            confidence: 50 + bonus,
        });
        // For the primary script, also offer install-then-run.
        if bonus >= 26 {
            out.push(Candidate {
                command: format!("{install} && {run_cmd}"),
                evidence: format!("package.json scripts.{name}（先安装依赖）"),
                kind: LaunchKind::InstallThenRun,
                confidence: 45 + bonus,
            });
        }
    }
    out
}

fn detect_python(
    root: &Path,
    inspected: &mut Vec<String>,
    notes: &mut Vec<String>,
) -> Vec<Candidate> {
    let mut out = Vec::new();

    if root.join("manage.py").is_file() {
        inspected.push("manage.py".to_string());
        out.push(Candidate {
            command: "python manage.py runserver".to_string(),
            evidence: "manage.py 存在（Django 约定）".to_string(),
            kind: LaunchKind::Serve,
            confidence: 85,
        });
    }
    if root.join("app.py").is_file() || root.join("main.py").is_file() {
        let f = if root.join("app.py").is_file() {
            "app.py"
        } else {
            "main.py"
        };
        inspected.push(f.to_string());
        out.push(Candidate {
            command: format!("python {f}"),
            evidence: format!("{f} 存在"),
            kind: LaunchKind::Run,
            confidence: 55,
        });
    }
    if root.join("requirements.txt").is_file() {
        inspected.push("requirements.txt".to_string());
        out.push(Candidate {
            command: "pip install -r requirements.txt".to_string(),
            evidence: "requirements.txt 存在".to_string(),
            kind: LaunchKind::Build,
            confidence: 50,
        });
    }

    // pyproject.toml: look for console scripts and known frameworks.
    let pp = root.join("pyproject.toml");
    if pp.is_file() {
        inspected.push("pyproject.toml".to_string());
        if let Some(text) = read_trimmed(&pp) {
            if text.contains("[project.scripts]") {
                out.push(Candidate {
                    command: "pip install -e .".to_string(),
                    evidence: "pyproject.toml [project.scripts]（可编辑安装后可用命令行入口）"
                        .to_string(),
                    kind: LaunchKind::Build,
                    confidence: 60,
                });
            }
            for fw in ["uvicorn", "fastapi", "flask", "streamlit"] {
                if text.to_ascii_lowercase().contains(fw) {
                    out.push(Candidate {
                        command: format!("python -m {fw}"),
                        evidence: format!("pyproject.toml 提到 {fw}"),
                        kind: LaunchKind::Serve,
                        confidence: 35,
                    });
                    break;
                }
            }
        }
    }
    if root.join("uv.lock").is_file() {
        inspected.push("uv.lock".to_string());
        out.push(Candidate {
            command: "uv run python -m app".to_string(),
            evidence: "uv.lock 存在（uv 管理的项目）".to_string(),
            kind: LaunchKind::Run,
            confidence: 45,
        });
        notes.push("uv 项目通常用 `uv run <入口>`，请按实际入口修改".to_string());
    }
    out
}

fn detect_rust(root: &Path, inspected: &mut Vec<String>) -> Vec<Candidate> {
    if !root.join("Cargo.toml").is_file() {
        return Vec::new();
    }
    inspected.push("Cargo.toml".to_string());
    vec![
        Candidate {
            command: "cargo run".to_string(),
            evidence: "Cargo.toml 存在".to_string(),
            kind: LaunchKind::Run,
            confidence: 85,
        },
        Candidate {
            command: "cargo build --release".to_string(),
            evidence: "Cargo.toml 存在".to_string(),
            kind: LaunchKind::Build,
            confidence: 40,
        },
    ]
}

fn detect_go(root: &Path, inspected: &mut Vec<String>) -> Vec<Candidate> {
    if !root.join("go.mod").is_file() {
        return Vec::new();
    }
    inspected.push("go.mod".to_string());
    vec![
        Candidate {
            command: "go run .".to_string(),
            evidence: "go.mod 存在".to_string(),
            kind: LaunchKind::Run,
            confidence: 80,
        },
        Candidate {
            command: "go build ./...".to_string(),
            evidence: "go.mod 存在".to_string(),
            kind: LaunchKind::Build,
            confidence: 40,
        },
    ]
}

fn detect_other(root: &Path, inspected: &mut Vec<String>) -> Vec<Candidate> {
    let mut out = Vec::new();
    if root.join("docker-compose.yml").is_file() || root.join("compose.yaml").is_file() {
        let f = if root.join("docker-compose.yml").is_file() {
            "docker-compose.yml"
        } else {
            "compose.yaml"
        };
        inspected.push(f.to_string());
        out.push(Candidate {
            command: "docker compose up".to_string(),
            evidence: format!("{f} 存在"),
            kind: LaunchKind::Serve,
            confidence: 75,
        });
    }
    if root.join("Makefile").is_file() {
        inspected.push("Makefile".to_string());
        // Only propose targets that conventionally mean "run".
        if let Some(text) = read_trimmed(&root.join("Makefile")) {
            for target in ["run", "dev", "serve", "start"] {
                let needle = format!("\n{target}:");
                if text.contains(&needle) || text.starts_with(&format!("{target}:")) {
                    out.push(Candidate {
                        command: format!("make {target}"),
                        evidence: format!("Makefile 中定义了 {target} 目标"),
                        kind: LaunchKind::Run,
                        confidence: 70,
                    });
                    break;
                }
            }
        }
    }
    for (file, cmd, kind, conf) in [
        (
            "scripts/dev.sh",
            "bash scripts/dev.sh",
            LaunchKind::Run,
            55u8,
        ),
        ("dev.sh", "bash dev.sh", LaunchKind::Run, 50),
        ("start.sh", "bash start.sh", LaunchKind::Run, 50),
        ("run.sh", "bash run.sh", LaunchKind::Run, 50),
    ] {
        if root.join(file).is_file() {
            inspected.push(file.to_string());
            out.push(Candidate {
                command: cmd.to_string(),
                evidence: format!("{file} 存在"),
                kind,
                confidence: conf,
            });
        }
    }
    out
}

/// Scans a README for fenced code blocks and proposes the lines that look like
/// run commands, recording the line number as evidence.
fn detect_readme(root: &Path, inspected: &mut Vec<String>) -> Vec<Candidate> {
    let mut path = None;
    for name in [
        "README.md",
        "README.MD",
        "readme.md",
        "README.rst",
        "README.txt",
        "README",
    ] {
        let p = root.join(name);
        if p.is_file() {
            inspected.push(name.to_string());
            path = Some(p);
            break;
        }
    }
    let path = match path {
        Some(p) => p,
        None => return Vec::new(),
    };
    let text = match read_trimmed(&path) {
        Some(t) => t,
        None => return Vec::new(),
    };

    let mut out: Vec<Candidate> = Vec::new();
    let mut in_fence = false;
    for (i, raw) in text.lines().enumerate() {
        let line = raw.trim();
        if line.starts_with("```") {
            in_fence = !in_fence;
            continue;
        }
        if !in_fence {
            continue;
        }
        // Strip common prompt markers.
        let candidate = line
            .trim_start_matches('$')
            .trim_start_matches('>')
            .trim_start_matches('#')
            .trim();
        if candidate.is_empty() || candidate.starts_with('#') {
            continue;
        }
        if !RUN_VERBS.iter().any(|v| candidate.starts_with(v)) {
            continue;
        }
        if out.iter().any(|c| c.command == candidate) {
            continue;
        }
        out.push(Candidate {
            command: candidate.to_string(),
            evidence: format!("README 第 {} 行代码块", i + 1),
            // READMEs are prose; keep confidence below manifest-derived guesses.
            kind: LaunchKind::Run,
            confidence: 30,
        });
        if out.len() >= 6 {
            break;
        }
    }
    out
}

fn truncate(s: &str, n: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= n {
        return s.to_string();
    }
    let t: String = s.chars().take(n).collect();
    format!("{t}…")
}

/// Inspects a repository and returns ranked launch candidates.
pub fn detect_launch(root: &Path) -> DetectionReport {
    let mut inspected: Vec<String> = Vec::new();
    let mut notes: Vec<String> = Vec::new();
    let mut candidates: Vec<Candidate> = Vec::new();

    let node = detect_node(root, &mut inspected, &mut notes);
    let python = detect_python(root, &mut inspected, &mut notes);
    let rust = detect_rust(root, &mut inspected);
    let go = detect_go(root, &mut inspected);
    let other = detect_other(root, &mut inspected);
    let readme = detect_readme(root, &mut inspected);

    let project_type = if !node.is_empty() {
        Some("node".to_string())
    } else if !python.is_empty() {
        Some("python".to_string())
    } else if !rust.is_empty() {
        Some("rust".to_string())
    } else if !go.is_empty() {
        Some("go".to_string())
    } else if !other.is_empty() {
        Some("other".to_string())
    } else {
        None
    };

    candidates.extend(node);
    candidates.extend(python);
    candidates.extend(rust);
    candidates.extend(go);
    candidates.extend(other);
    candidates.extend(readme);

    // Stable order: confidence desc, then command text. Sorting by command
    // *first* is what makes dedup actually work below - `dedup_by` only removes
    // adjacent duplicates, so equal commands must end up next to each other.
    candidates.sort_by(|a, b| {
        b.confidence
            .cmp(&a.confidence)
            .then_with(|| a.command.cmp(&b.command))
    });
    candidates.sort_by(|a, b| a.command.cmp(&b.command));
    candidates.dedup_by(|a, b| a.command == b.command);
    // Restore the ranking that the UI should display.
    candidates.sort_by(|a, b| {
        b.confidence
            .cmp(&a.confidence)
            .then_with(|| a.command.cmp(&b.command))
    });

    if candidates.is_empty() {
        notes.push(
            "没有从任何配置或 README 中推断出启动命令，请手动填写。这是一个正常结果，不是错误。"
                .to_string(),
        );
    }
    inspected.sort();
    inspected.dedup();

    // Classify the *deduplicated* command list: the UI joins on the command text,
    // and a risk computed before dedup could attach to a row that no longer exists.
    let risks: Vec<CandidateRisk> = candidates
        .iter()
        .filter_map(|c| {
            let hits = crate::launch_risk::classify(&c.command);
            (!hits.is_empty()).then(|| CandidateRisk {
                command: c.command.clone(),
                hits,
            })
        })
        .collect();

    DetectionReport {
        project_type,
        candidates,
        inspected,
        notes,
        risks,
    }
}

// ---------------------------------------------------------------------------
// Persisted launch configuration
// ---------------------------------------------------------------------------

/// The user-confirmed command for one repository.
///
/// One command string plus an optional working directory relative to the repo
/// root. Multi-command repositories use `steps` instead; `command` stays the
/// source of truth for a single-step configuration so existing markers on disk
/// keep working unchanged.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LaunchConfig {
    pub command: String,
    /// Relative to the repository root; empty means the root itself.
    #[serde(default)]
    pub cwd: String,
    /// True when the user edited or typed it rather than accepting a guess.
    #[serde(default)]
    pub user_confirmed: bool,
    #[serde(default)]
    pub kind: Option<LaunchKind>,
    /// Multi-step commands. Empty means "single step, use `command`".
    #[serde(default)]
    pub steps: Vec<LaunchStep>,
}

/// One step of a multi-step launch configuration.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LaunchStep {
    /// Display name, e.g. "安装依赖".
    #[serde(default)]
    pub name: String,
    pub command: String,
    /// Relative to the repository root; empty means the repo root.
    #[serde(default)]
    pub cwd: String,
    /// Parallel steps run together when the whole configuration is launched;
    /// sequential steps wait for the previous sequential step to exit.
    #[serde(default)]
    pub parallel: bool,
}

impl LaunchConfig {
    /// The effective step list, single-step configs included.
    ///
    /// A marker saved before steps existed has none, so the single `command`
    /// becomes the one step — this is what keeps old `.devhub.json` files
    /// working without a migration.
    pub fn effective_steps(&self) -> Vec<LaunchStep> {
        if !self.steps.is_empty() {
            return self.steps.clone();
        }
        if self.command.trim().is_empty() {
            return Vec::new();
        }
        vec![LaunchStep {
            name: "启动".to_string(),
            command: self.command.clone(),
            cwd: self.cwd.clone(),
            parallel: false,
        }]
    }
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

/// Environment a launched command needs in order to be isolated.
#[derive(Debug, Clone, Default)]
pub struct LaunchEnv {
    /// Venv directory; its `Scripts` goes on PATH so `python` resolves inside it.
    pub venv: Option<std::path::PathBuf>,
    /// Port assignments, exported as DEVHUB_PORT_<SERVICE>.
    pub ports: Vec<(String, u16)>,
    /// Directory of the interpreter this repository pinned (round 11, 需求 8.5).
    ///
    /// Prepended *after* the venv, so an explicit venv still wins: the whole
    /// point of a venv is that it is the python, and a pinned interpreter is
    /// for repositories that have no venv (or must not use one).
    pub python_dir: Option<std::path::PathBuf>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchStarted {
    pub pid: u32,
    pub command: String,
    pub cwd: String,
}

/// Builds the child environment.
///
/// Returns the variable list rather than mutating the parent process, so two
/// repos can never leak settings into each other.
///
/// PATH order is venv `Scripts`, then the pinned interpreter's directory, then
/// whatever the app itself inherited. The venv comes first because a venv *is*
/// the environment; the pin exists for repositories that deliberately run
/// without one (需求 8.5).
pub fn child_env(env: &LaunchEnv) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut paths: Vec<std::path::PathBuf> = Vec::new();
    if let Some(venv) = &env.venv {
        let scripts = venv.join("Scripts");
        out.push((
            "VIRTUAL_ENV".to_string(),
            venv.to_string_lossy().to_string(),
        ));
        paths.push(scripts);
    }
    if let Some(dir) = &env.python_dir {
        paths.push(dir.clone());
    }
    if !paths.is_empty() {
        if let Some(existing) = std::env::var_os("PATH") {
            paths.extend(std::env::split_paths(&existing));
            if let Ok(joined) = std::env::join_paths(paths) {
                out.push(("PATH".to_string(), joined.to_string_lossy().to_string()));
            }
        }
    }
    for (name, port) in &env.ports {
        out.push((
            format!("DEVHUB_PORT_{}", name.to_ascii_uppercase()),
            port.to_string(),
        ));
    }
    out
}

fn resolve_cwd(root: &Path, cfg: &LaunchConfig) -> std::path::PathBuf {
    if cfg.cwd.trim().is_empty() {
        return root.to_path_buf();
    }
    let p = root.join(cfg.cwd.trim());
    if p.is_dir() {
        p
    } else {
        root.to_path_buf()
    }
}

fn apply_env(cmd: &mut std::process::Command, env: &LaunchEnv) {
    for (k, v) in child_env(env) {
        cmd.env(k, v);
    }
}

// ---------------------------------------------------------------------------
// Worktree status (round 11, 需求 8.3)
// ---------------------------------------------------------------------------

/// What git says about a repository's working tree, for the 清理/删除
/// confirmations.
///
/// 清理 deletes `node_modules`/`target`/`dist` and 删除 removes the whole
/// directory; both are irreversible in practice, and neither used to look at
/// whether the user had uncommitted work in there. `REQUIREMENTS.md` §3.1
/// already separates 仅清缓存 from 彻底删除 - this is the fact the separation
/// was missing.
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeStatus {
    /// The directory is a git repository at all.
    pub has_git: bool,
    /// Current branch name, when git will say.
    pub branch: Option<String>,
    /// Modified/staged files, from `git status --porcelain`.
    pub dirty: usize,
    /// Untracked files (the `??` lines), counted separately: they are what a
    /// build leaves behind and what a user most often does not care about.
    pub untracked: usize,
    /// Commits the local branch is ahead of its upstream, when there is one.
    pub ahead: Option<u32>,
}

/// Reads the working tree's state. Never fails: every field degrades to "git
/// would not say", because a status badge must not be able to fail a delete.
pub fn worktree_status(repo: &Path) -> WorktreeStatus {
    let mut st = WorktreeStatus::default();
    if !repo.join(".git").exists() {
        return st;
    }
    st.has_git = true;
    let git = match crate::downloader::find_git(None) {
        Some(g) => std::path::PathBuf::from(g.path),
        None => return st,
    };
    let quiet = |args: &[&str]| -> Option<String> {
        // Bounded: this runs inside the synchronous `repo_worktree_status`
        // command on the main thread, so a wedged git must degrade to "git
        // would not say" instead of freezing the window (the three calls below
        // used to share one unbounded `.output()` each).
        let mut cmd = crate::proc::silent(&git);
        cmd.arg("-C").arg(repo).args(args).env("GIT_TERMINAL_PROMPT", "0");
        let out = crate::proc::output_timeout(&mut cmd, crate::proc::PROBE_TIMEOUT).ok()??;
        if !out.status.success() {
            return None;
        }
        // `decode_console`: this is a git subprocess's stdout, and the text it can
        // carry (branch names, paths) is formatted by Windows in the OEM codepage.
        // It lands in the permanent-delete confirmation, where mojibake reads as
        // "nothing to see".
        Some(crate::proc::decode_console(&out.stdout))
    };
    if let Some(b) = quiet(&["rev-parse", "--abbrev-ref", "HEAD"]) {
        let b = b.trim().to_string();
        if !b.is_empty() {
            st.branch = Some(b);
        }
    }
    if let Some(s) = quiet(&["status", "--porcelain"]) {
        for line in s.lines() {
            if line.starts_with("??") {
                st.untracked += 1;
            } else if !line.trim().is_empty() {
                st.dirty += 1;
            }
        }
    }
    if let Some(a) = quiet(&["rev-list", "--count", "@{upstream}..HEAD"]) {
        st.ahead = a.trim().parse().ok();
    }
    st
}

// ---------------------------------------------------------------------------
// Python interpreters (round 11, 需求 8.5)
// ---------------------------------------------------------------------------

/// One Python installation the machine offers.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PythonInstall {
    /// The interpreter's own path - also the value stored as the pin.
    pub id: String,
    /// e.g. `3.12`.
    pub version: String,
    /// Where it was found: the `py` launcher, or `PATH`.
    pub source: String,
}

/// Parses the `py -0p` listing into interpreters.
///
/// The launcher's output shape (three installs, `REQUIREMENTS.md` §3.6):
///
/// ```text
///  -V:3.13-64 *        C:\Users\me\AppData\Local\Programs\Python\Python313\python.exe
///  -V:3.12-64          C:\Python312\python.exe
/// ```
///
/// The `*` marks the default. Only lines that actually name a `python*.exe`
/// are accepted, so the header line and any future decoration cannot invent an
/// interpreter. A pure function of its input, so the shape is unit-tested
/// rather than trusted.
pub fn parse_py_list(text: &str) -> Vec<PythonInstall> {
    let mut out: Vec<PythonInstall> = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        // The path is the last whitespace-separated token that looks like a
        // python executable. The suffix test runs on the QUOTE-TRIMMED token: some
        // locales wrap the path in `"…"`, and matching the raw token would reject
        // every quoted line because it ends with a quote, not with `python.exe`.
        let Some(path_token) = trimmed
            .split_whitespace()
            .find(|t| t.trim_matches('"').to_ascii_lowercase().ends_with("python.exe"))
        else {
            continue;
        };
        let id = path_token.trim_matches('"').to_string();
        if id.is_empty() || out.iter().any(|p: &PythonInstall| p.id == id) {
            continue;
        }
        // Version: the `-V:3.12` / `-3.12` token, else the digits in the path.
        let version = trimmed
            .split_whitespace()
            .find_map(|t| {
                let t = t.trim_start_matches('-').trim_start_matches('V').trim_start_matches(':');
                let v = t.split('-').next().unwrap_or("");
                (v.len() >= 3 && v.starts_with(|c: char| c.is_ascii_digit()) && v.contains('.'))
                    .then(|| v.to_string())
            })
            .unwrap_or_else(|| {
                id.rsplit(['\\', '/'])
                    .next()
                    .unwrap_or("")
                    .trim_start_matches("python")
                    .to_string()
            });
        out.push(PythonInstall {
            id,
            version,
            source: "py".to_string(),
        });
    }
    out
}

/// Every interpreter the machine offers: the `py` launcher's list, plus
/// whatever `python` resolves to on `PATH`.
///
/// The PATH entry is deduplicated against the launcher's list by path, and its
/// source says so - the two answer different questions ("what does `python`
/// mean" vs "what else is installed").
pub fn list_pythons() -> Vec<PythonInstall> {
    let mut out: Vec<PythonInstall> = Vec::new();
    // Each probe is bounded: `list_pythons` runs inside the synchronous
    // `list_pythons` command (main thread), and three unbounded `.output()`
    // calls meant three separate ways for a wedged launcher to freeze the
    // window. `Ok(None)` is the deadline — treated as "not installed".
    let mut py_cmd = crate::proc::silent(std::path::Path::new("py"));
    py_cmd.args(["-0p"]);
    if let Ok(Some(o)) = crate::proc::output_timeout(&mut py_cmd, crate::proc::PROBE_TIMEOUT) {
        if o.status.success() {
            out.extend(parse_py_list(&crate::proc::decode_console(&o.stdout)));
        }
    }
    let mut pyv_cmd = crate::proc::silent(std::path::Path::new("python"));
    pyv_cmd.arg("--version");
    if let Ok(Some(o)) = crate::proc::output_timeout(&mut pyv_cmd, crate::proc::PROBE_TIMEOUT) {
        if o.status.success() {
            let mut which_cmd = crate::proc::silent(std::path::Path::new("where"));
            which_cmd.arg("python");
            if let Ok(Some(which)) = crate::proc::output_timeout(&mut which_cmd, crate::proc::PROBE_TIMEOUT)
            {
                let path = crate::proc::decode_console(&which.stdout)
                    .lines()
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if !path.is_empty() && !out.iter().any(|p| p.id.eq_ignore_ascii_case(&path)) {
                    let version = crate::proc::decode_console(&o.stdout)
                        .trim()
                        .trim_start_matches("Python ")
                        .to_string();
                    out.push(PythonInstall {
                        id: path,
                        version,
                        source: "PATH".to_string(),
                    });
                }
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// venv creation (round 11, 需求 8.6)
// ---------------------------------------------------------------------------

/// Creates a virtual environment with `interpreter -m venv <dir>`.
///
/// The venv lives **outside** the repository (`项目\venvs\<slug>`, per
/// `REQUIREMENTS.md` §2.1) so same-named repositories cannot collide - the same
/// rule the launch path has always followed, applied to creation instead of
/// only to lookup.
///
/// `ensurepip` is skipped by nothing: it is what makes the venv usable, and it
/// is also the slow part (measured ~10 s on this machine). The caller shows
/// Accepts only a python-shaped interpreter *file* before anything is executed.
///
/// `create_repo_venv` used to hand the page's free-text `python` argument straight to
/// `Command::new`, so any string reaching that command was executed under the app's
/// own privileges — it was not checked against what `list_pythons()` discovered (whose
/// `id` field *is* the interpreter path), nor contained by `path_guard`. The name check
/// plus the "it is an existing file" check is what makes the argument a path to a
/// Python rather than a program name.
pub fn validate_interpreter(raw: &str) -> Result<std::path::PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("没有选择 Python 解释器".to_string());
    }
    let p = std::path::Path::new(trimmed);
    let Some(name) = p.file_name().map(|n| n.to_string_lossy().to_lowercase()) else {
        return Err("解释器路径不完整".to_string());
    };
    const ALLOWED: &[&str] = &["python", "python.exe", "python3", "python3.exe", "py", "py.exe"];
    if !ALLOWED.contains(&name.as_str()) {
        return Err(format!(
            "只能执行 python 解释器，收到的「{name}」不是；请从列表里选一个解释器"
        ));
    }
    match std::fs::metadata(p) {
        Ok(m) if m.is_file() => Ok(p.to_path_buf()),
        Ok(_) => Err("解释器路径不是文件".to_string()),
        Err(_) => Err(format!("找不到解释器：{trimmed}")),
    }
}

/// The `<major>.<minor>` one interpreter reports, or `None` when it will not say.
///
/// `Marker::python_version` was a write-never field for the whole life of this
/// app (`REQUIREMENTS.md` §3.6 names it as the one remaining dead field), which is
/// why 需求 8.5's version lock could not be checked after the fact: the record of
/// *which* Python a repository was built against existed only as a path. This is
/// the probe that makes the field real, and it is deliberately not `list_pythons()`
/// (a full machine scan) for the price of one pin.
pub fn interpreter_version(interpreter: &str) -> Option<String> {
    let mut cmd = crate::proc::silent(interpreter);
    cmd.arg("-c").arg(
        "import sys;print('{}.{}'.format(sys.version_info[0],sys.version_info[1]))",
    );
    let out = crate::proc::output_timeout(&mut cmd, crate::proc::PROBE_TIMEOUT).ok()??;
    if !out.status.success() {
        return None;
    }
    let text = crate::proc::decode_console(&out.stdout).trim().to_string();
    // Only ever a `3.12`-shaped answer: this string lands in a marker that other
    // code compares, and a stray banner on stdout must not become a version.
    let shaped = !text.is_empty()
        && text.len() <= 8
        && text.chars().all(|c| c.is_ascii_digit() || c == '.')
        && text.contains('.');
    shaped.then_some(text)
}

/// progress; this function just refuses to lie about a failure half-way.
pub fn create_venv(interpreter: &str, venv: &Path) -> Result<(), String> {
    if let Some(parent) = venv.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("无法创建 {}: {e}", parent.display()))?;
    }
    // Bounded, and generous: `-m venv` runs ensurepip, which on a cold machine or
    // under an AV scan is minutes rather than seconds. An unbounded `.output()`
    // here parked a blocking thread for as long as the interpreter chose, with the
    // dialog already committed to waiting on it.
    let mut cmd = crate::proc::silent(std::path::Path::new(interpreter));
    cmd.arg("-m")
        .arg("venv")
        .arg(venv)
        .env("PYTHONIOENCODING", "utf-8");
    let out = match crate::proc::output_timeout(&mut cmd, VENV_TIMEOUT) {
        Ok(Some(o)) => o,
        // The partial directory is deliberately left in place: `looks_like_venv`
        // still says "not a venv", so the next attempt retries, and deleting a
        // tree that a wedged interpreter may still hold open would fail anyway.
        Ok(None) => {
            return Err(format!(
                "{} -m venv 超过 {} 秒未结束，已中止；{} 可能不完整，可稍后重试创建",
                interpreter,
                VENV_TIMEOUT.as_secs(),
                venv.display()
            ))
        }
        Err(e) => return Err(format!("无法启动 {interpreter}: {e}")),
    };
    if !out.status.success() {
        let text = crate::proc::decode_console(&out.stderr);
        let text = text.trim();
        return Err(if text.is_empty() {
            format!("python -m venv 退出码 {:?}，无诊断输出", out.status.code())
        } else {
            format!("创建虚拟环境失败: {}", truncate(text, 300))
        });
    }
    // Proof, not assumption: the directory exists *and* carries the marker
    // file, or a half-made venv would be recorded as working.
    if !venv.join("pyvenv.cfg").is_file() {
        return Err("venv 目录已创建但没有 pyvenv.cfg，视为失败".to_string());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Port health (round 11, 需求 8.9)
// ---------------------------------------------------------------------------

/// Whether something accepts TCP on this loopback port right now.
///
/// A connect, not an HTTP request: the honest answer to "did my server come
/// up" without guessing what protocol it speaks. Loopback connects fail
/// instantly when refused, so the timeout only bounds pathological cases.
pub fn port_listening(port: u16) -> bool {
    use std::net::{TcpStream, ToSocketAddrs};
    let Ok(addrs) = ("127.0.0.1", port).to_socket_addrs() else {
        return false;
    };
    addrs
        .into_iter()
        .any(|a| TcpStream::connect_timeout(&a, std::time::Duration::from_millis(300)).is_ok())
}

/// One service's port, and whether it answered.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortHealth {
    pub service: String,
    pub port: u16,
    pub listening: bool,
}

/// The health of every port the marker assigned to a repository.
///
/// Probed concurrently: a serial loop cost one 300 ms timeout per dead service, and
/// a repository with four services could hold the command for 1.2 s. The same lesson
/// was already written down for the link probe (`downloader.rs`, `PROBE_TIMEOUT`).
/// Results keep the input order, which is what the panel renders.
pub fn port_health(services: &[(String, u16)]) -> Vec<PortHealth> {
    std::thread::scope(|scope| {
        let probes: Vec<(String, u16, std::thread::ScopedJoinHandle<'_, bool>)> = services
            .iter()
            .map(|(name, port)| {
                let (name, port) = (name.clone(), *port);
                let handle = scope.spawn(move || port_listening(port));
                (name, port, handle)
            })
            .collect();
        probes
            .into_iter()
            .map(|(name, port, handle)| PortHealth {
                // A probe that panicked says nothing about the port, so the honest
                // answer is "did not hear back", not a dropped service row.
                listening: handle.join().unwrap_or(false),
                service: name,
                port,
            })
            .collect()
    })
}

/// Handed every long-lived child the launcher spawns, so the app can report
/// whether it is still running and stop it again.
///
/// Before this, `launch_run` pushed the `Child` into a throwaway thread that
/// called `wait()` and dropped the exit status. Nothing could tell the user
/// whether the command had finished, still running, or died two seconds in with
/// code 1 - which is exactly the reported "看不出是否执行完成".
pub type SpawnSink = std::sync::Arc<dyn Fn(std::process::Child, String) + Send + Sync>;

/// A sink that ignores the child. Used by the headless probes, which wait on
/// the process themselves.
pub fn null_spawn_sink() -> SpawnSink {
    std::sync::Arc::new(|_child, _label| {})
}

/// Lines kept per repository, and repositories kept in the session log.
///
/// This is a debugging aid, not an archive: it lives in memory only, is cleared
/// when a new launch starts, and is never written to disk or to the activity
/// log. A command that prints a token prints it here too, which is exactly why
/// the lifetime is one session and the size is bounded.
const LAUNCH_LOG_LINES: usize = 500;
const LAUNCH_LOG_SLUG_CAP: usize = 200;

static LAUNCH_LOGS: std::sync::Mutex<Option<std::collections::HashMap<String, std::collections::VecDeque<String>>>> =
    std::sync::Mutex::new(None);

fn launch_logs() -> std::sync::MutexGuard<'static, Option<std::collections::HashMap<String, std::collections::VecDeque<String>>>> {
    LAUNCH_LOGS.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) fn clear_launch_log(slug: &str) {
    if let Some(map) = launch_logs().as_mut() {
        map.remove(slug);
    }
}

fn append_launch_log(slug: &str, stage: &str, message: &str) {
    let mut guard = launch_logs();
    let map = guard.get_or_insert_with(std::collections::HashMap::new);
    if !map.contains_key(slug) && map.len() >= LAUNCH_LOG_SLUG_CAP {
        if let Some(oldest) = map.keys().next().cloned() {
            map.remove(&oldest);
        }
    }
    let lines = map.entry(slug.to_string()).or_default();
    lines.push_back(format!("[{stage}] {message}"));
    while lines.len() > LAUNCH_LOG_LINES {
        lines.pop_front();
    }
}

/// Wrap a progress sink so every line is also kept for `launch_output`.
///
/// Clearing here, not on read, means the panel shows the **last run** rather
/// than an interleaving of every run in the session. The wrapper is created once
/// per launch command, before any process starts.
pub(crate) fn logging_sink(slug: &str, inner: crate::downloader::ProgressFn) -> crate::downloader::ProgressFn {
    clear_launch_log(slug);
    let key = slug.to_string();
    std::sync::Arc::new(move |stage: &str, message: &str| {
        append_launch_log(&key, stage, message);
        inner(stage, message);
    })
}

/// The last run's output for one repository, oldest first.
#[tauri::command]
pub async fn launch_output(slug: String) -> Vec<String> {
    launch_logs()
        .as_ref()
        .and_then(|map| map.get(&slug))
        .map(|lines| lines.iter().cloned().collect())
        .unwrap_or_default()
}

/// Spawns `cmd` with stdout and stderr piped into `progress`, and returns the
/// live handle.
///
/// Both pipes are drained on their own threads: a child that writes more than
/// the OS pipe buffer and is never read from blocks forever, which would look
/// like "the app hung".
fn spawn_streaming(
    mut cmd: std::process::Command,
    progress: &crate::downloader::ProgressFn,
) -> Result<std::process::Child, String> {
    use std::process::Stdio;
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null());
    let mut child = cmd.spawn().map_err(|e| format!("无法启动进程: {e}"))?;

    if let Some(out) = child.stdout.take() {
        let p = progress.clone();
        std::thread::spawn(move || {
            use std::io::BufRead;
            for line in std::io::BufReader::new(out).lines().map_while(Result::ok) {
                p("launch", &line);
            }
        });
    }
    if let Some(err) = child.stderr.take() {
        let p = progress.clone();
        std::thread::spawn(move || {
            use std::io::BufRead;
            for line in std::io::BufReader::new(err).lines().map_while(Result::ok) {
                p("launch-error", &line);
            }
        });
    }
    Ok(child)
}

/// Runs the command in the background, with output streamed via `progress`.
/// The child keeps running after this returns; it is handed to `on_spawn`,
/// which is responsible for reaping it.
pub fn launch_run(
    progress: crate::downloader::ProgressFn,
    root: &Path,
    cfg: &LaunchConfig,
    env: &LaunchEnv,
    on_spawn: &SpawnSink,
) -> Result<LaunchStarted, String> {
    let cwd = resolve_cwd(root, cfg);
    progress(
        "launch",
        &format!("在 {} 执行：{}", cwd.display(), cfg.command),
    );

    let mut cmd = crate::proc::silent("cmd");
    cmd.arg("/C").arg(&cfg.command);
    cmd.current_dir(&cwd);
    apply_env(&mut cmd, env);

    let child = spawn_streaming(cmd, &progress)?;
    let pid = child.id();
    on_spawn(child, cfg.command.clone());

    Ok(LaunchStarted {
        pid,
        command: cfg.command.clone(),
        cwd: cwd.to_string_lossy().to_string(),
    })
}

// ---------------------------------------------------------------------------
// Multi-step execution
// ---------------------------------------------------------------------------

/// Runs ONE step in the background (output streamed, not waited on). This is
/// what a per-step click uses.
pub fn launch_single_step(
    progress: crate::downloader::ProgressFn,
    root: &Path,
    step: &LaunchStep,
    env: &LaunchEnv,
    on_spawn: &SpawnSink,
) -> Result<LaunchStarted, String> {
    let step_cwd = if step.cwd.trim().is_empty() {
        root.to_path_buf()
    } else {
        let p = root.join(step.cwd.trim());
        if p.is_dir() {
            p
        } else {
            root.to_path_buf()
        }
    };
    let label = if step.name.trim().is_empty() {
        step.command.clone()
    } else {
        step.name.clone()
    };
    progress(
        "launch",
        &format!("在 {} 执行步骤「{}」：{}", step_cwd.display(), label, step.command),
    );

    let mut cmd = crate::proc::silent("cmd");
    cmd.arg("/C").arg(&step.command);
    cmd.current_dir(&step_cwd);
    apply_env(&mut cmd, env);

    let child = spawn_streaming(cmd, &progress)?;
    let pid = child.id();
    on_spawn(child, format!("{label}：{}", step.command));

    Ok(LaunchStarted {
        pid,
        command: step.command.clone(),
        cwd: step_cwd.to_string_lossy().to_string(),
    })
}

/// Summary of running the whole step list.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepsRunReport {
    pub started: Vec<String>,
    pub failed: Vec<String>,
}

/// Runs the whole step list.
///
/// Sequential steps wait for the previous sequential step to exit before the
/// next one starts, so "install then run" composes naturally. Parallel steps
/// are all spawned together and not waited on — a dev server never exits, so
/// waiting on one would hang the launch.
pub fn launch_steps_all(
    progress: crate::downloader::ProgressFn,
    root: &Path,
    steps: &[LaunchStep],
    env: &LaunchEnv,
    on_spawn: &SpawnSink,
) -> StepsRunReport {
    let mut report = StepsRunReport {
        started: Vec::new(),
        failed: Vec::new(),
    };

    // Parallel batches: consecutive parallel steps run together.
    let mut i = 0;
    while i < steps.len() {
        if steps[i].parallel {
            let mut batch: Vec<&LaunchStep> = Vec::new();
            while i < steps.len() && steps[i].parallel {
                batch.push(&steps[i]);
                i += 1;
            }
            for step in &batch {
                match launch_single_step(progress.clone(), root, step, env, on_spawn) {
                    Ok(s) => {
                        progress(
                            "launch",
                            &format!("并行步骤「{}」已启动 (PID {})", step_label(step), s.pid),
                        );
                        report.started.push(step_label(step));
                    }
                    Err(e) => {
                        progress(
                            "launch-error",
                            &format!("并行步骤「{}」启动失败: {e}", step_label(step)),
                        );
                        report.failed.push(step_label(step));
                    }
                }
            }
            continue;
        }

        // Sequential: run, stream, wait for the exit code.
        let step = &steps[i];
        let label = step_label(step);
        let step_cwd = if step.cwd.trim().is_empty() {
            root.to_path_buf()
        } else {
            let p = root.join(step.cwd.trim());
            if p.is_dir() {
                p
            } else {
                root.to_path_buf()
            }
        };
        progress(
            "launch",
            &format!("在 {} 执行步骤「{}」：{}", step_cwd.display(), label, step.command),
        );

        let mut cmd = crate::proc::silent("cmd");
        cmd.arg("/C").arg(&step.command);
        cmd.current_dir(&step_cwd);
        apply_env(&mut cmd, env);

        // `step-started` is a status transition, not a log line: the UI turns it
        // into the spinner, and it must arrive before the wait below blocks.
        progress("step-started", &label);
        match spawn_streaming(cmd, &progress) {
            Ok(mut child) => {
                report.started.push(label.clone());
                let pid = child.id();
                progress("launch", &format!("步骤「{label}」已启动 (PID {pid})"));
                // Bounded, same shape as the downloader's poll loops: a bare
                // `child.wait()` here had no deadline at all.
                let wait_started = std::time::Instant::now();
                let status = loop {
                    match child.try_wait() {
                        Ok(Some(status)) => break Some(status),
                        Ok(None) => {
                            if wait_started.elapsed() > SEQUENTIAL_STEP_TIMEOUT {
                                // Same teardown the exit policy uses: taskkill the
                                // tree first (the tracked child is usually cmd.exe
                                // and the thing that must die is its child), then
                                // kill+wait the handle we own. Bounded — this loop
                                // is already past a 30-minute deadline, the last
                                // thing it needs is an unbounded `taskkill` wait.
                                let mut taskkill = crate::proc::silent("taskkill");
                                taskkill.args(["/PID", &pid.to_string(), "/T", "/F"]);
                                let _ = crate::proc::output_timeout(
                                    &mut taskkill,
                                    crate::proc::PROBE_TIMEOUT,
                                );
                                let _ = child.kill();
                                let _ = child.wait();
                                // `step-done` must close the step the deadline killed,
                                // not only `launch-error`: the dialog clears its
                                // 运行中 marker *only* on `step-done`
                                // (LaunchDialog.tsx:220), so an expiring step left the
                                // spinner turning forever after the deadline. `-1` is
                                // the same sentinel a killed child already reports via
                                // `status.code().unwrap_or(-1)`.
                                progress("step-done", &format!("{label}|-1"));
                                progress(
                                    "launch-error",
                                    &format!(
                                        "步骤「{label}」超过 {} 分钟仍未结束，已中止，后续顺序步骤停止",
                                        SEQUENTIAL_STEP_TIMEOUT.as_secs() / 60
                                    ),
                                );
                                report.failed.push(label.clone());
                                break None;
                            }
                            std::thread::sleep(std::time::Duration::from_millis(200));
                        }
                        Err(e) => {
                            let _ = child.kill();
                            let _ = child.wait();
                            progress("step-done", &format!("{label}|-1"));
                            progress("launch-error", &format!("步骤「{label}」等待失败: {e}"));
                            report.failed.push(label.clone());
                            break None;
                        }
                    }
                };
                let Some(status) = status else {
                    // The failure (timeout or wait error) was already narrated
                    // and recorded; stop the remaining sequential steps, exactly
                    // as a non-zero exit does below.
                    break;
                };
                let code = status.code().unwrap_or(-1);
                if code == 0 {
                    progress("step-done", &format!("{label}|0"));
                } else {
                    progress("step-done", &format!("{label}|{code}"));
                    progress(
                        "launch-error",
                        &format!("步骤「{label}」退出码 {code}，后续顺序步骤停止"),
                    );
                    report.failed.push(label);
                    break;
                }
            }
            Err(e) => {
                progress("launch-error", &format!("步骤「{label}」启动失败: {e}"));
                report.failed.push(label);
                break;
            }
        }
        i += 1;
    }

    report
}

fn step_label(step: &LaunchStep) -> String {
    if step.name.trim().is_empty() {
        step.command.clone()
    } else {
        step.name.clone()
    }
}

// ---------------------------------------------------------------------------
// Terminal / IDE selection
// ---------------------------------------------------------------------------

/// One detectable external tool (a terminal or an IDE).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    /// Stable id used by `open_terminal_with` / `open_ide_with`.
    pub id: String,
    /// Display label.
    pub label: String,
    /// Executable to spawn. Not sent for wsl entries (id carries the distro).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Extra display info, e.g. the version or the distro name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// `data:image/png;base64,...` for an IDE, extracted from its executable.
    /// Terminals and IDEs found without a readable icon leave this `None`, and
    /// the UI draws a generic glyph.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

/// The first executable on `PATH` matching any of `names`, memoised.
///
/// The walk is `PATH` directories × names × `is_file()` - and it ran once per
/// terminal candidate on every 启动面板 open, plus once per tool inside
/// `repo_environments`. Same reasoning as `GIT_CACHE`: this is a machine fact that
/// only changes when something is installed, and `Some(None)` is a real answer
/// ("checked, not there") rather than "not checked yet".
///
/// Keyed by the whole candidate list because that is what decides the winner: two
/// names present in two different `PATH` directories must not be cached per name.
pub(crate) fn which_one(names: &[&str]) -> Option<String> {
    type Memo = std::sync::Mutex<std::collections::HashMap<String, Option<String>>>;
    static CACHE: std::sync::OnceLock<Memo> = std::sync::OnceLock::new();
    let cache = CACHE.get_or_init(Memo::default);
    let key = names.join("|");

    if let Ok(c) = cache.lock() {
        if let Some(hit) = c.get(&key) {
            return hit.clone();
        }
    }
    let found = which_one_uncached(names);
    if let Ok(mut c) = cache.lock() {
        c.insert(key, found.clone());
    }
    found
}

fn which_one_uncached(names: &[&str]) -> Option<String> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        for name in names {
            let cand = dir.join(name);
            if cand.is_file() {
                return Some(cand.to_string_lossy().to_string());
            }
        }
    }
    None
}

/// Terminals the user can pick from. Only what is actually present is listed.
pub fn detect_terminals() -> Vec<ToolInfo> {
    let mut out = Vec::new();
    if let Some(p) = which_one(&["pwsh.exe", "pwsh.cmd"]) {
        out.push(ToolInfo {
            id: "pwsh".into(),
            label: "PowerShell 7".into(),
            path: Some(p),
            detail: None,
            icon: None,
        });
    }
    if let Some(p) = which_one(&["powershell.exe"]) {
        out.push(ToolInfo {
            id: "powershell".into(),
            label: "Windows PowerShell".into(),
            path: Some(p),
            detail: None,
            icon: None,
        });
    }
    // cmd.exe is always present on Windows, but resolve the real path anyway.
    if let Some(p) = which_one(&["cmd.exe"]) {
        out.push(ToolInfo {
            id: "cmd".into(),
            label: "CMD".into(),
            path: Some(p),
            detail: None,
            icon: None,
        });
    }
    if let Some(p) = which_one(&["wsl.exe"]) {
        for distro in wsl_distros(&p) {
            out.push(ToolInfo {
                id: format!("wsl:{distro}"),
                label: format!("WSL · {distro}"),
                path: Some(p.clone()),
                detail: None,
                icon: None,
            });
        }
    }
    out
}

/// Heuristically decides whether a `wsl -l -q` stdout buffer is UTF-16LE.
///
/// Two independent signals, either one is enough:
///   * **BOM**: the buffer opens with `FF FE` — the little-endian UTF-16 BOM.
///   * **NUL pattern**: the buffer is even-length and the bytes at odd
///     offsets (the high bytes of each 16-bit unit) are zero. An ASCII-only
///     UTF-16LE stream (`"Ubuntu"` → `U 0 b 0 u 0 n 0 t 0 u 0`) has exactly
///     this shape; a real ASCII UTF-8 stream never does.
///
/// The old one-byte check (`raw[1] == 0`) was not robust: a single ASCII
/// character that happens to sit at byte 1 (e.g. `"A..."`) would read as
/// "UTF-16LE" even when the buffer was plain UTF-8. The NUL pattern above
/// catches the genuine case and is safe to run on any length. When neither
/// signal matches, the buffer is assumed to be UTF-8 (the safe fallback).
fn looks_utf16le(raw: &[u8]) -> bool {
    // BOM is the strongest single signal.
    if raw.len() >= 2 && raw[0] == 0xFF && raw[1] == 0xFE {
        return true;
    }
    // NUL pattern: even length and the high bytes of every unit are zero.
    // Only meaningful when there is at least one full 16-bit unit.
    if raw.len() >= 4 && raw.len().is_multiple_of(2) {
        let mut all_zero = true;
        for i in (1..raw.len()).step_by(2) {
            if raw[i] != 0 {
                all_zero = false;
                break;
            }
        }
        if all_zero {
            return true;
        }
    }
    false
}

/// Lists installed WSL distributions. `wsl -l -q` emits UTF-16LE, so the output
/// is decoded accordingly (a plain UTF-8 read produces "U b u n t u" style noise).
fn wsl_distros(wsl_exe: &str) -> Vec<String> {
    // `proc::silent` (not a bare `Command::new`): listing distributions is an
    // inventory probe like every other subprocess here, and a bare command
    // flashed a console window under the windowless release build. Bounded for
    // the same reason as the other probes — first `wsl -l -q` can be slow, so
    // the deadline is the shared probe budget, not a tight one.
    let mut cmd = crate::proc::silent(wsl_exe);
    cmd.args(["-l", "-q"]);
    let raw = match crate::proc::output_timeout(&mut cmd, crate::proc::PROBE_TIMEOUT) {
        Ok(Some(o)) if o.status.success() => o.stdout,
        _ => return Vec::new(),
    };
    let text = if looks_utf16le(&raw) {
        let utf16: Vec<u16> = raw
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&utf16)
    } else {
        String::from_utf8_lossy(&raw).to_string()
    };
    let mut distros: Vec<String> = text
        .lines()
        .map(|l| l.trim().trim_matches('\u{0}').to_string())
        .filter(|l| !l.is_empty())
        .collect();
    distros.sort();
    distros.dedup();
    distros
}

/// Minimal `dir/pattern` matcher. Avoids a glob crate dependency for what is
/// really just a wildcard directory scan. Shared with `idescan`, whose
/// candidate install paths are all of the shape `<product>*\bin\<exe>.exe`.
pub(crate) fn glob_simple(base: &std::path::Path, pattern: &str) -> Vec<String> {
    let mut hits = Vec::new();
    let mut current = vec![base.to_path_buf()];
    let parts: Vec<&str> = pattern.split('/').collect();
    for (i, part) in parts.iter().enumerate() {
        let last = i == parts.len() - 1;
        let mut next = Vec::new();
        for dir in current {
            if part.contains('*') {
                if let Ok(rd) = dir.read_dir() {
                    for entry in rd.flatten() {
                        let name = entry.file_name().to_string_lossy().to_string();
                        if wildcard_match(&name.to_lowercase(), &part.to_lowercase()) {
                            let p = dir.join(&name);
                            if last {
                                if p.is_file() {
                                    hits.push(p.to_string_lossy().to_string());
                                }
                            } else if p.is_dir() {
                                next.push(p);
                            }
                        }
                    }
                }
            } else {
                let p = dir.join(part);
                if last {
                    if p.is_file() {
                        hits.push(p.to_string_lossy().to_string());
                    }
                } else if p.is_dir() {
                    next.push(p);
                }
            }
        }
        current = next;
    }
    hits
}

/// `*` wildcard match, case-insensitive by caller contract.
///
/// The old loop required **every** segment to match at offset 0 of the remainder,
/// so `a*b` could not match `aXXb` and `*x86*` only matched names *beginning* with
/// `x86` — silently hiding the terminals/IDEs whose path or name has the tag in the
/// middle. The rule here is the one everyone expects from a glob: the first segment
/// anchors at the start, the last anchors at the end, middle segments must appear in
/// order, and a pattern without `*` is an exact comparison.
fn wildcard_match(name: &str, pattern: &str) -> bool {
    if !pattern.contains('*') {
        return name == pattern;
    }
    let mut segments = pattern.split('*').collect::<Vec<_>>().into_iter();
    let mut rest = name;
    // `split('*')` on a pattern starting with `*` yields an empty first segment,
    // which is exactly "no anchor at the start".
    if let Some(first) = segments.next() {
        if !first.is_empty() {
            if !rest.starts_with(first) {
                return false;
            }
            rest = &rest[first.len()..];
        }
    }
    let tail: Vec<&str> = segments.collect();
    let (middles, last) = match tail.split_last() {
        Some((last, middles)) => (middles, *last),
        None => (&[][..], ""),
    };
    for middle in middles {
        if middle.is_empty() {
            continue; // `**` is `*`
        }
        match rest.find(middle) {
            Some(at) => rest = &rest[at + middle.len()..],
            None => return false,
        }
    }
    last.is_empty() || rest.ends_with(last)
}

/// Renders a PowerShell single-quoted string literal.
///
/// Inside `'…'` PowerShell takes everything literally except a doubled quote, so
/// `''` is the whole escaping rule. The value being quoted is a directory name the
/// app does not control: 本地仓库与手工克隆的目录里出现 `it's` 完全正常，而未转义时
/// 那个单引号会提前闭合字符串，剩下的内容就成了用户从未确认过、却被 powershell/pwsh
/// 当作语句执行的文本 —— 确认门槛（`user_confirmed`）保护的是命令，不是标题。
fn ps_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// Opens a terminal of the chosen kind at the repo root, with the command
/// pre-typed (or just parked in the directory when the command is empty).
pub fn launch_terminal_with(
    root: &Path,
    cfg: &LaunchConfig,
    env: &LaunchEnv,
    kind: &str,
) -> Result<LaunchStarted, String> {
    let cwd = resolve_cwd(root, cfg);
    let title = format!(
        "DevHub - {}",
        root.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default()
    );
    let command = cfg.command.trim().to_string();

    let (program, args): (String, Vec<String>) = if kind == "cmd" {
        let mut a = vec!["/K".to_string()];
        if !command.is_empty() {
            a.push(command.clone());
        }
        ("cmd".to_string(), a)
    } else if kind == "powershell" {
        let mut a = vec!["-NoExit".to_string(), "-Command".to_string()];
        let inner = if command.is_empty() {
            format!("$host.UI.RawUI.WindowTitle={}", ps_literal(&title))
        } else {
            format!(
                "$host.UI.RawUI.WindowTitle={}; {command}",
                ps_literal(&title)
            )
        };
        a.push(inner);
        ("powershell".to_string(), a)
    } else if kind == "pwsh" || kind.is_empty() {
        let mut a = vec!["-NoExit".to_string(), "-Command".to_string()];
        let inner = if command.is_empty() {
            format!("$host.UI.RawUI.WindowTitle={}", ps_literal(&title))
        } else {
            format!(
                "$host.UI.RawUI.WindowTitle={}; {command}",
                ps_literal(&title)
            )
        };
        a.push(inner);
        ("pwsh".to_string(), a)
    } else if let Some(distro) = kind.strip_prefix("wsl:") {
        // The Windows cwd is translated by wsl.exe automatically; the venv env
        // vars are Windows-specific and are not forwarded into the distro.
        (
            "wsl".to_string(),
            vec!["-d".to_string(), distro.to_string()],
        )
    } else {
        return Err(format!("未知的终端类型: {kind}"));
    };

    let mut cmd = crate::proc::new_console(&program);
    cmd.args(&args).current_dir(&cwd);
    if kind != "cmd" || command.is_empty() {
        // For cmd, current_dir is enough; the /K command follows it anyway.
    }
    apply_env(&mut cmd, env);

    let child = cmd
        .spawn()
        .map_err(|e| format!("无法打开终端 ({program}): {e}"))?;
    Ok(LaunchStarted {
        pid: child.id(),
        command: if command.is_empty() {
            program
        } else {
            format!("{program} … {command}")
        },
        cwd: cwd.to_string_lossy().to_string(),
    })
}

/// Opens the repository in the chosen IDE by spawning its detected executable.
pub fn launch_ide_with(root: &Path, tool: &ToolInfo) -> Result<LaunchStarted, String> {
    let exe = tool
        .path
        .clone()
        .ok_or_else(|| format!("{} 缺少可执行路径", tool.label))?;
    let child = crate::proc::silent(&exe)
        .arg(root)
        .spawn()
        .map_err(|e| format!("无法启动 {}: {e}", tool.label))?;
    Ok(LaunchStarted {
        pid: child.id(),
        command: format!("{} {}", tool.label, root.display()),
        cwd: root.to_string_lossy().to_string(),
    })
}

// ---------------------------------------------------------------------------
// Cache clearing and removal
// ---------------------------------------------------------------------------

/// Names that are safe to delete for a "clear cache" action.
///
/// Scope decision: this clears the **repository's own** dependency and build
/// artefacts. It deliberately does not touch third-party software caches (for
/// example an accelerator's HTTP cache), because their locations are not
/// something this project can verify, and deleting another application's data
/// would be overreach.
pub(crate) const CACHE_NAMES: &[&str] = &[
    "node_modules",
    "target",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".gradle",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    ".turbo",
    ".parcel-cache",
];

/// Directories inside a repo that are never treated as cache: the repository
/// itself, or a directory that holds user work.
const PROTECTED: &[&str] = &[".git", ".github", "venv", ".venv"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheItem {
    /// Path relative to the repository root.
    pub rel: String,
    pub bytes: u64,
    /// What kind of artefact this is, for display.
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearReport {
    pub items: Vec<CacheItem>,
    pub total_bytes: u64,
    /// Set after an actual clear so the UI can report what was freed.
    #[serde(default)]
    pub freed_bytes: u64,
    #[serde(default)]
    pub removed: Vec<String>,
    #[serde(default)]
    pub failed: Vec<String>,
}

pub(crate) fn dir_size(path: &Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![path.to_path_buf()];
    while let Some(d) = stack.pop() {
        let entries = match std::fs::read_dir(&d) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for e in entries.flatten() {
            let p = e.path();
            // Windows junctions report as directories; following one can count
            // another tree or cycle. The same guard is used by the wall's scan.
            if crate::disk::is_reparse_point(&p) {
                continue;
            }
            match e.file_type() {
                Ok(t) if t.is_dir() => stack.push(p),
                Ok(t) if t.is_file() => {
                    if let Ok(m) = std::fs::metadata(&p) {
                        total += m.len();
                    }
                }
                _ => {}
            }
        }
    }
    total
}

fn label_for(name: &str) -> &'static str {
    match name {
        "node_modules" => "Node 依赖",
        "target" => "Rust 构建产物",
        "__pycache__" => "Python 字节码",
        ".pytest_cache" => "pytest 缓存",
        ".mypy_cache" => "mypy 缓存",
        ".ruff_cache" => "ruff 缓存",
        ".gradle" => "Gradle 缓存",
        "dist" | "build" | "out" => "构建输出",
        ".next" | ".nuxt" => "框架构建缓存",
        ".turbo" | ".parcel-cache" => "构建缓存",
        _ => "缓存",
    }
}

/// Finds removable artefacts. Walks at most three levels so this stays fast on
/// large monorepos.
pub fn scan_cache(root: &Path) -> ClearReport {
    const MAX_DEPTH: usize = 3;
    let mut items: Vec<CacheItem> = Vec::new();

    fn walk(dir: &Path, root: &Path, depth: usize, items: &mut Vec<CacheItem>) {
        if depth > MAX_DEPTH {
            return;
        }
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return,
        };
        for e in entries.flatten() {
            let p = e.path();
            if !p.is_dir() {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            // Never descend into repo metadata, or into a nested repository.
            if PROTECTED.contains(&name.as_str()) || p.join(".git").exists() {
                continue;
            }
            if CACHE_NAMES.contains(&name.as_str()) {
                let rel = p
                    .strip_prefix(root)
                    .map(|r| r.to_string_lossy().replace('\\', "/"))
                    .unwrap_or_else(|_| name.clone());
                items.push(CacheItem {
                    rel,
                    bytes: dir_size(&p),
                    label: label_for(&name).to_string(),
                });
                // Do not descend into a directory that will be deleted whole.
                continue;
            }
            walk(&p, root, depth + 1, items);
        }
    }

    walk(root, root, 0, &mut items);
    items.sort_by_key(|i| std::cmp::Reverse(i.bytes));
    let total_bytes = items.iter().map(|i| i.bytes).sum();
    ClearReport {
        items,
        total_bytes,
        freed_bytes: 0,
        removed: Vec::new(),
        failed: Vec::new(),
    }
}

/// Whether any clearable artefact exists, without measuring any of them.
///
/// The 项目墙's 是否缓存 label (round 9, 需求 1) asks a yes/no question about
/// exactly the set [`scan_cache`] measures. Answering it with a second, simpler
/// walk would let the two drift - a card calling a repository clean while
/// 清理 lists three directories in it - so this shares the constants and the
/// descent rules and only stops at the first hit.
pub fn has_cache(root: &Path) -> bool {
    const MAX_DEPTH: usize = 3;

    fn walk(dir: &Path, depth: usize) -> bool {
        if depth > MAX_DEPTH {
            return false;
        }
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => return false,
        };
        for e in entries.flatten() {
            let p = e.path();
            if !p.is_dir() {
                continue;
            }
            if crate::disk::is_reparse_point(&p) {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            if PROTECTED.contains(&name.as_str()) || p.join(".git").exists() {
                continue;
            }
            if CACHE_NAMES.contains(&name.as_str()) {
                return true;
            }
            if walk(&p, depth + 1) {
                return true;
            }
        }
        false
    }

    walk(root, 0)
}

/// Deletes exactly the artefacts produced by a previous scan.
///
/// The caller is expected to have shown that list to the user; this function
/// only performs the removal and measures the result.
pub fn clear_cache(root: &Path, rels: &[String]) -> ClearReport {
    let root_canon = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let mut freed = 0u64;
    let mut removed = Vec::new();
    let mut failed = Vec::new();

    for rel in rels {
        let candidate = root.join(rel);
        // Guard against a crafted relative path escaping the repository.
        let normalized = match std::fs::canonicalize(&candidate) {
            Ok(p) => p,
            Err(e) => {
                failed.push(format!("{rel}: {e}"));
                continue;
            }
        };
        if !normalized.starts_with(&root_canon) {
            failed.push(format!("{rel}: 拒绝删除仓库之外的路径"));
            continue;
        }
        let size = dir_size(&candidate);
        match std::fs::remove_dir_all(&candidate) {
            Ok(_) => {
                freed += size;
                removed.push(rel.clone());
            }
            Err(e) => failed.push(format!("{rel}: {e}")),
        }
    }

    ClearReport {
        items: Vec::new(),
        total_bytes: freed,
        freed_bytes: freed,
        removed,
        failed,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteReport {
    pub removed_repo: bool,
    pub removed_venv: bool,
    pub freed_bytes: u64,
    pub failed: Vec<String>,
}

/// Moves a repository, its venv and its worktree copies to the Recycle Bin.
///
/// The mirror of [`delete_repo`], with the difference that is the whole point:
/// nothing is destroyed, and a location that cannot host a bin - a network share,
/// a removable drive, an item over the bin quota - is reported as a **failure**
/// rather than quietly downgraded to a hard delete. The user's third menu item
/// (永久删除) is the one that destroys, and it is a separate action.
pub fn trash_repo(root: &Path, slug: &str, repo: &Path, venv: Option<&Path>) -> DeleteReport {
    let mut freed = 0u64;
    let mut failed: Vec<String> = Vec::new();

    let mut send = |path: &Path, label: &str| {
        let bytes = dir_size(path);
        match trash::delete(path) {
            Ok(_) => freed += bytes,
            Err(e) => failed.push(format!("{label}: {e}")),
        }
    };

    if repo.exists() {
        send(repo, "仓库目录");
    }
    let removed_repo = !repo.exists();

    let mut removed_venv = false;
    if let Some(v) = venv {
        if v.exists() {
            send(v, "venv");
            removed_venv = !v.exists();
        }
    }

    // Worktree copies go to the bin too, so a "deleted" project does not leave a
    // second copy of itself behind under `_worktrees`. The set comes from
    // `gitwt::worktree_copies_on_disk` — the same function the 工作树 panel lists
    // and deletes through, so 删除项目 and the panel are looking at one set of
    // directories rather than two guesses at a naming rule (round 16, N1-3).
    for wt in crate::gitwt::worktree_copies_on_disk(root, slug) {
        send(&wt, "工作树副本");
    }

    DeleteReport {
        removed_repo,
        removed_venv,
        freed_bytes: freed,
        failed,
    }
}

/// Puts back everything the Recycle Bin holds for these original paths.
///
/// `trash` exposes the bin's own item list with each entry's original path, so an
/// in-app 回退 of a recycle-bin delete is real rather than a message telling the
/// user to go do it. Paths that are not in the bin are reported, not guessed at:
/// the likely reasons are that the bin was emptied or the item was already
/// restored, and both deserve to be said plainly.
pub fn restore_from_bin(paths: &[&Path]) -> Result<(Vec<String>, Vec<String>), String> {
    let items = trash::os_limited::list().map_err(|e| format!("读取回收站失败: {e}"))?;
    let mut restored = Vec::new();
    let mut missing = Vec::new();

    for path in paths {
        let wanted = path.to_string_lossy().to_string();
        let mine: Vec<_> = items
            .clone()
            .into_iter()
            .filter(|i| {
                i.original_path()
                    .to_string_lossy()
                    .eq_ignore_ascii_case(&wanted)
            })
            .collect();
        if mine.is_empty() {
            missing.push(wanted);
            continue;
        }
        trash::os_limited::restore_all(mine)
            .map_err(|e| format!("还原 {wanted} 失败: {e}"))?;
        restored.push(wanted);
    }

    Ok((restored, missing))
}

/// Fully removes a repository: its directory, its venv (which lives outside the
/// repo and would otherwise be orphaned) and its worktree copies.
///
/// The caller must confirm with the user first. This is irreversible.
pub fn delete_repo(root: &Path, slug: &str, repo: &Path, venv: Option<&Path>) -> DeleteReport {
    let mut freed = 0u64;
    let mut failed = Vec::new();

    if repo.exists() {
        freed += dir_size(repo);
        if let Err(e) = std::fs::remove_dir_all(repo) {
            failed.push(format!("仓库目录: {e}"));
        }
    }
    let removed_repo = !repo.exists();

    let mut removed_venv = false;
    if let Some(v) = venv {
        if v.exists() {
            freed += dir_size(v);
            match std::fs::remove_dir_all(v) {
                Ok(_) => removed_venv = true,
                Err(e) => failed.push(format!("venv: {e}")),
            }
        }
    }

    // Remove an emptied owner directory, but never the code root itself.
    if let Some(owner_dir) = repo.parent() {
        if owner_dir.starts_with(root) && owner_dir != root {
            let empty = std::fs::read_dir(owner_dir)
                .map(|mut d| d.next().is_none())
                .unwrap_or(false);
            if empty {
                let _ = std::fs::remove_dir(owner_dir);
            }
        }
    }

    // Any leftover worktree copy for this slug — both the current location and the
    // legacy `code/_worktrees` one, from the single placement rule in
    // `gitwt::worktree_copies_on_disk` that `trash_repo` above and the 工作树 panel
    // share (round 16, N1-3).
    for wt in crate::gitwt::worktree_copies_on_disk(root, slug) {
        let _ = std::fs::remove_dir_all(&wt);
    }

    DeleteReport {
        removed_repo,
        removed_venv,
        freed_bytes: freed,
        failed,
    }
}

/// What [`remove_venv_dir`] should do with the directory, and therefore what the
/// page is offering the user.
///
/// `ForgetRecord` exists because a marker can point at a directory that is no
/// longer an environment — moved, half-deleted, or made by another tool in a
/// place this app never writes. In that state `venv_for` reports "no venv", the
/// panel says so, and there was no way to make the record agree with the disk
/// except by hand-editing `.devhub.json`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum VenvRemoval {
    /// Move the environment directory to the Windows Recycle Bin.
    ToBin,
    /// Destroy it. The page gates this behind a typed confirmation.
    Destroy,
    /// Drop the pointer from the marker, leave every directory alone.
    ForgetRecord,
}

/// What the disk says about one repository's environment.
///
/// `venv_path` alone was never an answer to that question — it is what the marker
/// was last *told*. `venv_for` filters on `looks_like_venv` for the launch path, so
/// a half-built or moved-away environment resolves to "no venv" while 项目设置 still
/// rendered 「已记录：<路径>」, and the two surfaces disagreed with no way for the user
/// to tell which one was stale. This is the one classification both sides read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum VenvState {
    /// Recorded, and that directory is an environment.
    Ready,
    /// Recorded, but the directory is gone.
    Missing,
    /// Recorded, but the directory is not an environment any more.
    NotAVenv,
    /// Nothing recorded, yet the expected directory is a real environment.
    Unrecorded,
    /// Nothing recorded, and the expected directory exists but is not an
    /// environment — the state where `create_venv` refuses to overwrite it.
    StaleDir,
    /// Neither recorded nor present.
    Nothing,
}

/// Classifies a repository's environment from the two paths that matter.
///
/// Kept free of `Marker` and of `project_root()` so it can be tested without the
/// global container: the interesting cases are all "the marker and the disk
/// disagree", and that is a pure function's business.
pub fn classify_venv(recorded: Option<&Path>, expected: Option<&Path>) -> VenvState {
    if let Some(p) = recorded {
        if !p.exists() {
            return VenvState::Missing;
        }
        return if crate::downloader::looks_like_venv(p) {
            VenvState::Ready
        } else {
            VenvState::NotAVenv
        };
    }
    match expected {
        Some(dir) if dir.is_dir() => {
            if crate::downloader::looks_like_venv(dir) {
                VenvState::Unrecorded
            } else {
                VenvState::StaleDir
            }
        }
        _ => VenvState::Nothing,
    }
}

/// What a venv-only removal did.
///
/// Not [`DeleteReport`]: that struct's central fact is `removed_repo`, and a caller
/// reading `failed.is_empty()` on a type named after the wrong object is how a
/// half-finished clean-up gets reported to the user as a finished one.
#[derive(Debug, Clone, serde::Serialize)]
pub struct VenvReport {
    /// Whether there was a directory to remove at all. `false` with an empty
    /// `failed` is the *record pointed at nothing* case, not an error.
    pub had_venv: bool,
    pub removed_venv: bool,
    /// The record was cleared even though no directory was deleted — which
    /// happens whenever `venv_path` pointed outside `<root>\venvs`, i.e. at
    /// somebody else's directory.
    pub record_only: bool,
    pub freed_bytes: u64,
    /// The directory went to the Recycle Bin rather than being destroyed.
    pub to_bin: bool,
    /// Where what was removed lived, for the activity record.
    pub path: Option<String>,
    pub failed: Vec<String>,
}

/// Is this directory one of ours to delete?
///
/// [`crate::path_guard::check_delete_target`] cannot serve a venv: it refuses
/// anything under a reserved container directory, and `venvs` is exactly one of
/// those (`RESERVED_ROOT_DIRS`). The rule a venv needs is the mirror image — it
/// must be inside `<root>\venvs` and *immediately* inside it. The depth test is
/// not ceremony: `<root>\venvs` itself holds every environment on the wall, so an
/// off-by-one here is unrecoverable, and both layouts `venv_dir_for` can return
/// (`venvs\<repo>` and the legacy `venvs\<host>_<owner>_<repo>`) are one level deep.
pub fn check_venv_target(root: &Path, candidate: &Path) -> Result<std::path::PathBuf, String> {
    let venvs = root.join("venvs");
    if candidate.as_os_str().is_empty() {
        return Err("这条记录没有记下虚拟环境位置".to_string());
    }
    let canon = candidate.canonicalize().map_err(|_| {
        format!(
            "虚拟环境目录 {} 已不存在",
            crate::netpath::strip_verbatim(candidate).display()
        )
    })?;
    let venvs_canon = venvs.canonicalize().map_err(|_| {
        format!(
            "项目根 {} 下没有 venvs 目录，这条记录指向的环境不归本应用管",
            root.display()
        )
    })?;
    if canon == venvs_canon {
        return Err(format!(
            "拒绝删除：{} 是所有虚拟环境的容器本身，不是某一个环境",
            venvs_canon.display()
        ));
    }
    let rel = canon.strip_prefix(&venvs_canon).map_err(|_| {
        format!(
            "{} 不在 {} 里面，本命令只删除由本应用创建的环境；要放弃这个记录请在项目设置里清除虚拟环境字段",
            crate::netpath::strip_verbatim(&canon).display(),
            venvs_canon.display()
        )
    })?;
    if rel.components().count() != 1 {
        return Err(format!(
            "拒绝删除：{} 不是 {} 的直接子目录，本应用只创建一层深的环境目录",
            crate::netpath::strip_verbatim(&canon).display(),
            venvs_canon.display()
        ));
    }
    Ok(canon)
}

/// Deletes one environment directory, to the Recycle Bin or for good.
///
/// The bin path reports a refusal as a **failure** rather than downgrading to a
/// hard delete, for the same reason [`trash_repo`] does: a location that cannot
/// host a bin (network share, over quota) is not permission to destroy data.
pub fn remove_venv_dir(target: &Path, to_bin: bool) -> VenvReport {
    let mut failed = Vec::new();
    let existed = target.exists();
    let freed = if existed { dir_size(target) } else { 0 };
    let mut removed = false;
    if existed {
        let outcome: Result<(), String> = if to_bin {
            trash::delete(target).map_err(|e| e.to_string())
        } else {
            std::fs::remove_dir_all(target).map_err(|e| e.to_string())
        };
        match outcome {
            Ok(_) => removed = !target.exists(),
            Err(e) => failed.push(format!("虚拟环境目录: {e}")),
        }
    }
    VenvReport {
        had_venv: existed,
        removed_venv: removed,
        record_only: false,
        freed_bytes: if removed { freed } else { 0 },
        to_bin,
        path: Some(crate::netpath::strip_verbatim(target).to_string_lossy().to_string()),
        failed,
    }
}

/// Clears the environment fields from one repository's marker.
///
/// `python_version` is only dropped when it describes the venv. Since round 15
/// made the field real, it carries two different facts: the version of the venv's
/// interpreter (written by `create_repo_venv`) and the version of a *pinned*
/// interpreter (written by `set_python_choice`). Deleting an environment must not
/// silently undo a version pin the user set on purpose — that is the one case
/// where blindly clearing both fields, as the round-16 matrix worded it, would
/// destroy a user's decision.
pub fn clear_venv_record(
    marker: &mut crate::downloader::Marker,
    had_pin: bool,
) -> bool {
    let had_record = marker.venv_path.is_some();
    marker.venv_path = None;
    if !had_pin {
        marker.python_version = None;
    }
    had_record
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `check_venv_target` is the only thing standing between a mistyped record and
    /// `remove_dir_all`, so each refusal is its own test rather than one big assert.
    #[test]
    fn a_venv_may_only_be_deleted_one_level_below_the_venvs_directory() {
        let root = std::env::temp_dir().join(format!(
            "devhub-venv-guard-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let venvs = root.join("venvs");
        std::fs::create_dir_all(venvs.join("repo_owner")).unwrap();
        std::fs::create_dir_all(venvs.join("nested").join("deeper")).unwrap();

        let one = venvs.join("repo_owner");
        assert!(check_venv_target(&root, &one).is_ok(), "current layout");
        assert!(
            check_venv_target(&root, &venvs.join("nested").join("deeper")).is_err(),
            "two levels deep is not something this app created"
        );
        assert!(
            check_venv_target(&root, &venvs).is_err(),
            "the container itself must never be a target"
        );
        assert!(check_venv_target(&root, &root).is_err(), "the root itself");
        assert!(
            check_venv_target(&root, std::path::Path::new("")).is_err(),
            "an empty record"
        );
        assert!(
            check_venv_target(&root, &venvs.join("not-there")).is_err(),
            "a directory already deleted by hand"
        );
        // Somebody else's environment: outside `venvs`, even though it looks fine.
        assert!(check_venv_target(&root, &root.join("elsewhere")).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn removing_an_absent_venv_is_a_no_op_rather_than_a_failure() {
        let root = std::env::temp_dir().join(format!(
            "devhub-venv-absent-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let report = remove_venv_dir(&root.join("nothing"), false);
        assert!(!report.had_venv);
        assert!(!report.removed_venv);
        assert!(
            report.failed.is_empty(),
            "nothing there is not an error: {:?}",
            report.failed
        );
        assert_eq!(report.freed_bytes, 0);
    }

    #[test]
    fn a_hard_really_removes_and_reports_the_bytes_it_freed() {
        let root = std::env::temp_dir().join(format!(
            "devhub-venv-remove-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let venv = root.join("venvs").join("repo_owner");
        std::fs::create_dir_all(venv.join("Lib")).unwrap();
        std::fs::write(venv.join("pyvenv.cfg"), "home = C:\\Python312\n").unwrap();
        std::fs::write(venv.join("Lib").join("sitecustomize.py"), "x".repeat(4096)).unwrap();

        let target = check_venv_target(&root, &venv).expect("contained");
        let report = remove_venv_dir(&target, false);
        assert!(report.had_venv && report.removed_venv, "{report:?}");
        assert!(report.failed.is_empty(), "{:?}", report.failed);
        assert!(
            report.freed_bytes >= 4096,
            "freed {} bytes",
            report.freed_bytes
        );
        assert!(!venv.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The panel and the launch path must read the same truth. Every one of these
    /// six states is a different sentence in 项目设置, and before this function
    /// existed the panel could only ever say 「已记录：<路径>」.
    #[test]
    fn the_environment_is_classified_from_the_disk_rather_than_from_the_marker() {
        let root = std::env::temp_dir().join(format!(
            "devhub-venv-classify-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let mk = |name: &str, shaped: bool| {
            let d = root.join(name);
            std::fs::create_dir_all(&d).unwrap();
            if shaped {
                std::fs::write(d.join("pyvenv.cfg"), "home = x\n").unwrap();
            }
            d
        };
        let good = mk("good", true);
        let junk = mk("junk", false);
        let gone = root.join("gone");

        assert_eq!(classify_venv(Some(&good), None), VenvState::Ready);
        assert_eq!(classify_venv(Some(&junk), None), VenvState::NotAVenv);
        assert_eq!(classify_venv(Some(&gone), None), VenvState::Missing);
        // Nothing recorded: a real environment nobody pointed at, and the leftover
        // directory that makes `create_venv` refuse to run, are different problems
        // and get different buttons.
        assert_eq!(classify_venv(None, Some(&good)), VenvState::Unrecorded);
        assert_eq!(classify_venv(None, Some(&junk)), VenvState::StaleDir);
        assert_eq!(classify_venv(None, Some(&gone)), VenvState::Nothing);
        assert_eq!(classify_venv(None, None), VenvState::Nothing);
        // A recorded path wins the conversation even when the expected directory is
        // also there — that is the legacy `venvs\<host>_<owner>_<repo>` layout.
        assert_eq!(
            classify_venv(Some(&good), Some(&junk)),
            VenvState::Ready,
            "the record is what launch actually uses"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The point of splitting the record from the directory: a `venv_path` that
    /// points somewhere the app did not create must be forgivable without being
    /// destructive.
    #[test]
    fn clearing_the_record_keeps_a_version_pin_the_user_set_on_purpose() {
        let mut m = crate::downloader::Marker {
            venv_path: Some(r"D:\someone-elses\env".to_string()),
            python_version: Some("3.12".to_string()),
            python_choice: None,
            ..Default::default()
        };
        assert!(clear_venv_record(&mut m, false));
        assert!(m.venv_path.is_none());
        assert!(m.python_version.is_none(), "no pin, so the version was the venv's");

        let mut pinned = crate::downloader::Marker {
            venv_path: Some(r"C:\work\venvs\repo".to_string()),
            python_version: Some("3.11".to_string()),
            python_choice: Some(r"C:\Python311\python.exe".to_string()),
            ..Default::default()
        };
        assert!(clear_venv_record(&mut pinned, true));
        assert!(pinned.venv_path.is_none());
        assert_eq!(
            pinned.python_version.as_deref(),
            Some("3.11"),
            "the pin's version describes the pinned interpreter, not the deleted venv"
        );
        assert!(!clear_venv_record(&mut pinned, true), "already clear");
    }

    /// 需求 8.5 / §5.2: the dependency step must not write into a system Python.
    #[test]
    fn a_python_install_plan_targets_the_venv_or_says_why_it_cannot() {
        let root = std::env::temp_dir().join(format!(
            "devhub-install-plan-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("fixture");
        std::fs::write(root.join("requirements.txt"), "six==1.16.0
").expect("fixture");
        let venv = root.join("..").join("venvs").join("owner_repo");

        let with = install_plan_for(&root, Some(&venv)).expect("a plan for requirements.txt");
        assert_eq!(with.ecosystem, "python");
        assert!(
            with.command.contains("-m pip install -r requirements.txt"),
            "must go through the environment's own interpreter: {}",
            with.command
        );
        assert!(
            with.command.contains("Scripts") && with.command.starts_with('"'),
            "the interpreter path is quoted and machine-independent: {}",
            with.command
        );
        assert!(with.evidence.contains("虚拟环境"), "{}", with.evidence);

        let without = install_plan_for(&root, None).expect("still a plan");
        assert_eq!(without.command, "pip install -r requirements.txt");
        assert!(
            without.evidence.contains("还没有虚拟环境"),
            "the missing-environment case must be named, not silently offered: {}",
            without.evidence
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// The node branch must be untouched by the venv logic - it has no environment
    /// concept here, and a plan that started caring about one would be a regression
    /// in the most-used path.
    #[test]
    fn a_node_install_plan_ignores_the_venv_argument() {
        let root = std::env::temp_dir().join(format!(
            "devhub-install-plan-node-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("fixture");
        std::fs::write(root.join("package.json"), "{}").expect("fixture");
        std::fs::write(root.join("pnpm-lock.yaml"), "").expect("fixture");
        let plan = install_plan_for(&root, Some(&root.join("venv")))
            .expect("a plan for package.json");
        assert_eq!(plan.ecosystem, "node");
        assert_eq!(plan.tool_name, "pnpm");
        assert_eq!(plan.command, "pnpm install");
        let _ = std::fs::remove_dir_all(&root);
    }
    use std::fs;

    /// The old shape executed whatever string the page sent. Only a python-named,
    /// existing *file* is allowed now, and nothing is run to find that out.
    #[test]
    fn validate_interpreter_rejects_anything_that_is_not_python() {
        assert!(validate_interpreter("").is_err(), "empty");
        assert!(validate_interpreter("   ").is_err(), "whitespace");
        let err = validate_interpreter("calc.exe").unwrap_err();
        assert!(err.contains("只能执行 python 解释器"), "got {err}");
        let err = validate_interpreter(r"C:\Windows\System32\cmd.exe").unwrap_err();
        assert!(err.contains("cmd"), "the name is echoed back: {err}");
        // Right name, no such file — still refused, and no process is spawned.
        let err = validate_interpreter(r"D:\nope\python.exe").unwrap_err();
        assert!(err.contains("找不到解释器"), "got {err}");
        // A directory named `python.exe` is not a file.
        let dir = std::env::temp_dir().join("devhub-validate-py");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("python.exe")).unwrap();
        let err = validate_interpreter(dir.join("python.exe").to_str().unwrap()).unwrap_err();
        assert!(err.contains("不是文件"), "got {err}");
        // A real file with the right name passes without being executed.
        let _ = std::fs::create_dir_all(dir.join("real"));
        std::fs::write(dir.join("real").join("python.exe"), b"not really python").unwrap();
        let ok = validate_interpreter(dir.join("real").join("python.exe").to_str().unwrap());
        assert!(ok.is_ok(), "an existing python.exe must be accepted: {ok:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }


    /// The terminal title is a directory name, and directory names are not ours to
    /// constrain. Before this test existed the name was interpolated raw into a
    /// PowerShell single-quoted string, so `it's` closed the quote early and whatever
    /// followed became a statement the user never confirmed.
    /// The bug: the old matcher anchored every segment at offset 0, so `*x86*` only
    /// matched names *starting* with `x86` and `a*b` could not match `aXXb`. These
    /// patterns drive terminal/IDE discovery (`launch.rs:1106`), where the tag is
    /// almost never at the start of the path.
    #[test]
    fn wildcard_match_anchors_only_the_first_and_last_segment() {
        assert!(wildcard_match("aXXb", "a*b"));
        assert!(wildcard_match("ab", "a*b"));
        assert!(wildcard_match(
            "C:\\Program Files (x86)\\foo\\terminal.exe",
            "*x86*"
        ));
        assert!(wildcard_match("x86", "*x86*"));
        assert!(!wildcard_match("arm64", "*x86*"));
        assert!(!wildcard_match("x86 and more", "*x86")); // last segment anchors the end
        assert!(wildcard_match("cmd", "cmd"));
        assert!(!wildcard_match("cmdx", "cmd"));
        assert!(wildcard_match("anything", "*"));
        assert!(wildcard_match("", "*"));
        assert!(!wildcard_match("x", ""));
        assert!(wildcard_match("x", "**")); // `**` behaves like `*`
        assert!(wildcard_match(r"C:\a\b.exe", r"*.exe"));
        assert!(!wildcard_match(r"C:\a\b.txt", r"*.exe"));
    }

    #[test]
    fn ps_literal_survives_the_characters_that_break_a_quoted_title() {
        assert_eq!(ps_literal("DevHub - plain"), "'DevHub - plain'");
        assert_eq!(ps_literal("it's"), "'it''s'");
        // `;`, `$` and backtick are only dangerous OUTSIDE a quoted literal; the
        // assertion that matters is that the quote itself cannot terminate early.
        let hostile = "x'; Set-Location C:\\; \"$(Get-Host)\"`";
        let rendered = ps_literal(hostile);
        assert!(rendered.starts_with('\'') && rendered.ends_with('\''));
        assert_eq!(
            rendered.matches('\'').count() - 2,
            hostile.matches('\'').count() * 2,
            "every inner quote is doubled, so the literal cannot be closed early"
        );
        let inner = rendered
            .strip_prefix('\'')
            .and_then(|s| s.strip_suffix('\''))
            .expect("wrapped in single quotes");
        assert!(
            inner.replace("''", "").find('\'').is_none(),
            "no lone quote survives inside the literal, so it cannot be closed early"
        );
    }

    fn tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("devhub-detect-{name}"));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn node_project_prefers_dev_script_and_offers_install_variant() {
        let d = tmp("node");
        fs::write(
            d.join("package.json"),
            r#"{"name":"x","scripts":{"build":"vite build","dev":"vite","test":"vitest"}}"#,
        )
        .unwrap();
        let r = detect_launch(&d);
        assert_eq!(r.project_type.as_deref(), Some("node"));
        let first = &r.candidates[0];
        assert_eq!(first.command, "npm run dev", "dev should rank first");
        assert!(
            first.evidence.contains("scripts.dev"),
            "evidence must cite the script"
        );
        assert!(
            r.candidates
                .iter()
                .any(|c| c.command == "npm install && npm run dev"),
            "an install-then-run variant should be offered"
        );
        // build must not outrank dev
        let dev_pos = r
            .candidates
            .iter()
            .position(|c| c.command == "npm run dev")
            .unwrap();
        let build_pos = r
            .candidates
            .iter()
            .position(|c| c.command == "npm run build")
            .unwrap();
        assert!(dev_pos < build_pos);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn pnpm_lock_switches_the_package_manager() {
        let d = tmp("pnpm");
        fs::write(d.join("package.json"), r#"{"scripts":{"dev":"vite"}}"#).unwrap();
        fs::write(d.join("pnpm-lock.yaml"), "").unwrap();
        let r = detect_launch(&d);
        assert!(r.candidates.iter().any(|c| c.command == "pnpm run dev"));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn django_manage_py_is_detected() {
        let d = tmp("django");
        fs::write(d.join("manage.py"), "").unwrap();
        let r = detect_launch(&d);
        assert_eq!(r.project_type.as_deref(), Some("python"));
        assert_eq!(r.candidates[0].command, "python manage.py runserver");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn rust_and_go_are_detected() {
        let d = tmp("rust");
        fs::write(d.join("Cargo.toml"), "[package]\nname=\"x\"\n").unwrap();
        assert_eq!(detect_launch(&d).candidates[0].command, "cargo run");
        let _ = fs::remove_dir_all(&d);

        let d = tmp("go");
        fs::write(d.join("go.mod"), "module x\n").unwrap();
        assert_eq!(detect_launch(&d).candidates[0].command, "go run .");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn readme_fenced_block_yields_a_low_confidence_candidate_with_line_number() {
        let d = tmp("readme");
        fs::write(
            d.join("README.md"),
            "# Title\n\nSome prose.\n\n```bash\nnpm install\nnpm run dev\n```\n\nmore prose\n",
        )
        .unwrap();
        let r = detect_launch(&d);
        let c = r
            .candidates
            .iter()
            .find(|c| c.command == "npm run dev")
            .unwrap();
        assert!(
            c.evidence.contains("第 7 行"),
            "evidence was: {}",
            c.evidence
        );
        // README-derived guesses must rank below manifest-derived ones.
        assert!(c.confidence < 50);
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn makefile_target_detection() {
        let d = tmp("make");
        fs::write(d.join("Makefile"), "all:\n\techo hi\n\nrun:\n\techo run\n").unwrap();
        let r = detect_launch(&d);
        assert!(r.candidates.iter().any(|c| c.command == "make run"));
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn empty_repo_reports_no_candidates_without_claiming_failure() {
        let d = tmp("empty");
        let r = detect_launch(&d);
        assert!(r.candidates.is_empty());
        assert!(r.project_type.is_none());
        assert!(
            r.notes.iter().any(|n| n.contains("不是错误")),
            "a negative result must be described as normal, not as a failure"
        );
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn candidates_are_deduplicated() {
        let d = tmp("dupe");
        fs::write(d.join("package.json"), r#"{"scripts":{"dev":"vite"}}"#).unwrap();
        // Same command appears again in the README.
        fs::write(d.join("README.md"), "```\nnpm run dev\n```\n").unwrap();
        let r = detect_launch(&d);
        let n = r
            .candidates
            .iter()
            .filter(|c| c.command == "npm run dev")
            .count();
        assert_eq!(n, 1, "duplicate commands must collapse");
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn child_env_exports_ports_with_a_prefix() {
        let env = LaunchEnv {
            venv: None,
            // Round 11 (需求 8.5) added the pinned interpreter; a test that predates
            // it says "no interpreter chosen", which is the same as it meant before.
            python_dir: None,
            ports: vec![("http".to_string(), 20000), ("db".to_string(), 20005)],
        };
        let vars = child_env(&env);
        assert!(vars.contains(&("DEVHUB_PORT_HTTP".to_string(), "20000".to_string())));
        assert!(vars.contains(&("DEVHUB_PORT_DB".to_string(), "20005".to_string())));
        assert!(!vars.iter().any(|(k, _)| k == "VIRTUAL_ENV"));
    }

    #[test]
    fn child_env_prepends_the_venv_scripts_dir_and_sets_virtual_env() {
        let venv = std::path::PathBuf::from(r"C:\venvs\owner_repo");
        let env = LaunchEnv {
            venv: Some(venv.clone()),
            // 需求 8.5 added the pinned interpreter; this test is about the venv.
            python_dir: None,
            ports: vec![],
        };
        let vars = child_env(&env);
        let ve = vars
            .iter()
            .find(|(k, _)| k == "VIRTUAL_ENV")
            .expect("VIRTUAL_ENV set");
        assert_eq!(ve.1, venv.to_string_lossy());
        let path = vars.iter().find(|(k, _)| k == "PATH").expect("PATH set");
        assert!(
            path.1
                .starts_with(&venv.join("Scripts").to_string_lossy().to_string()),
            "venv Scripts must come first so `python` resolves inside it: {}",
            path.1
        );
    }

    #[test]
    fn resolve_cwd_falls_back_to_root_when_the_configured_dir_is_missing() {
        let d = std::env::temp_dir().join("devhub-launch-cwd");
        let _ = std::fs::create_dir_all(&d);
        let cfg = LaunchConfig {
            command: "x".into(),
            cwd: "does-not-exist".into(),
            user_confirmed: true,
            kind: None,
            steps: Vec::new(),
        };
        assert_eq!(resolve_cwd(&d, &cfg), d);
        let cfg_root = LaunchConfig {
            cwd: String::new(),
            ..cfg.clone()
        };
        assert_eq!(resolve_cwd(&d, &cfg_root), d);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn launch_config_round_trips_through_json_with_defaults() {
        let raw = r#"{"command":"npm run dev"}"#;
        let cfg: LaunchConfig = serde_json::from_str(raw).unwrap();
        assert_eq!(cfg.command, "npm run dev");
        assert_eq!(cfg.cwd, "");
        assert!(!cfg.user_confirmed);
        assert!(cfg.kind.is_none());
    }

    fn tmpdir(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("devhub-clear-{name}"));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn write_file(p: &std::path::Path, bytes: usize) {
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(p, vec![b'x'; bytes]).unwrap();
    }

    #[test]
    fn scan_finds_artefacts_and_reports_their_size() {
        let d = tmpdir("scan");
        write_file(&d.join("node_modules/pkg/index.js"), 1000);
        write_file(&d.join("target/debug/app.exe"), 500);
        write_file(&d.join("src/main.rs"), 50);
        write_file(&d.join("README.md"), 10);

        let r = scan_cache(&d);
        let rels: Vec<&str> = r.items.iter().map(|i| i.rel.as_str()).collect();
        assert!(rels.contains(&"node_modules"), "got {rels:?}");
        assert!(rels.contains(&"target"), "got {rels:?}");
        assert_eq!(r.total_bytes, 1500, "sum of node_modules + target");
        // Largest first.
        assert_eq!(r.items[0].rel, "node_modules");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn scan_never_reports_git_or_user_sources() {
        let d = tmpdir("protected");
        write_file(&d.join(".git/objects/ab/cdef"), 2000);
        write_file(&d.join("src/lib.rs"), 100);
        let r = scan_cache(&d);
        assert!(r.items.is_empty(), "nothing here is cache: {:?}", r.items);
        assert_eq!(r.total_bytes, 0);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn scan_does_not_descend_into_nested_repositories() {
        let d = tmpdir("nested");
        write_file(&d.join("vendor/other/.git/HEAD"), 10);
        write_file(&d.join("vendor/other/node_modules/x.js"), 9999);
        let r = scan_cache(&d);
        assert!(
            r.items.is_empty(),
            "a nested repo's node_modules must not be touched: {:?}",
            r.items
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn scan_finds_nested_caches_within_depth_limit() {
        let d = tmpdir("deep");
        write_file(&d.join("packages/web/node_modules/x.js"), 700);
        let r = scan_cache(&d);
        assert_eq!(r.items.len(), 1);
        assert_eq!(
            r.items[0].rel,
            "packages/web/node_modules".replace('/', "/")
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn clear_removes_only_what_was_listed_and_preserves_git() {
        let d = tmpdir("clear");
        write_file(&d.join("node_modules/a.js"), 400);
        write_file(&d.join("target/b.bin"), 600);
        write_file(&d.join(".git/HEAD"), 20);
        write_file(&d.join("src/main.rs"), 30);

        let scan = scan_cache(&d);
        let rels: Vec<String> = scan.items.iter().map(|i| i.rel.clone()).collect();
        let report = clear_cache(&d, &rels);

        assert_eq!(report.freed_bytes, 1000);
        assert_eq!(report.failed.len(), 0, "{:?}", report.failed);
        assert!(!d.join("node_modules").exists());
        assert!(!d.join("target").exists());
        // Sources and git metadata survive.
        assert!(d.join(".git/HEAD").exists());
        assert!(d.join("src/main.rs").exists());
        // A rescan finds nothing left.
        assert_eq!(scan_cache(&d).total_bytes, 0);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn clear_refuses_paths_that_escape_the_repository() {
        let d = tmpdir("escape");
        let outside = std::env::temp_dir().join("devhub-clear-outside");
        let _ = std::fs::remove_dir_all(&outside);
        std::fs::create_dir_all(&outside).unwrap();
        write_file(&outside.join("keep.txt"), 10);

        let report = clear_cache(&d, &["../devhub-clear-outside".to_string()]);
        assert!(
            report.failed.iter().any(|f| f.contains("仓库之外")),
            "expected a refusal, got {:?}",
            report.failed
        );
        assert!(
            outside.join("keep.txt").exists(),
            "outside data must survive"
        );

        let _ = std::fs::remove_dir_all(&d);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn delete_repo_removes_repo_venv_and_emptied_owner_dir() {
        let root = tmpdir("delete");
        let repo = root.join("code/github.com/alice/tool");
        let venv = root.join("venvs/github.com_alice_tool");
        write_file(&repo.join(".git/HEAD"), 100);
        write_file(&repo.join("src/a.rs"), 200);
        write_file(&venv.join("Scripts/python.exe"), 3000);

        let report = delete_repo(&root, "github.com/alice/tool", &repo, Some(&venv));
        assert!(report.removed_repo);
        assert!(report.removed_venv);
        assert_eq!(report.freed_bytes, 3300);
        assert!(!repo.exists());
        assert!(!venv.exists(), "an orphaned venv must be cleaned up too");
        // The now-empty owner directory is pruned...
        assert!(!root.join("code/github.com/alice").exists());
        // ...but the code root itself survives.
        assert!(root.join("code").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn delete_repo_tolerates_a_missing_venv() {
        let root = tmpdir("delete2");
        let repo = root.join("code/local/x/demo");
        write_file(&repo.join("a.txt"), 11);
        let report = delete_repo(&root, "local/x/demo", &repo, None);
        assert!(report.removed_repo);
        assert!(!report.removed_venv);
        assert!(report.failed.is_empty(), "{:?}", report.failed);
        let _ = std::fs::remove_dir_all(&root);
    }
}

#[cfg(test)]
mod d8_tests {
    use super::*;

    /// A `py -0p` shape with three installs (`REQUIREMENTS.md` §3.6), including
    /// the `*` default marker and the header line that must not become an
    /// interpreter.
    const PY_LIST: &str = "\
Installed Pythons found by py Launcher for Windows
 -V:3.13-64 *        C:\\Users\\me\\AppData\\Local\\Programs\\Python\\Python313\\python.exe
 -V:3.12-64          C:\\Python312\\python.exe
 -V:3.10-64          C:\\Python311\\python.exe
";

    #[test]
    fn parse_py_list_reads_version_and_path() {
        let list = parse_py_list(PY_LIST);
        assert_eq!(list.len(), 3, "{list:?}");
        assert_eq!(list[0].version, "3.13");
        assert_eq!(
            list[0].id,
            r"C:\Users\me\AppData\Local\Programs\Python\Python313\python.exe"
        );
        assert_eq!(list[1].version, "3.12");
        assert_eq!(list[1].id, r"C:\Python312\python.exe");
        assert_eq!(list[2].version, "3.10");
        assert!(list.iter().all(|p| p.source == "py"));
    }

    #[test]
    fn parse_py_list_ignores_everything_without_an_executable() {
        assert!(parse_py_list("").is_empty());
        assert!(parse_py_list("Installed Pythons found by py Launcher for Windows\n").is_empty());
        // A quoted path (some locales quote) still resolves: `parse_py_list` only
        // trims the quotes off the token, so the expectation has to be the plain
        // path it was given — and the token must still END in `python.exe`, which a
        // trailing slash would break.
        let list = parse_py_list(" -V:3.12-64  \"C:\\Python312\\python.exe\"\n");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, r"C:\Python312\python.exe");
        // Duplicates collapse.
        let dup = format!("{PY_LIST}{PY_LIST}");
        assert_eq!(parse_py_list(&dup).len(), 3);
    }

    /// A directory with no `.git` says so instead of pretending to be a clean
    /// worktree - the delete confirmation would otherwise show "0 个未提交"
    /// for an archive download.
    #[test]
    fn worktree_status_of_a_plain_directory_has_no_git() {
        let root = std::env::temp_dir().join(format!("devhub-wtstat-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let st = worktree_status(&root);
        assert!(!st.has_git);
        assert!(st.branch.is_none());
        assert_eq!(st.dirty, 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The pinned interpreter sits *after* the venv on PATH, and `VIRTUAL_ENV`
    /// is still exported for the venv case.
    #[test]
    fn child_env_puts_the_venv_before_the_pin() {
        // Backslash paths, because that is the shape the app actually stores:
        // `venv_dir_for` builds `<root>\venvs\<repo>_<owner>` and `child_env` appends
        // `Scripts` with `PathBuf::join`. Mixing separator styles here is what made
        // this test fail on a correct implementation.
        let env = LaunchEnv {
            venv: Some(std::path::PathBuf::from(r"D:\app\项目\venvs\alice_tool")),
            python_dir: Some(std::path::PathBuf::from(r"C:\Python312")),
            ports: vec![("http".into(), 20000)],
        };
        let vars = child_env(&env);
        let path = vars
            .iter()
            .find(|(k, _)| k == "PATH")
            .map(|(_, v)| v.clone())
            .expect("PATH must be set");
        let venv_at = path
            .find(r"venvs\alice_tool\Scripts")
            .expect("venv Scripts on PATH");
        let pin_at = path.find(r"C:\Python312").expect("pin on PATH");
        assert!(venv_at < pin_at, "venv must win: {path}");
        assert!(vars.iter().any(|(k, v)| k == "VIRTUAL_ENV"
            && v == r"D:\app\项目\venvs\alice_tool"));
        assert!(vars
            .iter()
            .any(|(k, v)| k == "DEVHUB_PORT_HTTP" && v == "20000"));
    }

    /// Without a venv the pin is the only PATH addition, and `VIRTUAL_ENV`
    /// stays absent - exporting it would lie to the child.
    #[test]
    fn child_env_without_a_venv_exports_no_virtual_env() {
        let env = LaunchEnv {
            venv: None,
            python_dir: Some(std::path::PathBuf::from(r"C:/Python312")),
            ports: Vec::new(),
        };
        let vars = child_env(&env);
        assert!(!vars.iter().any(|(k, _)| k == "VIRTUAL_ENV"));
        assert!(vars.iter().any(|(k, _)| k == "PATH"));
    }

    /// `port_health` answers for every service, and a closed port is `false`
    /// rather than an error.
    #[test]
    fn port_health_reports_every_service() {
        let health = port_health(&[("http".into(), 20000), ("db".into(), 20005)]);
        assert_eq!(health.len(), 2);
        assert_eq!(health[0].service, "http");
        assert_eq!(health[0].port, 20000);
        assert_eq!(health[1].service, "db");
        assert_eq!(health[1].port, 20005);
        // Whether anything listens on a machine-chosen port is not asserted: that is
        // this app's own allocation range, so a real service may be on it. The shape
        // — one row per service, no panic, no dropped entry — is what is pinned here
        // and what `port_health_keeps_service_order_and_sees_an_open_port` adds a
        // known-open port to.
    }

    /// The probes now run concurrently, which buys the answer but risks the order:
    /// the panel renders one row per service in marker order. A bound listener is the
    /// one port this test can promise is open.
    #[test]
    fn port_health_keeps_service_order_and_sees_an_open_port() {
        let open = std::net::TcpListener::bind("127.0.0.1:0").expect("bind an ephemeral port");
        let open_port = open.local_addr().expect("read the port back").port();
        let health = port_health(&[
            ("first".into(), open_port),
            ("second".into(), 20005),
            ("third".into(), open_port),
        ]);
        assert_eq!(
            health
                .iter()
                .map(|h| h.service.as_str())
                .collect::<Vec<_>>(),
            vec!["first", "second", "third"],
            "a concurrent probe must still answer in input order"
        );
        assert!(health[0].listening, "a bound port is listening");
        assert!(health[2].listening, "the same port asked twice gives the same answer");
    }
}

#[cfg(test)]
mod launch_log_tests {
    use super::*;

    #[test]
    fn the_ring_keeps_only_the_newest_lines_and_a_new_sink_clears_the_slug() {
        clear_launch_log("o/r");
        for i in 0..(LAUNCH_LOG_LINES + 5) {
            append_launch_log("o/r", "launch", &format!("line {i}"));
        }
        let lines = launch_logs()
            .as_ref()
            .and_then(|m| m.get("o/r"))
            .map(|l| l.iter().cloned().collect::<Vec<_>>())
            .unwrap();
        assert_eq!(lines.len(), LAUNCH_LOG_LINES);
        assert!(lines[0].contains("line 5"), "oldest five were dropped");
        assert!(lines.last().unwrap().contains("line 504"));

        let seen = std::sync::Arc::new(std::sync::Mutex::new(0usize));
        let seen2 = seen.clone();
        let inner: crate::downloader::ProgressFn = std::sync::Arc::new(move |_, _| {
            *seen2.lock().unwrap() += 1;
        });
        let sink = logging_sink("o/r", inner);
        sink("launch", "fresh run");
        assert!(*seen.lock().unwrap() >= 1, "the wrapped sink still runs");
        let lines = launch_logs()
            .as_ref()
            .and_then(|m| m.get("o/r"))
            .map(|l| l.iter().cloned().collect::<Vec<_>>())
            .unwrap();
        assert_eq!(lines, vec!["[launch] fresh run".to_string()], "a new run starts clean");
        clear_launch_log("o/r");
    }
}
