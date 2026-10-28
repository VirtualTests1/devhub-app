//! Enumerates the fonts Windows has installed, for the 外观 page's font picker
//! (需求 5：本机系统字体识别).
//!
//! Source of truth: the registry keys Windows itself maintains
//! (`HKLM\...\Fonts` and the per-user `HKCU\...\Fonts`). Value names look like
//! `Microsoft YaHei & Microsoft YaHei UI (TrueType)`; the family list is the
//! `&`-separated names with the file-format suffix and the Bold/Italic style
//! markers stripped — Word's own picker lists the same way: Light variants stay
//! separate families, Bold/Italic are toggles, not entries.
//!
//! Deliberately registry-based with zero new dependencies: GDI enumeration
//! would need the `windows` crate, and the registry is what「已安装」means on
//! Windows anyway. Display names for the common CJK families are mapped to
//! their Chinese names so the picker reads like Word's on a zh-CN machine;
//! everything else keeps its (English) family name, which CSS accepts as-is.
//!
//! Registered in `lib.rs` as `fonts::list_system_fonts`. It landed as a dead file
//! first: `lib.rs` was unwritable while the workspace write-guard misread its
//! `github_token` config field as a credential literal (see 修复报告_20261009.md),
//! so the frontend was given a curated fallback list and told to use it when the
//! command is absent - which is still the path a build without this module takes.

use std::sync::OnceLock;

#[derive(Debug, Clone, serde::Serialize)]
pub struct FontFamilyInfo {
    /// The CSS family name (what goes into `font-family`).
    pub family: String,
    /// What the picker displays: Chinese for mapped CJK families, else family.
    pub display: String,
}

/// The frontend may call this repeatedly while filtering; parse the registry
/// once per process.
#[tauri::command]
pub fn list_system_fonts() -> Vec<FontFamilyInfo> {
    static CACHE: OnceLock<Vec<FontFamilyInfo>> = OnceLock::new();
    CACHE.get_or_init(load_families).clone()
}

fn load_families() -> Vec<FontFamilyInfo> {
    let mut names: Vec<String> = Vec::new();
    #[cfg(windows)]
    {
        use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
        use winreg::RegKey;
        for hive in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
            let Ok(key) = RegKey::predef(hive)
                .open_subkey(r"Software\Microsoft\Windows NT\CurrentVersion\Fonts")
            else {
                continue;
            };
            for name in key.enum_values().flatten().map(|(n, _)| n) {
                names.push(name);
            }
        }
    }
    families_from_registry_names(&names)
        .into_iter()
        .map(|family| {
            let display = display_name(&family);
            FontFamilyInfo { family, display }
        })
        .collect()
}

/// Pure, testable core: registry value names → sorted unique CSS families.
pub fn families_from_registry_names(names: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in names {
        let base = match raw.find('(') {
            Some(i) => raw[..i].trim(),
            None => raw.trim(),
        };
        if base.is_empty() {
            continue;
        }
        for part in base.split('&') {
            let mut fam = part.trim().to_string();
            loop {
                let lower = fam.to_ascii_lowercase();
                let stripped = [" bold italic", " oblique", " bold", " italic"]
                    .iter()
                    .find_map(|suffix| {
                        if lower.ends_with(suffix) {
                            Some(fam[..fam.len() - suffix.len()].trim_end().to_string())
                        } else {
                            None
                        }
                    });
                match stripped {
                    Some(next) => fam = next,
                    None => break,
                }
            }
            let fam = fam.trim().to_string();
            if !fam.is_empty() && !out.iter().any(|x| x.eq_ignore_ascii_case(&fam)) {
                out.push(fam);
            }
        }
    }
    out.sort_by_key(|f| f.to_ascii_lowercase());
    out
}

/// Localized display names for the CJK families a zh-CN user browses.
fn display_name(family: &str) -> String {
    const MAP: &[(&str, &str)] = &[
        ("Microsoft YaHei UI", "微软雅黑 UI"),
        ("Microsoft YaHei", "微软雅黑"),
        ("NSimSun", "新宋体"),
        ("SimSun", "宋体"),
        ("SimHei", "黑体"),
        ("KaiTi", "楷体"),
        ("FangSong", "仿宋"),
        ("DengXian Light", "等线 Light"),
        ("DengXian", "等线"),
        ("STKaiti", "华文楷体"),
        ("STFangsong", "华文仿宋"),
        ("STSong", "华文宋体"),
        ("STZhongsong", "华文中宋"),
        ("STXihei", "华文细黑"),
        ("STLiti", "华文隶书"),
        ("STXingkai", "华文行楷"),
        ("STXinwei", "华文新魏"),
        ("MingLiU", "細明體"),
        ("PMingLiU", "新細明體"),
    ];
    for (en, zh) in MAP {
        if family.eq_ignore_ascii_case(en) {
            return (*zh).to_string();
        }
    }
    family.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_and_strips_registry_names() {
        let names = vec![
            "Microsoft YaHei & Microsoft YaHei UI (TrueType)".to_string(),
            "DengXian Bold (TrueType)".to_string(),
            "Arial Black (TrueType)".to_string(),
            "DengXian Light (TrueType)".to_string(),
            "Cambria & Cambria Math (TrueType)".to_string(),
            "Segoe UI Italic (TrueType)".to_string(),
        ];
        let got = families_from_registry_names(&names);
        assert!(got.contains(&"Microsoft YaHei".to_string()));
        assert!(got.contains(&"Microsoft YaHei UI".to_string()));
        assert!(got.contains(&"DengXian".to_string()));
        assert!(
            !got.iter().any(|f| f.ends_with("Bold")),
            "Bold 是样式标记，不是字族"
        );
        assert!(
            got.contains(&"Arial Black".to_string()),
            "Black 是字族名本身，不能剥掉"
        );
        assert!(
            got.contains(&"DengXian Light".to_string()),
            "Light 在 Word 的字体列表里是独立条目"
        );
        assert!(got.contains(&"Cambria Math".to_string()));
        assert!(!got.iter().any(|f| f.ends_with("Italic")));
    }

    #[test]
    fn dedupes_case_insensitively_and_sorts() {
        let got = families_from_registry_names(&[
            "SimSun (TrueType)".to_string(),
            "simsun (TrueType)".to_string(),
            "Arial (TrueType)".to_string(),
        ]);
        assert_eq!(got, vec!["Arial".to_string(), "SimSun".to_string()]);
    }

    #[test]
    fn display_names_map_common_cjk_families() {
        assert_eq!(display_name("Microsoft YaHei"), "微软雅黑");
        assert_eq!(display_name("SimSun"), "宋体");
        assert_eq!(display_name("SomeOddFont"), "SomeOddFont");
    }
}
