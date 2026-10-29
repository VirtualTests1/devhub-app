//! Docker / 容器环境检测（N1）。
//!
//! REQUIREMENTS.md §3.6 列出了「每项目独立网络 + 命名卷」作为产品需求，
//! 但标注了 "design verified, not implemented"。本模块是落地的第一步：
//! 检测本机 Docker 是否可用、版本、当前运行的容器列表，以及
//! 能否在指定目录发现 docker-compose.yml / compose.yaml。
//!
//! 全量的「为仓库启动独立容器网络」是后续迭代——当前只做**可见性**：
//! 让用户在设置/项目设置里看到「这台机子有没有 Docker、项目目录有没有 compose 文件」。

use std::path::Path;
use std::process::Command;

/// `rename_all` 是本轮才补的：这个结构体此前没有任何前端消费者（`docker_status`
/// 在 `scripts/check-commands.mjs` 的 allowlist 里挂着「设置页 Docker 诊断面板待实现」），
/// 所以字段名一直是 Rust 侧的 snake_case。设置页面板是它的第一个读者，按仓内惯例
/// （`lib.rs:2319 RepoDetail` 等一律 camelCase）在接线的同一个提交里对齐，
/// 免得 TS 类型从第一天就是 `cli_found` 这种混血写法。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerStatus {
    /// `docker` CLI 是否在 PATH 上。
    pub cli_found: bool,
    /// `docker --version` 的输出（如果可用）。
    pub version: Option<String>,
    /// `docker info` 能不能跑通（等价于 daemon 是否在跑）。
    pub daemon_running: bool,
    /// daemon 不可用时的错误原因。
    pub daemon_error: Option<String>,
    /// `docker compose version` 的输出。**纯客户端**动作，daemon 不在跑也答得上来
    /// （同 `docker compose config`，见 `docs/docker-isolation.md` §4），所以
    /// 「compose 可不可用」与「守护进程在不在跑」是两件互不遮挡的事实。
    pub compose_version: Option<String>,
    /// compose 子命令没答话时的原因（CLI 在但插件没装 / 执行失败）。
    pub compose_error: Option<String>,
    /// 当前运行中的容器数（`docker ps --format '{{.ID}}' | wc -l` 等价物）。
    pub running_containers: u32,
    /// 当前镜像总数。
    pub image_count: u32,
}

/// `docker info` 能跑通 = daemon 在运行；跑不通 = daemon 不在跑。
fn daemon_running() -> (bool, Option<String>) {
    let out = Command::new("docker").args(["info"]).output();
    match out {
        Ok(o) => {
            if o.status.success() {
                (true, None)
            } else {
                let err = String::from_utf8_lossy(&o.stderr).trim().to_string();
                (false, Some(err))
            }
        }
        Err(e) => (false, Some(format!("无法执行 docker：{e}"))),
    }
}

fn count_lines(cmd: &[&str]) -> u32 {
    let out = match Command::new("docker").args(cmd).output() {
        Ok(o) if o.status.success() => o.stdout,
        _ => return 0,
    };
    String::from_utf8_lossy(&out).lines().count() as u32
}

/// `docker compose version` = compose 插件可用性探针。
///
/// 返回 `(版本串, 失败原因)`，二者恰好一个为 `Some`。它不碰守护进程，因此在
/// Docker Desktop 没起的机器上照样给出结论——这正是隔离命令
/// （`isolatedComposeCommand`）能不能跑所依赖的那一半事实。
///
/// 刻意**没有**把「失败」当成「没装」写死：`docker compose version` 拒绝答话的
/// 原因可能是插件缺失、也可能是权限/环境问题，面板把后端原话显示出来，
/// 由人判断，而不是替他下结论。
fn compose_probe() -> (Option<String>, Option<String>) {
    let out = match Command::new("docker").args(["compose", "version"]).output() {
        Ok(o) => o,
        Err(e) => return (None, Some(format!("无法执行 docker：{e}"))),
    };
    if out.status.success() {
        let mut text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if text.is_empty() {
            text = String::from_utf8_lossy(&out.stderr).trim().to_string();
        }
        if text.is_empty() {
            (None, Some("docker compose version 成功但没有输出".to_string()))
        } else {
            (Some(text), None)
        }
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        (
            None,
            Some(if err.is_empty() {
                format!("docker compose version 退出码 {}", out.status)
            } else {
                err
            }),
        )
    }
}

/// 后端命令：返回当前 Docker 状态快照。
#[tauri::command(async)]
pub fn docker_status() -> DockerStatus {
    let cli_found = which("docker").is_some();
    let (daemon_running, daemon_error) = if cli_found {
        daemon_running()
    } else {
        (false, Some("docker 不在 PATH 上".to_string()))
    };
    let version = if cli_found {
        Command::new("docker")
            .args(["--version"])
            .output()
            .ok()
            .and_then(|o| {
                if o.status.success() {
                    Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
                } else {
                    None
                }
            })
    } else {
        None
    };
    // CLI 不在 PATH 上时连探针都不跑：这时「compose 不可用」的真原因是没装 docker，
    // 把 spawn 失败的原话显示成 compose 的失败原因会指错方向。
    let (compose_version, compose_error) = if cli_found {
        compose_probe()
    } else {
        (None, None)
    };
    let running = if daemon_running { count_lines(&["ps", "--format", "{{.ID}}"]) } else { 0 };
    let images = if daemon_running { count_lines(&["images", "--format", "{{.ID}}"]) } else { 0 };
    DockerStatus {
        cli_found,
        version,
        daemon_running,
        daemon_error,
        compose_version,
        compose_error,
        running_containers: running,
        image_count: images,
    }
}

/// 检查一个目录里有没有 docker-compose.yml 或 compose.yaml。
#[tauri::command(async)]
pub fn project_has_compose(path: String) -> Option<String> {
    let dir = Path::new(&path);
    for name in ["docker-compose.yml", "docker-compose.yaml", "compose.yaml", "compose.yml"] {
        let p = dir.join(name);
        if p.exists() {
            return Some(name.to_string());
        }
    }
    None
}

// ---- which helper ----------------------------------------------------------

fn which(name: &str) -> Option<String> {
    if cfg!(windows) {
        // Windows：检查 PATH 上 name.exe / name.cmd / name.bat
        Command::new("where").arg(name).output().ok().and_then(|o| {
            if o.status.success() {
                let first = String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .next()
                    .map(|s| s.trim().to_string());
                first
            } else {
                None
            }
        })
    } else {
        // Unix：which 直接返回第一个
        Command::new("which").arg(name).output().ok().and_then(|o| {
            if o.status.success() {
                Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
            } else {
                None
            }
        })
    }
}

// ---- tests ----------------------------------------------------------------
//
// 不测 `docker_status` 本身：它会真的 spawn `docker`，结论取决于这台机器，
// 一条「本机现在应该返回 X」的断言在没有 Docker 的 CI 上必然要么假绿要么假红。
// 这里钉的是两件与机器无关的事：compose 文件名的探测规则（N2-2 的接线读它），
// 以及前端 `src/types.ts` 读到的字段名（serde rename 改动会在这里变红，
// 而不是在界面上渲染出 undefined）。
#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("devhub-docker-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    #[test]
    fn project_has_compose_finds_the_four_names_and_only_at_the_top() {
        for name in ["docker-compose.yml", "docker-compose.yaml", "compose.yaml", "compose.yml"] {
            let dir = scratch(name);
            assert_eq!(project_has_compose(dir.to_string_lossy().into_owned()), None, "{name} 先不存在");
            std::fs::write(dir.join(name), "services: {}\n").unwrap();
            assert_eq!(
                project_has_compose(dir.to_string_lossy().into_owned()),
                Some(name.to_string()),
                "{name} 存在时原样回报文件名",
            );
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn project_has_compose_ignores_nested_and_unknown_files() {
        let dir = scratch("nested");
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub").join("docker-compose.yml"), "services: {}\n").unwrap();
        std::fs::write(dir.join("compose.txt"), "not yaml\n").unwrap();
        assert_eq!(project_has_compose(dir.to_string_lossy().into_owned()), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn docker_status_serializes_the_camel_case_names_types_ts_reads() {
        let status = DockerStatus {
            cli_found: true,
            version: Some("Docker version 0.0.0".into()),
            daemon_running: false,
            daemon_error: Some("no daemon".into()),
            compose_version: None,
            compose_error: Some("no compose".into()),
            running_containers: 0,
            image_count: 0,
        };
        let v = serde_json::to_value(&status).expect("DockerStatus serializes");
        let obj = v.as_object().expect("object");
        for key in [
            "cliFound",
            "version",
            "daemonRunning",
            "daemonError",
            "composeVersion",
            "composeError",
            "runningContainers",
            "imageCount",
        ] {
            assert!(obj.contains_key(key), "缺 {key}：src/types.ts 的 DockerStatus 会读到 undefined");
        }
        assert!(!obj.contains_key("cli_found"), "rename_all 被拿掉了？两端字段名必须同时改");
    }
}
