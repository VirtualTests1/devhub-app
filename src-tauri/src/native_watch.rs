//! Recursive native directory watching via `ReadDirectoryChangesW` (r22-R1).
//!
//! ## Why this exists as a standalone module
//!
//! The app's current watcher (`fs_watch.rs`) polls the *direct children* of each
//! repository every 700 ms and folds bursts into one batch. Its own header records
//! the limitation in plain words: saving a file in a subdirectory changes neither
//! the root entry count nor its latest mtime, so that change is invisible until a
//! manual refresh. The documented next step was `ReadDirectoryChangesW` with
//! `bWatchSubtree = TRUE`, and this module is that step's core.
//!
//! It is **not wired into `watch_repositories` yet**. Wiring it changes the
//! lifecycle story (`fs_watch.rs` §4.4: the sampler thread currently never stops
//! because it holds no OS handle; a native watcher must be cancelled and joined),
//! and this round's evidence is a measured latency experiment, not a production
//! cutover. See `docs/r22-native-watch.md` for the integration plan.
//!
//! ## Windows API (source)
//!
//! `ReadDirectoryChangesW` is documented at
//! `https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-readdirectorychangesw`
//! (retrieved 2026-10-21). The call used here is the **synchronous** form:
//! directory handle from `CreateFileW` with `FILE_FLAG_BACKUP_SEMANTICS`, no
//! overlapped event, one 64 KB buffer, `bWatchSubtree = TRUE`. Cancellation uses
//! `CancelIoEx`, then `CloseHandle` after the thread joins.
//!
//! ## What the channel carries
//!
//! `Result<Vec<String>, String>` — the repository-relative names reported in one
//! wakeup (NTFS usually batches several entries into one buffer), or the OS error
//! that ended the watch. It does not debounce: that is `fs_watch::DebouncedBatch`'s
//! job, and putting two fold layers here would make the latency measurement
//! dishonest.
//!
//! ## Safety
//!
//! The handle is owned by [`NativeWatch`] and closed exactly once, after the reader
//! thread has joined. `CancelIoEx` runs before the join so a blocking read has a
//! documented way out; `ERROR_OPERATION_ABORTED` is the expected result of that
//! cancel, not an error. The buffer is `Vec<u32>` so `FILE_NOTIFY_INFORMATION` is
//! 4-byte aligned as the OS requires; the parser bounds-checks every offset.

#![allow(dead_code)]

use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};

/// 64 KB, the size Microsoft's examples use; larger only improves batching.
const BUFFER_BYTES: usize = 64 * 1024;
const FILE_LIST_DIRECTORY: u32 = 0x0001;
const FILE_SHARE_READ: u32 = 0x0001;
const FILE_SHARE_WRITE: u32 = 0x0002;
const FILE_SHARE_DELETE: u32 = 0x0004;
const OPEN_EXISTING: u32 = 3;
const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
const FILE_NOTIFY_CHANGE_FILE_NAME: u32 = 0x0000_0001;
const FILE_NOTIFY_CHANGE_DIR_NAME: u32 = 0x0000_0002;
const FILE_NOTIFY_CHANGE_SIZE: u32 = 0x0000_0008;
const FILE_NOTIFY_CHANGE_LAST_WRITE: u32 = 0x0000_0010;
const ERROR_OPERATION_ABORTED: i32 = 995;

#[cfg(windows)]
#[repr(C)]
struct FileNotifyInformation {
    next_entry_offset: u32,
    action: u32,
    file_name_length: u32,
    // FAM: the real array is `file_name_length / 2` UTF-16 units long.
    file_name: [u16; 1],
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn CreateFileW(
        name: *const u16,
        access: u32,
        share: u32,
        security: *mut core::ffi::c_void,
        creation: u32,
        flags: u32,
        template: *mut core::ffi::c_void,
    ) -> *mut core::ffi::c_void;
    fn ReadDirectoryChangesW(
        directory: *mut core::ffi::c_void,
        buffer: *mut core::ffi::c_void,
        buffer_len: u32,
        watch_subtree: i32,
        filter: u32,
        bytes_returned: *mut u32,
        overlapped: *mut core::ffi::c_void,
        completion: *mut core::ffi::c_void,
    ) -> i32;
    fn CancelIoEx(file: *mut core::ffi::c_void, overlapped: *mut core::ffi::c_void) -> i32;
    fn CloseHandle(handle: *mut core::ffi::c_void) -> i32;
}

/// A running watcher. Dropping it cancels the pending read, joins the thread and
/// closes the directory handle.
pub struct NativeWatch {
    handle: isize,
    stop: Arc<AtomicBool>,
    join: Option<JoinHandle<()>>,
}

impl Drop for NativeWatch {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        #[cfg(windows)]
        // SAFETY: the handle is still owned by this struct and has not been closed;
        // CancelIoEx only marks pending I/O for cancellation.
        unsafe {
            CancelIoEx(self.handle as *mut core::ffi::c_void, std::ptr::null_mut());
        }
        if let Some(j) = self.join.take() {
            if let Err(e) = j.join() {
                eprintln!("[native-watch] reader thread panicked: {e:?}");
            }
        }
        #[cfg(windows)]
        // SAFETY: the reader thread has joined, so no other code can use the handle;
        // this is the single close for it.
        unsafe {
            CloseHandle(self.handle as *mut core::ffi::c_void);
        }
    }
}

/// Start watching `root` recursively. The returned receiver yields one message per
/// OS wakeup; the watcher must be kept alive for the channel to stay open.
type WatchEvents = Receiver<Result<Vec<String>, String>>;

#[cfg(windows)]
pub fn start(root: &Path) -> io::Result<(NativeWatch, WatchEvents)> {
    use std::os::windows::ffi::OsStrExt;
    let wide: Vec<u16> = root.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    // SAFETY: `wide` is a NUL-terminated UTF-16 path; the returned handle is null-checked.
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            FILE_LIST_DIRECTORY,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null_mut(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    };
    if handle.is_null() {
        return Err(io::Error::last_os_error());
    }
    let handle_bits = handle as isize;
    let stop = Arc::new(AtomicBool::new(false));
    let stop_in = stop.clone();
    let (tx, rx): (Sender<Result<Vec<String>, String>>, Receiver<_>) = channel();
    let join = thread::Builder::new()
        .name("devhub-native-watch".to_string())
        .spawn(move || read_loop(handle_bits, stop_in, tx))?;
    Ok((
        NativeWatch {
            handle: handle_bits,
            stop,
            join: Some(join),
        },
        rx,
    ))
}

#[cfg(not(windows))]
pub fn start(_root: &Path) -> io::Result<(NativeWatch, Receiver<Result<Vec<String>, String>>)> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "native watcher is Windows-only"))
}

#[cfg(windows)]
fn read_loop(handle: isize, stop: Arc<AtomicBool>, tx: Sender<Result<Vec<String>, String>>) {
    let filter = FILE_NOTIFY_CHANGE_FILE_NAME
        | FILE_NOTIFY_CHANGE_DIR_NAME
        | FILE_NOTIFY_CHANGE_SIZE
        | FILE_NOTIFY_CHANGE_LAST_WRITE;
    // `u32` rather than `u8`: FILE_NOTIFY_INFORMATION is documented as 4-byte
    // aligned, and a Vec<u8> only happens to be aligned in today's allocator.
    let mut buffer = vec![0u32; BUFFER_BYTES / 4];
    loop {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        let mut returned = 0u32;
        // SAFETY: the buffer is alive for the call, its byte length is exact, and the
        // handle is owned by the watcher. Synchronous (null OVERLAPPED): the thread
        // blocks here until a change or CancelIoEx.
        let ok = unsafe {
            ReadDirectoryChangesW(
                handle as *mut core::ffi::c_void,
                buffer.as_mut_ptr() as *mut core::ffi::c_void,
                BUFFER_BYTES as u32,
                1,
                filter,
                &mut returned,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            let err = io::Error::last_os_error();
            if stop.load(Ordering::SeqCst) || err.raw_os_error() == Some(ERROR_OPERATION_ABORTED) {
                break;
            }
            if tx.send(Err(err.to_string())).is_err() {
                break;
            }
            break;
        }
        let names = parse_notifications(&buffer, returned as usize);
        if !names.is_empty() && tx.send(Ok(names)).is_err() {
            break; // receiver dropped
        }
    }
}

/// Walk the `FILE_NOTIFY_INFORMATION` chain. Exposed for tests; every offset is
/// bounds-checked because the buffer is OS-written.
#[cfg(windows)]
fn parse_notifications(buffer: &[u32], bytes_returned: usize) -> Vec<String> {
    let bytes = bytes_returned.min(buffer.len() * 4);
    let mut out = Vec::new();
    let base = buffer.as_ptr() as *const u8;
    let mut offset = 0usize;
    loop {
        let header = std::mem::size_of::<u32>() * 3; // next + action + name length
        if offset + header + 2 > bytes {
            break;
        }
        // SAFETY: `offset + header` is inside the buffer; the struct's FAM pointer is
        // only read for `file_name_length` bytes after bounds-checking below.
        let (next, name_len) = unsafe {
            let p = base.add(offset) as *const FileNotifyInformation;
            ((*p).next_entry_offset as usize, (*p).file_name_length as usize)
        };
        let name_start = offset + header;
        if name_len % 2 != 0 || name_start + name_len > bytes {
            break;
        }
        // SAFETY: name_start..name_start+name_len is inside the OS-filled buffer and
        // is a UTF-16 code-unit run.
        let units = unsafe {
            std::slice::from_raw_parts(base.add(name_start) as *const u16, name_len / 2)
        };
        out.push(String::from_utf16_lossy(units));
        if next == 0 || offset + next >= bytes {
            break;
        }
        offset += next;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    struct Scratch(std::path::PathBuf);

    impl Scratch {
        fn new(tag: &str) -> Self {
            let path = std::env::temp_dir().join(format!("devhub-native-watch-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(path.join("sub")).unwrap();
            Scratch(path)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    #[cfg(windows)]
    fn a_write_inside_a_subdirectory_is_reported() {
        let s = Scratch::new("nested");
        let (watch, rx) = start(&s.0).expect("start watcher");
        // Give the reader thread a moment to enter ReadDirectoryChangesW.
        std::thread::sleep(Duration::from_millis(150));
        let t0 = Instant::now();
        std::fs::write(s.0.join("sub").join("deep.txt"), b"hello").unwrap();
        let batch = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("a nested write must wake the watcher")
            .expect("no OS error expected");
        let elapsed = t0.elapsed();
        assert!(
            batch.iter().any(|n| n.ends_with("deep.txt")),
            "reported names must include the nested file: {batch:?}"
        );
        println!("native watcher latency: {} ms", elapsed.as_millis());
        drop(watch);
    }

    #[test]
    #[cfg(windows)]
    fn dropping_the_watcher_does_not_hang_the_thread() {
        let s = Scratch::new("drop");
        let (watch, _rx) = start(&s.0).expect("start watcher");
        std::thread::sleep(Duration::from_millis(100));
        let t0 = Instant::now();
        drop(watch);
        // 5 s, not 2: this test runs beside ~395 others, and a full `cargo test
        // --lib` on this machine's D: volume once measured the drop at >2 s while
        // the same test alone took 0.14 s. The assertion is "does not hang", not
        // "meets a latency budget"; 5 s still fails a genuinely stuck join.
        assert!(t0.elapsed() < Duration::from_secs(5), "cancel + join must be prompt");
    }

    /// How many names a real 500-file burst puts through this channel, and how
    /// long the reader takes to drain them. This is a measurement, not a promise:
    /// ReadDirectoryChangesW is allowed to coalesce and, if the 64 KB buffer
    /// overflows, to report a rescan instead of every name. The existing 700 ms
    /// polling pass is the documented fallback, so the test asserts that events
    /// arrive and prints the coverage rather than failing on a coalesced write.
    ///
    ///     cargo test --lib -- --ignored --nocapture bench_write_burst_coverage
    #[test]
    #[ignore = "stress measurement; run with --ignored --nocapture"]
    #[cfg(windows)]
    fn bench_write_burst_coverage() {
        use std::collections::HashSet;
        use std::time::{Duration, Instant};
        let s = Scratch::new("burst");
        for d in 0..10 {
            std::fs::create_dir_all(s.0.join(format!("d{d}"))).unwrap();
        }
        let (watch, rx) = start(&s.0).expect("start watcher");
        std::thread::sleep(Duration::from_millis(200));
        let total = 500usize;
        let started = Instant::now();
        for i in 0..total {
            let path = s.0.join(format!("d{}", i % 10)).join(format!("f{i:04}.txt"));
            std::fs::write(path, b"x").unwrap();
        }
        let write_ms = started.elapsed().as_millis();
        let mut seen: HashSet<String> = HashSet::new();
        let mut batches = 0usize;
        let mut errors = 0usize;
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(800)) {
                Ok(Ok(names)) => {
                    batches += 1;
                    for n in names {
                        seen.insert(n);
                    }
                }
                Ok(Err(e)) => {
                    errors += 1;
                    println!("watcher error: {e}");
                    break;
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        let files_seen = seen.iter().filter(|n| n.ends_with(".txt")).count();
        println!(
            "wrote {total} files in {write_ms} ms; unique names {} ({files_seen} file names);              batches {batches}; errors {errors}; drain {} ms",
            seen.len(),
            started.elapsed().as_millis(),
        );
        assert!(files_seen > 0, "a 500-file burst must produce at least one file notification");
        drop(watch);
    }

    #[test]
    #[cfg(windows)]
    fn a_truncated_notification_chain_is_rejected_not_read_out_of_bounds() {
        // Three header words but a name length that runs past the buffer.
        let buf = vec![0u32, 0, 8, 0];
        assert!(parse_notifications(&buf, buf.len() * 4).is_empty());
        // A zero-length chain is empty, not a panic.
        assert!(parse_notifications(&[], 0).is_empty());
    }
}
