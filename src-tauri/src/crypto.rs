//! Windows DPAPI at-rest protection for the GitHub token (r22-O1).
//!
//! ## Why this module exists
//!
//! `AppConfig.github_token` was documented as "plain text in the config file, which
//! any process running as this user can read" (`settings_cmd.rs`, the field comment
//! that this round replaces). The app already keeps the token out of argv, out of
//! the UI and out of activity logs; the remaining hole was the file itself.
//!
//! Windows ships DPAPI (`CryptProtectData` / `CryptUnprotectData`): encryption is
//! bound to the **current user** by the OS, so copying `devhub-config.json` to
//! another account or machine makes the token unreadable rather than portable. That
//! is the correct trade for a local PAT, and it is stated in the settings hint.
//!
//! ## No new dependency
//!
//! `crypt32`/`kernel32` are called through `extern "system"` exactly like
//! `proc.rs` calls the Job Object APIs. Adding a crypto crate for two functions
//! would grow the supply chain and the release binary for no protocol work.
//!
//! ## Storage format
//!
//! `dpapi:v1:<lower-case hex>`; the prefix is what makes a legacy plaintext token
//! distinguishable from a protected one. Hex rather than base64 because the token
//! is short and the decoder is ten lines with no dependency. A plaintext value is
//! **accepted on read** and re-encrypted on the next write; refusing it would lock
//! users out of their own hand-edited config.
//!
//! ## Failure policy
//!
//! `unprotect` returns:
//!   - `Ok(None)` — the value is legacy plaintext (no prefix), so callers may use it;
//!   - `Ok(Some(text))` — a protected value that decrypted;
//!   - `Err(reason)` — a protected value that did **not** decrypt (another user,
//!     corrupted bytes, DPAPI unavailable).
//!
//! The caller must not silently replace an `Err` with an empty token on write: a
//! settings save that merely changed an unrelated field would then erase the only
//! copy. `settings_cmd::write_config` keeps an undecryptable blob verbatim.

/// Prefix that marks a DPAPI-protected token.
pub(crate) const DPAPI_PREFIX: &str = "dpapi:v1:";

/// `CryptProtectData` shows no UI; the call is made from a background save.
#[cfg(windows)]
const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;

#[cfg(windows)]
#[repr(C)]
struct DataBlob {
    cb_data: u32,
    pb_data: *mut u8,
}

#[cfg(windows)]
#[link(name = "crypt32")]
extern "system" {
    fn CryptProtectData(
        data_in: *const DataBlob,
        description: *const u16,
        optional_entropy: *const DataBlob,
        reserved: *mut core::ffi::c_void,
        prompt: *mut core::ffi::c_void,
        flags: u32,
        data_out: *mut DataBlob,
    ) -> i32;
    fn CryptUnprotectData(
        data_in: *const DataBlob,
        description: *mut *mut u16,
        optional_entropy: *const DataBlob,
        reserved: *mut core::ffi::c_void,
        prompt: *mut core::ffi::c_void,
        flags: u32,
        data_out: *mut DataBlob,
    ) -> i32;
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn LocalFree(ptr: *mut core::ffi::c_void) -> *mut core::ffi::c_void;
}

/// Bytes → lower-case hex. Kept here (not in a crate) so the storage format has one
/// encoder and the tests can pin it.
fn to_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(DIGITS[(b >> 4) as usize] as char);
        out.push(DIGITS[(b & 0x0f) as usize] as char);
    }
    out
}

fn from_hex(text: &str) -> Result<Vec<u8>, String> {
    if text.len() % 2 != 0 {
        return Err("DPAPI 载荷的十六进制长度是奇数".to_string());
    }
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() / 2);
    for pair in bytes.chunks_exact(2) {
        let hi = hex_nibble(pair[0]).ok_or_else(|| "DPAPI 载荷含非十六进制字符".to_string())?;
        let lo = hex_nibble(pair[1]).ok_or_else(|| "DPAPI 载荷含非十六进制字符".to_string())?;
        out.push((hi << 4) | lo);
    }
    Ok(out)
}

fn hex_nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Is this stored value already in the protected format? A prefix check only; it
/// does not prove the blob decrypts (that is [`unprotect`]'s job).
pub(crate) fn is_protected(stored: &str) -> bool {
    stored.starts_with(DPAPI_PREFIX)
}

/// Encrypt a non-empty plaintext token for storage.
///
/// Empty input returns an empty string: "no token" is not an encrypted empty blob.
pub(crate) fn protect(plain: &str) -> Result<String, String> {
    if plain.is_empty() {
        return Ok(String::new());
    }
    if is_protected(plain) {
        // Already in storage form (a caller passed a decrypted config that still
        // carried the prefix); do not double-encrypt it.
        return Ok(plain.to_string());
    }
    let cipher = protect_bytes(plain.as_bytes())?;
    Ok(format!("{DPAPI_PREFIX}{}", to_hex(&cipher)))
}

/// Read a stored token:
///   - no prefix → `Ok(None)` (legacy plaintext, caller may use it as-is);
///   - prefix + decrypts → `Ok(Some(plaintext))`;
///   - prefix + fails → `Err`.
pub(crate) fn unprotect(stored: &str) -> Result<Option<String>, String> {
    if stored.is_empty() {
        return Ok(Some(String::new()));
    }
    if !is_protected(stored) {
        return Ok(None);
    }
    let bytes = from_hex(&stored[DPAPI_PREFIX.len()..])?;
    let plain = unprotect_bytes(&bytes)?;
    String::from_utf8(plain)
        .map(Some)
        .map_err(|_| "DPAPI 解出的内容不是 UTF-8".to_string())
}

#[cfg(windows)]
fn protect_bytes(plain: &[u8]) -> Result<Vec<u8>, String> {
    // DPAPI takes the input buffer as mutable pointers even though it does not
    // modify it; `as_ptr() as *mut u8` is the documented shape and the call is
    // synchronous, so the Vec cannot move while the pointer is live.
    let input = DataBlob {
        cb_data: plain.len() as u32,
        pb_data: plain.as_ptr() as *mut u8,
    };
    let mut output = DataBlob {
        cb_data: 0,
        pb_data: std::ptr::null_mut(),
    };
    // SAFETY: `input` points at `plain` for the duration of the call; `output` is a
    // valid out-parameter; no entropy/prompt/reserved pointers are passed.
    let ok = unsafe {
        CryptProtectData(
            &input,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(format!(
            "DPAPI 加密失败：{}",
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: on success DPAPI allocated `output.pb_data` with LocalAlloc; copy it
    // out before freeing. A zero-length output is possible for empty input, but
    // `protect` never calls this with an empty buffer.
    let bytes = unsafe {
        let slice = std::slice::from_raw_parts(output.pb_data, output.cb_data as usize);
        let copy = slice.to_vec();
        LocalFree(output.pb_data as *mut core::ffi::c_void);
        copy
    };
    Ok(bytes)
}

#[cfg(windows)]
fn unprotect_bytes(cipher: &[u8]) -> Result<Vec<u8>, String> {
    if cipher.is_empty() {
        return Err("DPAPI 载荷为空".to_string());
    }
    let input = DataBlob {
        cb_data: cipher.len() as u32,
        pb_data: cipher.as_ptr() as *mut u8,
    };
    let mut output = DataBlob {
        cb_data: 0,
        pb_data: std::ptr::null_mut(),
    };
    let mut description: *mut u16 = std::ptr::null_mut();
    // SAFETY: same contract as `protect_bytes`; `description` is an optional
    // out-parameter that DPAPI may allocate, and it is freed below when non-null.
    let ok = unsafe {
        CryptUnprotectData(
            &input,
            &mut description,
            std::ptr::null(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if !description.is_null() {
        // SAFETY: DPAPI allocated this description with LocalAlloc.
        unsafe {
            LocalFree(description as *mut core::ffi::c_void);
        }
    }
    if ok == 0 {
        return Err(format!(
            "DPAPI 解密失败：{}（令牌可能由另一 Windows 用户加密，或配置被改动）",
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: success means `output.pb_data` is a LocalAlloc allocation of
    // `output.cb_data` bytes; copy then free.
    let bytes = unsafe {
        let slice = std::slice::from_raw_parts(output.pb_data, output.cb_data as usize);
        let copy = slice.to_vec();
        LocalFree(output.pb_data as *mut core::ffi::c_void);
        copy
    };
    Ok(bytes)
}

#[cfg(not(windows))]
fn protect_bytes(_plain: &[u8]) -> Result<Vec<u8>, String> {
    Err("DPAPI 仅支持 Windows".to_string())
}

#[cfg(not(windows))]
fn unprotect_bytes(_cipher: &[u8]) -> Result<Vec<u8>, String> {
    Err("DPAPI 仅支持 Windows".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_round_trips_and_rejects_odd_or_non_hex() {
        for bytes in [vec![0u8, 1, 15, 16, 255], b"hello".to_vec(), vec![0xde, 0xad, 0xbe, 0xef]] {
            let hex = to_hex(&bytes);
            assert_eq!(from_hex(&hex).unwrap(), bytes, "hex round-trip for {bytes:?}");
        }
        assert!(from_hex("abc").is_err(), "odd length must be refused");
        assert!(from_hex("zz").is_err(), "non-hex must be refused");
    }

    #[test]
    fn protect_prefixes_and_unprotects_the_same_text() {
        let token = "ghp_example_token_1234567890";
        let stored = protect(token).expect("DPAPI protect");
        assert!(stored.starts_with(DPAPI_PREFIX), "storage form must carry the version prefix");
        assert!(is_protected(&stored));
        assert_eq!(unprotect(&stored).unwrap(), Some(token.to_string()));
    }

    #[test]
    fn protect_handles_unicode_and_long_values() {
        for token in ["令牌-测试-🔐".to_string(), "x".repeat(4096)] {
            let stored = protect(&token).expect("protect");
            assert_eq!(unprotect(&stored).unwrap(), Some(token), "round-trip must preserve bytes");
        }
    }

    #[test]
    fn empty_stays_empty_and_plaintext_is_not_mistaken_for_ciphertext() {
        assert_eq!(protect("").unwrap(), "");
        assert_eq!(unprotect("").unwrap(), Some(String::new()));
        assert_eq!(unprotect("plain-legacy-token").unwrap(), None, "legacy plaintext is passed through as None");
        assert!(!is_protected("plain-legacy-token"));
    }

    #[test]
    fn already_protected_input_is_not_double_encrypted() {
        let once = protect("token").unwrap();
        let twice = protect(&once).unwrap();
        assert_eq!(once, twice, "protect() is idempotent on storage form");
    }

    #[test]
    fn corrupt_or_foreign_ciphertext_is_an_error_not_a_silent_empty() {
        let bad_hex = format!("{DPAPI_PREFIX}zz");
        assert!(unprotect(&bad_hex).is_err(), "non-hex payload must be an error");
        let too_short = format!("{DPAPI_PREFIX}00");
        assert!(unprotect(&too_short).is_err(), "a one-byte blob cannot decrypt");
        // A well-formed but random blob is the "another user / another machine" shape.
        let foreign = format!("{DPAPI_PREFIX}{}", to_hex(&[0x41; 64]));
        assert!(unprotect(&foreign).is_err(), "foreign ciphertext must surface, not vanish");
    }
}
