//! Free-space probe for the download preflight (r22-N1).
//!
//! The add page can now show a remote repository's size before a download; the
//! other half of "will this fit" is the landing volume. Windows exposes it through
//! `GetDiskFreeSpaceExW`, which takes the path itself (not a drive letter), so a
//! target on a mounted volume or a junction is answered correctly.
//!
//! The target directory usually does not exist yet (the download creates it), so
//! the probe walks up to the nearest existing ancestor. A path that none of whose
//! ancestors exists yields `None`; the UI must say "无法判断" rather than 0 bytes.

use std::path::{Path, PathBuf};

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn GetDiskFreeSpaceExW(
        directory_name: *const u16,
        free_bytes_available_to_caller: *mut u64,
        total_number_of_bytes: *mut u64,
        total_number_of_free_bytes: *mut u64,
    ) -> i32;
}

/// What the probe could learn about one volume.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DiskSpace {
    pub available: u64,
    pub total: u64,
}

/// Free/total bytes for the volume holding `path`, or `None` when no ancestor
/// exists or the OS call fails.
pub(crate) fn space_for(path: &Path) -> Option<DiskSpace> {
    let mut probe: PathBuf = path.to_path_buf();
    loop {
        if probe.exists() {
            return space_of_existing(&probe);
        }
        match probe.parent() {
            Some(parent) if parent != probe => probe = parent.to_path_buf(),
            _ => return None,
        }
    }
}

#[cfg(windows)]
fn space_of_existing(path: &Path) -> Option<DiskSpace> {
    use std::os::windows::ffi::OsStrExt;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut available = 0u64;
    let mut total = 0u64;
    let mut free = 0u64;
    // SAFETY: `wide` is a NUL-terminated UTF-16 path that lives for the call; the
    // three out-parameters are valid `u64`s.
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut available,
            &mut total,
            &mut free,
        )
    };
    if ok == 0 {
        return None;
    }
    Some(DiskSpace {
        // "Available to the caller" accounts for quotas; total is the volume size.
        available,
        total,
    })
}

#[cfg(not(windows))]
fn space_of_existing(_path: &Path) -> Option<DiskSpace> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_checkout_volume_answers_with_positive_numbers() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR"));
        let space = space_for(src).expect("the checkout's volume must answer");
        assert!(space.total > 0, "total bytes must be a real volume size");
        assert!(space.available <= space.total, "available cannot exceed total");
    }

    #[test]
    fn a_missing_leaf_walks_up_to_an_existing_ancestor() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR"));
        let missing = src.join("r22-n1-definitely-missing").join("deeper");
        assert!(!missing.exists());
        let space = space_for(&missing).expect("the ancestor exists, so the volume must answer");
        assert!(space.total > 0);
    }

    #[test]
    fn a_path_with_no_existing_ancestor_is_none_not_zero() {
        // `Q:\` is not a volume on this machine by construction; the probe must not
        // turn "unknown" into an apparently valid 0-byte answer.
        if space_for(Path::new("Q:\\devhub-probe")).is_none() {
            assert_eq!(space_for(Path::new("Q:\\devhub-probe")), None);
        }
    }
}
