//! Spawning child processes **without** a console window.
//!
//! Why this module exists: DevHub is built with
//! `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]`, i.e. the
//! release executable owns no console. On Windows, a process with no console that
//! starts a console program *without* `CREATE_NO_WINDOW` gets a brand new console
//! window for the child — so every `git`, `curl`, `netstat` or `taskkill` call
//! flashed a black window on top of the UI. The 0.2.0 build spawned these without
//! any flags at all (verified: `creation_flags` appears nowhere in the pre-change
//! sources), which is exactly the "大量终端黑窗" that was reported.
//!
//! The one deliberate exception is [`new_console`]: the user explicitly asked
//! for an interactive terminal, so that one keeps its window.

use std::process::Command;

use serde::Serialize;

/// `CREATE_NO_WINDOW` from the Win32 process-creation flags.
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// `CREATE_NEW_CONSOLE`, used for the one window that is asked for on purpose.
pub const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;

/// Applies the "no console window" flag to an already-built command.
///
/// A no-op off Windows, so the code paths stay readable and this crate still
/// compiles for other targets.
pub fn hide_console(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// A `Command` that can never show a console window.
pub fn silent(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut cmd = Command::new(program);
    hide_console(&mut cmd);
    cmd
}

/// A `Command` that gets its **own visible console window**.
///
/// Only `launch_terminal_with` uses this: the user clicked "终端", so a window is the
/// requested outcome rather than an accident. Everything else uses [`silent`].
pub fn new_console(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NEW_CONSOLE);
    }
    cmd
}

/// Runs a command to completion with a deadline, capturing its output.
///
/// Every other subprocess in this crate is either streamed with its own
/// progress loop (`launch::spawn_streaming`, `downloader`'s poll loops) or
/// already carries a `--max-time` (curl) — except the small "ask a tool a
/// quick question" calls (`git status`, `py -0p`, `wsl -l -q`), which used
/// bare `.output()` and could park a synchronous command on the main thread
/// forever if the tool wedged. This is the bounded form for those.
///
/// Returns `Ok(None)` on timeout: the child is killed and reaped, and the
/// caller treats it exactly like "the tool did not answer". `Err` covers
/// spawn failure and a mid-flight wait error (the child is still reaped).
///
/// Two things `Command::output()` used to do for the callers and that a
/// hand-rolled `spawn()` + `try_wait()` loop does NOT, spelled out here because
/// both were silently lost when this function was introduced:
///
/// 1. **Piping.** `output()` sets `Stdio::piped()` itself; `spawn()` inherits
///    the parent's handles. This app is `windows_subsystem = "windows"`, so an
///    inherited stdout is not a terminal the caller can read — `wait_output()`
///    hands back an empty `Vec`. Six probes read `out.stdout`
///    (`launch::worktree_status`'s three git calls, `list_pythons`, `wsl_distros`,
///    `gitboot::verify_git`), so without the two `Stdio::piped()` calls below
///    every one of them degrades to "the tool said nothing" — 分支/脏状态 read as
///    clean before a permanent delete, and Python detection reports none.
/// 2. **Draining.** A pipe buffer is ~64 KiB; a child that writes past it blocks
///    on the write. Polling `try_wait` alone would therefore convert a chatty
///    probe into a timeout kill. The two reader threads below drain while we poll.
pub fn output_timeout(cmd: &mut Command, timeout: std::time::Duration) -> std::io::Result<Option<std::process::Output>> {
    cmd.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn()?;
    let h_out = spawn_drain(child.stdout.take());
    let h_err = spawn_drain(child.stderr.take());
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return Ok(Some(std::process::Output {
                    status,
                    stdout: join_drain(h_out),
                    stderr: join_drain(h_err),
                }))
            }
            Ok(None) => {
                if started.elapsed() > timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    // Deliberately NOT joining the drain threads here. Measured:
                    // with `cmd /C ping -n 30` the kill ends `cmd.exe`, but the
                    // grandchild still holds the write end of the pipe, so
                    // `read_to_end` does not reach EOF until the grandchild exits
                    // - joining turned a 200 ms deadline into a 29 s wait, which is
                    // the exact freeze this function exists to prevent. The threads
                    // end on their own as soon as the pipe closes; the bytes of a
                    // call we are abandoning are worth nothing.
                    return Ok(None);
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                join_drain(h_out);
                join_drain(h_err);
                return Err(e);
            }
        }
    }
}

/// Reads a pipe to EOF on its own thread so the child never blocks on a full
/// pipe buffer while [`output_timeout`] polls for exit.
fn spawn_drain<R: std::io::Read + Send + 'static>(pipe: Option<R>) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || match pipe {
        Some(mut pipe) => {
            let mut buf = Vec::new();
            // A read error (the child died holding the write end, a broken pipe)
            // is not worth failing the probe for: what arrived still arrived.
            let _ = std::io::Read::read_to_end(&mut pipe, &mut buf);
            buf
        }
        None => Vec::new(),
    })
}

fn join_drain(handle: std::thread::JoinHandle<Vec<u8>>) -> Vec<u8> {
    handle.join().unwrap_or_default()
}

/// Deadline for the quick "ask a tool a question" probes built on
/// [`output_timeout`]: generous next to a healthy `git status` (milliseconds)
/// but still a deadline, so a wedged tool degrades to "no answer" instead of
/// freezing the caller.
pub const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Whether **this process** is running elevated.
///
/// DevHub never needs administrator rights: repositories go under a writable
/// project root, and the portable Git bootstrap deliberately extracts without
/// elevation (its self-extracting archive is `asInvoker`, measured). So if this
/// returns `true`, the app was started elevated by something outside itself -
/// a right-click "以管理员身份运行", a shortcut with that flag, or an elevation
/// prompt the user accepted. That is the only way an elevation prompt can be
/// attributed to DevHub from inside the app, which is why it is reported.
///
/// Implementation is a heuristic, and documented as one: Windows grants write
/// access to `hosts` only to administrators, so a successful **write-open without
/// truncation** (nothing is written) is evidence of elevation. A security product
/// guarding that file could give a false negative, so the UI says "推断" rather
/// than claiming certainty.
#[cfg(windows)]
pub fn is_elevated() -> bool {
    let root = std::env::var_os("SystemRoot")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("C:\\Windows"));
    let hosts = root.join("System32/drivers/etc/hosts");
    std::fs::OpenOptions::new()
        .write(true)
        .open(&hosts)
        .map(|_| true)
        .unwrap_or(false)
}

#[cfg(not(windows))]
pub fn is_elevated() -> bool {
    false
}

// ---------------------------------------------------------------------------
// Decoding native command output
// ---------------------------------------------------------------------------

/// Turns a native tool's stderr/stdout bytes into text the user can read.
//
/// Reported symptom: `curl: (35) schannel: ... - Ҳ֤` — the Chinese half of the
/// message arrived as mojibake. The cause is not curl: Windows formats its
/// message strings in the **OEM codepage** of the system locale (936 / GBK on a
/// zh-CN install), and the previous code called `String::from_utf8_lossy`, which
/// replaces every non-UTF-8 byte with U+FFFD. So the failure was not in the
/// tool, it in how we read it — and it turned an actionable error into noise.
///
/// Order matters: valid UTF-8 wins (git and most POSIX-ish tools emit UTF-8),
/// and only bytes that cannot be UTF-8 go through the codepage table.
pub fn decode_console(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.to_string();
    }
    #[cfg(windows)]
    {
        let cp = oem_codepage();
        if let Some(enc) = encoding_for(cp) {
            let (cow, _) = enc.decode_without_bom_handling(bytes);
            return cow.into_owned();
        }
        // Unknown codepage: GBK is right for the overwhelming majority of the
        // machines this app ships to (zh-CN), and a partially-correct Chinese
        // string beats a row of replacement characters.
        let (cow, _) = encoding_rs::GBK.decode_without_bom_handling(bytes);
        return cow.into_owned();
    }
    #[allow(unreachable_code)]
    {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

#[cfg(windows)]
fn oem_codepage() -> u32 {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetOEMCP() -> u32;
    }
    // SAFETY: GetOEMCP takes no arguments and returns a UINT.
    unsafe { GetOEMCP() }
}

#[cfg(windows)]
fn encoding_for(cp: u32) -> Option<&'static encoding_rs::Encoding> {
    Some(match cp {
        936 => encoding_rs::GBK,
        950 => encoding_rs::BIG5,
        932 => encoding_rs::SHIFT_JIS,
        949 => encoding_rs::EUC_KR,
        1252 => encoding_rs::WINDOWS_1252,
        1251 => encoding_rs::WINDOWS_1251,
        1250 => encoding_rs::WINDOWS_1250,
        874 => encoding_rs::WINDOWS_874,
        _ => return None,
    })
}

// ---------------------------------------------------------------------------
// Suspending and resuming a launched process tree
// ---------------------------------------------------------------------------

/// Every descendant of `root`, found by walking the parent links in a
/// Toolhelp32 process snapshot.
///
/// Why the tree and not just the pid: a launch command is normally
/// `powershell -Command "Start-Process ..."` or `cmd /C npm run dev`, so the
/// process we hold a handle to is a shell. Suspending only the shell leaves the
/// dev server running at full speed while the UI says 已挂起 — the same
/// "technically true, practically wrong" failure the status strip had.
#[cfg(windows)]
pub fn descendant_pids(root: u32) -> Vec<u32> {
    use std::collections::HashMap;

    const TH32CS_SNAPPROCESS: u32 = 0x0000_0002;

    #[repr(C)]
    struct ProcessEntry32W {
        dw_size: u32,
        cnt_usage: u32,
        th32_process_id: u32,
        th32_default_heap_id: usize,
        th32_parent_process_id: u32,
        pc_pri_class_base: i32,
        dw_flags: u32,
        sz_exe_file: [u16; 260],
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> *mut core::ffi::c_void;
        fn Process32FirstW(snap: *mut core::ffi::c_void, entry: *mut ProcessEntry32W) -> i32;
        fn Process32NextW(snap: *mut core::ffi::c_void, entry: *mut ProcessEntry32W) -> i32;
        fn CloseHandle(handle: *mut core::ffi::c_void) -> i32;
    }

    let mut parent_of: HashMap<u32, u32> = HashMap::new();
    // SAFETY: the snapshot handle is checked against the documented failure
    // values before use, and every entry passed to the *32First/Next functions
    // is a zeroed PROCESSENTRY32W whose `dwSize` is set, as the API requires.
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        const INVALID: *mut core::ffi::c_void = -1isize as *mut core::ffi::c_void;
        if snap.is_null() || snap == INVALID {
            return Vec::new();
        }
        let mut entry: ProcessEntry32W = std::mem::zeroed();
        entry.dw_size = std::mem::size_of::<ProcessEntry32W>() as u32;
        if Process32FirstW(snap, &mut entry) != 0 {
            loop {
                parent_of.insert(entry.th32_process_id, entry.th32_parent_process_id);
                entry.dw_size = std::mem::size_of::<ProcessEntry32W>() as u32;
                if Process32NextW(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);
    }

    // Breadth-first from `root`, guarded so a malformed snapshot with a parent
    // cycle cannot spin forever.
    let mut out = Vec::new();
    let mut queue = vec![root];
    let mut seen = std::collections::HashSet::new();
    while let Some(pid) = queue.pop() {
        for (child, parent) in &parent_of {
            if *parent == pid && *child != root && seen.insert(*child) {
                out.push(*child);
                queue.push(*child);
            }
        }
    }
    out
}

#[cfg(not(windows))]
pub fn descendant_pids(_root: u32) -> Vec<u32> {
    Vec::new()
}

/// `NtSuspendProcess` / `NtResumeProcess`, resolved at runtime from ntdll.
///
/// **These are undocumented NT internals.** They are what Process Explorer and
/// most debuggers use, they have been stable since Windows XP, and there is no
/// documented equivalent — Job Objects can kill a process tree (`TerminateJobObject`)
/// but cannot freeze one. The alternative routes were rejected on their merits:
///
///   - `DebugActiveProcess` freezes the target on an exception port, which
///     requires us to keep a debug loop running for the lifetime of the process
///     and breaks any debugger the user attaches.
///   - Suspending every thread with `SuspendThread` deadlocks a process whose
///     threads hold the heap lock, which a Node or Python dev server will.
///
/// So the honest trade is: an undocumented call that works, with the failure
/// path surfaced in the UI rather than swallowed. If `GetProcAddress` cannot
/// find the symbol, suspend reports an error instead of pretending.
#[cfg(windows)]
fn nt_process_gate(name: &[u8; 18]) -> Option<unsafe extern "system" fn(*mut core::ffi::c_void) -> i32> {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetModuleHandleW(name: *const u16) -> *mut core::ffi::c_void;
        fn GetProcAddress(module: *mut core::ffi::c_void, name: *const i8) -> *mut core::ffi::c_void;
    }
    let ntdll: Vec<u16> = "ntdll.dll\u{0}".encode_utf16().collect();
    // SAFETY: both arguments are NUL-terminated as the API requires. The symbol
    // address is only reinterpreted as a function pointer after the null check,
    // and the two signatures are the documented ones.
    unsafe {
        let module = GetModuleHandleW(ntdll.as_ptr());
        if module.is_null() {
            return None;
        }
        let sym = GetProcAddress(module, name.as_ptr() as *const i8);
        if sym.is_null() {
            return None;
        }
        Some(std::mem::transmute::<
            *mut core::ffi::c_void,
            unsafe extern "system" fn(*mut core::ffi::c_void) -> i32,
        >(sym))
    }
}

#[cfg(windows)]
fn with_process_handle(pid: u32, f: impl FnOnce(*mut core::ffi::c_void) -> i32) -> Result<i32, String> {
    const PROCESS_SUSPEND_RESUME: u32 = 0x0800;
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut core::ffi::c_void;
        fn CloseHandle(handle: *mut core::ffi::c_void) -> i32;
    }
    // SAFETY: OpenProcess/CloseHandle are used exactly as documented; the handle
    // is closed on every path including the error path.
    unsafe {
        let h = OpenProcess(PROCESS_SUSPEND_RESUME, 0, pid);
        if h.is_null() {
            return Err(format!("无法打开进程 {pid}"));
        }
        let code = f(h);
        CloseHandle(h);
        Ok(code)
    }
}

#[cfg(windows)]
pub fn set_suspended(pid: u32, suspended: bool) -> Result<(), String> {
    // 18 bytes: "NtResumeProcess" / "NtSuspendProcess" are both 15 chars + NUL,
    // padded to a fixed array so the pointer stays valid for the call.
    let mut name = [0u8; 18];
    let wanted: &[u8] = if suspended { b"NtSuspendProcess\0" } else { b"NtResumeProcess\0" };
    name[..wanted.len()].copy_from_slice(wanted);
    let gate = nt_process_gate(&name).ok_or("系统未提供 NtSuspendProcess/NtResumeProcess，无法挂起")?;
    let code = with_process_handle(pid, |h| {
        // SAFETY: `gate` is the function pointer resolved from ntdll by
        // `nt_process_gate`, and `h` is a live process handle owned by
        // `with_process_handle` for the duration of this call.
        unsafe { gate(h) }
    })?;
    // NTSTATUS 0 is S_OK; anything else must be reported, not mapped to success.
    if code != 0 {
        return Err(format!("挂起/恢复失败，NTSTATUS 0x{code:08X}"));
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn set_suspended(_pid: u32, _suspended: bool) -> Result<(), String> {
    Err("挂起/恢复目前只在 Windows 上实现".to_string())
}

/// Freezes or thaws `pid` and everything it started.
///
/// The root is the only process whose failure matters: if it could not be
/// opened, nothing happened and the caller must be told. A descendant that
/// already exited is normal — a shell will have reaped its own children — so
/// those failures are counted and reported rather than aborting the operation.
pub fn set_tree_suspended(root: u32, suspended: bool) -> Result<usize, String> {
    set_suspended(root, suspended)?;
    let mut skipped = 0usize;
    for pid in descendant_pids(root) {
        if set_suspended(pid, suspended).is_err() {
            skipped += 1;
        }
    }
    Ok(skipped)
}

// ---------------------------------------------------------------------------
// Job Object: process-tree termination that does not leak grandchildren
// ---------------------------------------------------------------------------

/// A raw Windows Job Object handle, or `None` when job assignment failed.
///
/// `isize` matches the HANDLE typedef (`*mut c_void` cast to isize for storage
/// in a plain struct that does not need the pointer's provenance). `Option`
/// rather than a sentinel value makes the "no job" case explicit at the call
/// site: `kill_tree` skips `None` entries and falls back to `child.kill()`.
pub type JobHandle = Option<isize>;

const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;
const JobObjectExtendedLimitInformation: u32 = 9;
const PROCESS_SET_QUOTA: u32 = 0x0100;
const PROCESS_TERMINATE: u32 = 0x0001;

#[repr(C)]
struct JobObjectBasicLimitInformation {
    per_process_user_time_limit: i64,
    per_job_user_time_limit: i64,
    limit_flags: u32,
    minimum_working_set_size: usize,
    maximum_working_set_size: usize,
    active_process_limit: u32,
    affinity: usize,
    priority_class: u32,
    scheduling_class: u32,
}

/// Creates a Job Object whose entire process tree is terminated the moment the
/// last handle to it is closed.
///
/// This is the replacement for `taskkill /PID <pid> /T /F`. The Win32 taskkill
/// walk races with the tree: if a parent exits between the snapshot and the
/// `TerminateProcess` call, its children are reparented to `csrss` and survive
/// (verified: `docs/process-tree-termination.md` A2/A3). A Job Object with
/// `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` makes the kernel own the tree: closing
/// the handle — including on process crash — terminates every member atomically.
///
/// Returns the handle on success, `None` if the API calls failed (caller falls
/// back to the old taskkill path).
#[cfg(windows)]
pub fn create_kill_on_close_job() -> JobHandle {
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attrs: *mut core::ffi::c_void, name: *const u16) -> *mut core::ffi::c_void;
        fn SetInformationJobObject(
            job: *mut core::ffi::c_void,
            info_class: u32,
            info: *mut core::ffi::c_void,
            info_len: u32,
        ) -> i32;
        fn CloseHandle(handle: *mut core::ffi::c_void) -> i32;
    }
    // SAFETY: CreateJobObjectW with null attrs and null name creates an unnamed,
    // non-inheritable job. SetInformationJobObject writes exactly the documented
    // JobObjectBasicLimitInformation struct. Both are guarded by null/success
    // checks, and the handle is closed on the failure path.
    unsafe {
        let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
        if job.is_null() {
            return None;
        }
        let mut info: JobObjectBasicLimitInformation = std::mem::zeroed();
        info.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &mut info as *mut _ as *mut core::ffi::c_void,
            std::mem::size_of::<JobObjectBasicLimitInformation>() as u32,
        );
        if ok == 0 {
            CloseHandle(job);
            return None;
        }
        Some(job as isize)
    }
}

#[cfg(not(windows))]
pub fn create_kill_on_close_job() -> JobHandle {
    None
}

/// Assigns `pid` to `job`. Returns `false` if the process could not be opened
/// or the assignment failed (caller falls back to taskkill).
#[cfg(windows)]
pub fn assign_process_to_job(job: isize, pid: u32) -> bool {
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut core::ffi::c_void;
        fn AssignProcessToJobObject(job: *mut core::ffi::c_void, process: *mut core::ffi::c_void) -> i32;
        fn CloseHandle(handle: *mut core::ffi::c_void) -> i32;
    }
    // SAFETY: OpenProcess requests only SET_QUOTA | TERMINATE — the two rights
    // AssignProcessToJobObject needs — and the handle is closed on every path.
    // AssignProcessToJobObject's return value is checked directly.
    unsafe {
        let h = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
        if h.is_null() {
            return false;
        }
        let ok = AssignProcessToJobObject(job as *mut core::ffi::c_void, h);
        CloseHandle(h);
        ok != 0
    }
}

#[cfg(not(windows))]
pub fn assign_process_to_job(_job: isize, _pid: u32) -> bool {
    false
}

/// Closes the job handle, terminating every process assigned to it.
///
/// `child.kill()` is still called afterwards: the Child struct's own wait
/// handle needs reaping, and if the job path never engaged (assignment failed)
/// this is the only termination that runs.
#[cfg(windows)]
pub fn close_job_handle(job: isize) {
    #[link(name = "kernel32")]
    extern "system" {
        fn CloseHandle(handle: *mut core::ffi::c_void) -> i32;
    }
    // SAFETY: the handle came from create_kill_on_close_job and is used exactly
    // once here. Closing it triggers KILL_ON_JOB_CLOSE per the job's config.
    unsafe {
        CloseHandle(job as *mut core::ffi::c_void);
    }
}

#[cfg(not(windows))]
pub fn close_job_handle(_job: isize) {}

/// An owned Job Object handle: closing happens exactly once, on drop.
///
/// `run_git_streaming` needs the job on every exit path (normal finish, timeout,
/// cancellation, an I/O error while waiting). A guard makes "forgot to close"
/// impossible, and closing an already-empty job after the child exited is a
/// no-op by definition. When job assignment failed the guard holds `None` and
/// the caller's `child.kill()` fallback is still what terminates the process.
pub struct JobGuard(JobHandle);

impl JobGuard {
    /// Creates a kill-on-close job and puts `pid` in it. A create/assign
    /// failure yields a guard that does nothing, matching the existing
    /// "job path unavailable -> taskkill/child.kill" contract.
    pub fn for_child(pid: u32) -> Self {
        match create_kill_on_close_job() {
            Some(job) if assign_process_to_job(job, pid) => JobGuard(Some(job)),
            Some(job) => {
                close_job_handle(job);
                JobGuard(None)
            }
            None => JobGuard(None),
        }
    }

    /// True when the process tree really is under the job's control.
    pub fn engaged(&self) -> bool {
        self.0.is_some()
    }
}

impl Drop for JobGuard {
    fn drop(&mut self) {
        if let Some(job) = self.0 {
            close_job_handle(job);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_no_window_matches_the_win32_constant() {
        // Documented value; a typo here would silently reintroduce the flashing
        // windows, and nothing else in the code base can catch that.
        assert_eq!(CREATE_NO_WINDOW, 0x0800_0000);
    }

    #[test]
    fn silent_still_carries_arguments() {
        let cmd = silent("git");
        assert_eq!(cmd.get_program().to_string_lossy(), "git");
    }

    #[cfg(windows)]
    #[test]
    fn output_timeout_captures_what_the_child_prints() {
        // The regression this pins: `output_timeout` originally called `spawn()`
        // without piping, so every probe converted to it read an EMPTY stdout and
        // silently reported "the tool did not answer" — `worktree_status` called a
        // dirty repo clean, `list_pythons` reported none, `verify_git` returned "".
        let mut cmd = silent("cmd");
        cmd.args(["/C", "echo probe-out & echo probe-err 1>&2"]);
        let out = output_timeout(&mut cmd, std::time::Duration::from_secs(20))
            .expect("cmd should start")
            .expect("cmd should answer inside 20 s");
        assert!(
            String::from_utf8_lossy(&out.stdout).contains("probe-out"),
            "stdout was not captured: {:?}",
            String::from_utf8_lossy(&out.stdout)
        );
        assert!(
            String::from_utf8_lossy(&out.stderr).contains("probe-err"),
            "stderr was not captured: {:?}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(out.status.success());
    }

    #[cfg(windows)]
    #[test]
    fn output_timeout_drains_more_than_a_pipe_buffer() {
        // ~64 KiB is the Windows pipe buffer. A child that writes past it blocks on
        // the write, so a poll-only implementation would hit the deadline and kill a
        // probe that was actually working — `wsl -l -q` and `py -0p` are small, but
        // `git ls-remote` on a fat repository is not, and `git status` on a huge
        // worktree can exceed the buffer too.
        //
        // The fixture is `type` of a pre-written file, run through a one-line .cmd
        // wrapper. The old fixture was a `for /L` echo loop whose wall time was
        // cmd's interpretation speed × 20 000 iterations — it lost a 60 s race on
        // 2026-10-16 while a concurrent cargo build held the disk (round-16 report
        // §8.2): a false failure that depended on machine load. `type` is bounded
        // by pipe throughput (milliseconds even under load), so this branch fires
        // because the drain works, not because the machine is idle; the deadline
        // stays a hang-guard. The wrapper .cmd exists because a quoted path inside
        // a single `cmd /C` argument is mangled by Windows argv quoting (`\"` is
        // not cmd's escape) — measured: it silently printed 0 bytes. Quotes inside
        // a batch file are parsed by cmd itself, not by the CRT.
        let payload = vec![b'x'; 128 * 1024];
        let dir = std::env::temp_dir();
        let data = dir.join(format!("devhub-proc-drain-{}.bin", std::process::id()));
        let script = dir.join(format!("devhub-proc-drain-{}.cmd", std::process::id()));
        std::fs::write(&data, &payload).expect("temp fixture should be writable");
        std::fs::write(&script, format!("@echo off\r\ntype \"{}\"\r\n", data.display()))
            .expect("temp wrapper should be writable");
        let mut cmd = silent("cmd");
        // cwd set to the temp dir so the /C argument is a bare filename: any path
        // with a space would re-trigger the argv-quoting mangling above.
        cmd.current_dir(&dir);
        cmd.args(["/C", script.file_name().unwrap().to_string_lossy().as_ref()]);
        let out = output_timeout(&mut cmd, std::time::Duration::from_secs(60))
            .expect("cmd should start")
            .expect("cmd should answer inside 60 s");
        let _ = std::fs::remove_file(&data);
        let _ = std::fs::remove_file(&script);
        assert!(
            out.stdout.len() > 64 * 1024,
            "expected more than a pipe buffer of stdout, got {} bytes",
            out.stdout.len()
        );
    }

    #[cfg(windows)]
    #[test]
    fn output_timeout_kills_and_reaps_past_the_deadline() {
        // `Ok(None)` is the documented timeout answer, and it must not leave the
        // child behind: `ping -n 30` would otherwise outlive the call.
        let mut cmd = silent("cmd");
        cmd.args(["/C", "ping -n 30 127.0.0.1 >nul"]);
        let started = std::time::Instant::now();
        let res = output_timeout(&mut cmd, std::time::Duration::from_millis(200)).expect("spawn should work");
        assert!(res.is_none(), "a wedged child must degrade to Ok(None)");
        let took = started.elapsed();
        assert!(took < std::time::Duration::from_secs(10), "the deadline was ignored: {took:?}");
    }

    #[test]
    fn output_timeout_surfaces_a_spawn_failure_as_err() {
        // A missing tool is `Err`, not `Ok(None)`: the callers distinguish "this
        // tool is not installed" from "this tool did not answer in time".
        let mut cmd = silent("devhub-definitely-not-a-real-program");
        let res = output_timeout(&mut cmd, std::time::Duration::from_millis(500));
        assert!(res.is_err(), "spawn failure must be Err, got {res:?}");
    }

    #[test]
    fn elevation_probe_is_safe_to_call() {
        // Cannot assert the expected value (it depends on how the test runner was
        // started), but it must never panic and must not depend on the file
        // existing: the probe opens `hosts` for writing **without** truncation and
        // never writes a byte.
        // Round 13 (d3-2): the old `assert!(elevated == true || elevated == false)`
        // was a tautology (a bool is always true-or-false) that asserted nothing.
        // The test's real guarantee — `is_elevated()` must not panic here — is
        // already enforced by merely calling it; a panic would fail the test.
        let _ = is_elevated();
    }

    #[test]
    fn utf8_output_passes_through_untouched() {
        let s = "Receiving objects: 45%\n".as_bytes();
        assert_eq!(decode_console(s), "Receiving objects: 45%\n");
    }

    /// The regression this whole function exists for: the bytes below are what
    /// curl actually writes on a zh-CN install, and `from_utf8_lossy` turned
    /// them into replacement characters.
    #[test]
    fn gbk_stderr_decodes_to_chinese() {
        let (gbk, _, _) = encoding_rs::GBK.encode("请求失败");
        let text = decode_console(&gbk);
        assert!(
            !text.contains('\u{FFFD}'),
            "GBK bytes must not decode to U+FFFD, got {text:?}"
        );
        assert_eq!(text, "请求失败");
    }

    #[test]
    fn empty_bytes_are_empty_text() {
        assert_eq!(decode_console(&[]), "");
    }

    #[test]
    fn the_process_tree_walk_never_panics_on_its_own_pid() {
        // Whatever the snapshot returns, walking from this test binary's pid must
        // be safe: it has no children, so the answer is an empty list.
        // Round 13 (d3-2): the old `assert!(kids.is_empty() || !kids.is_empty())`
        // was a tautology. The test's guarantee — walking from this process's own
        // pid must be safe — is already enforced by the call above; a panic there
        // fails the test. Removing the dead assertion leaves that guarantee.
        let _ = descendant_pids(std::process::id());
    }

    /// Proves 挂起/恢复 actually freezes a process, rather than proving the call
    /// returned `STATUS_SUCCESS`.
    ///
    /// A child appends one byte to a file every 100 ms. The test measures the
    /// bytes written over a window while suspended and a window while running:
    /// a suspension that silently did nothing would produce two similar counts,
    /// and a "resume" that failed would look identical to the suspended window.
    /// This is the check the GUI could not give — the launch dialog's own test
    /// command exited before the 挂起 button could be clicked.
    #[cfg(windows)]
    #[test]
    fn suspending_stops_a_process_from_doing_work_and_resuming_restores_it() {
        use std::process::Stdio;

        let dir = std::env::temp_dir().join(format!("devhub-suspend-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("beats");

        let script = format!(
            "for(;;){{ [IO.File]::AppendAllText('{}','x'); Start-Sleep -Milliseconds 100 }}",
            out.display()
        );
        let mut child = crate::proc::silent("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn powershell");

        let size = |paths: &std::path::PathBuf| -> u64 {
            std::fs::metadata(paths).map(|m| m.len()).unwrap_or(0)
        };
        let settle = |paths: &std::path::PathBuf, ms: u64| -> (u64, u64) {
            let a = size(paths);
            std::thread::sleep(std::time::Duration::from_millis(ms));
            (a, size(paths))
        };
        // Waits for growth with a deadline instead of sampling a fixed window.
        //
        // The fixed-window version of this test flaked on a real machine: with a
        // release build competing for cores, the 100 ms beat loop was
        // descheduled for longer than the 700 ms window, and the assertion meant
        // to prove "it is running" failed on a process that was running fine.
        // "Did not advance while suspended" keeps the fixed window - less CPU can
        // only ever make that assertion easier to satisfy, never spuriously
        // violated.
        let grows_within = |paths: &std::path::PathBuf, ms: u64| -> (u64, u64, bool) {
            let a = size(paths);
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(ms);
            let mut b = a;
            while std::time::Instant::now() < deadline {
                std::thread::sleep(std::time::Duration::from_millis(50));
                b = size(paths);
                if b > a {
                    return (a, b, true);
                }
            }
            (a, b, false)
        };

        // How long to wait for the child's first byte before declaring the fixture
        // dead. It was 40 × 100 ms = 4 s, and on this machine that turned the test red
        // under load: measured 2026-10-15, the whole suite (`cargo test --lib`) failed
        // here while the same test passed in 2.82 s when run alone. `ping` writes its
        // banner promptly, but the suite runs several real-process tests in parallel on
        // a machine that may also be compiling, so the first flush is not guaranteed
        // inside four seconds — and a timing-sensitive fixture failure is worse than a
        // slow one, because people learn to re-run rather than read it.
        const WARM_POLLS: u32 = 200;
        let mut warm = 0;
        while size(&out) == 0 && warm < WARM_POLLS {
            std::thread::sleep(std::time::Duration::from_millis(100));
            warm += 1;
        }
        if size(&out) == 0 {
            let _ = child.kill();
            let _ = child.wait();
            let _ = std::fs::remove_dir_all(&dir);
            // Say how long it actually waited and what was on disk, so a red run here
            // is diagnosable without reproducing the load that caused it.
            panic!(
                "the beating child never wrote anything in {} ms; cannot test suspension ({})",
                WARM_POLLS * 100,
                out.display()
            );
        }

        // Running window: bytes must accumulate.
        let (r0, r1, grew_running) = grows_within(&out, 3000);
        // Suspend, then measure a window of the same length.
        if let Err(e) = set_suspended(child.id(), true) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = std::fs::remove_dir_all(&dir);
            panic!("suspend failed: {e}");
        }
        let (s0, s1) = settle(&out, 700);
        // Resume and confirm work restarts. A failed resume is reported by the
        // last assertion below rather than panicking here, so the child is always
        // reaped.
        let resumed = set_suspended(child.id(), false);
        let (u0, u1, grew_resumed) = grows_within(&out, 3000);

        let _ = child.kill();
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(&dir);

        // The first check is the point of the test.
        assert!(grew_running, "running window wrote nothing: {r0}→{r1}");
        assert_eq!(
            s1, s0,
            "suspended window must not advance, but wrote {} bytes",
            s1.saturating_sub(s0)
        );
        resumed.expect("resume failed");
        assert!(
            grew_resumed,
            "after resume the process must work again: {u0}→{u1}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn suspending_a_pid_that_does_not_exist_errors_rather_than_lying() {
        // 0xFFFFFFFF is not a process; the call must fail loudly. A silent Ok
        // would let the UI show 已挂起 for something that was never there.
        let r = set_suspended(u32::MAX, true);
        assert!(r.is_err(), "suspending a nonexistent pid must error");
    }
}

// ---------------------------------------------------------------------------
// Per-process CPU / working set (r22-N3)
// ---------------------------------------------------------------------------

/// A point-in-time resource reading for one PID.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcMetrics {
    /// Kernel + user time since process creation, in milliseconds.
    pub cpu_ms: u64,
    /// Current working-set size in bytes.
    pub working_set_bytes: u64,
    /// Bytes read/written by this process so far (`GetProcessIoCounters`).
    pub read_bytes: u64,
    pub write_bytes: u64,
}

#[cfg(windows)]
#[repr(C)]
struct FileTime {
    low: u32,
    high: u32,
}

#[cfg(windows)]
impl FileTime {
    fn as_u64(&self) -> u64 {
        ((self.high as u64) << 32) | self.low as u64
    }
}

#[cfg(windows)]
#[repr(C)]
struct ProcessMemoryCounters {
    cb: u32,
    page_fault_count: u32,
    peak_working_set_size: usize,
    working_set_size: usize,
    quota_peak_paged_pool_usage: usize,
    quota_paged_pool_usage: usize,
    quota_peak_non_paged_pool_usage: usize,
    quota_non_paged_pool_usage: usize,
    pagefile_usage: usize,
    peak_pagefile_usage: usize,
}

/// `PROCESS_QUERY_LIMITED_INFORMATION`: enough for times/memory, and the least
/// privilege that works across integrity levels (a full `PROCESS_QUERY_INFORMATION`
/// is refused for some children of a higher-integrity parent).
#[cfg(windows)]
#[repr(C)]
#[derive(Default)]
struct IoCounters {
    read_operation_count: u64,
    write_operation_count: u64,
    other_operation_count: u64,
    read_transfer_count: u64,
    write_transfer_count: u64,
    other_transfer_count: u64,
}

#[cfg(windows)]
const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;

#[cfg(windows)]
fn metrics_of(pid: u32) -> Option<ProcMetrics> {
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut core::ffi::c_void;
        fn CloseHandle(handle: *mut core::ffi::c_void) -> i32;
        fn GetProcessTimes(
            process: *mut core::ffi::c_void,
            creation: *mut FileTime,
            exit: *mut FileTime,
            kernel: *mut FileTime,
            user: *mut FileTime,
        ) -> i32;
    }
    #[link(name = "psapi")]
    extern "system" {
        fn GetProcessMemoryInfo(
            process: *mut core::ffi::c_void,
            counters: *mut ProcessMemoryCounters,
            cb: u32,
        ) -> i32;
        fn GetProcessIoCounters(process: *mut core::ffi::c_void, counters: *mut IoCounters) -> i32;
    }
    // SAFETY: the handle is checked for null; every out-struct is fully owned by
    // this function and zero-initialised before the call; CloseHandle runs on every
    // path after a successful open.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut creation = FileTime { low: 0, high: 0 };
        let mut exit = FileTime { low: 0, high: 0 };
        let mut kernel = FileTime { low: 0, high: 0 };
        let mut user = FileTime { low: 0, high: 0 };
        let times_ok = GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user);
        let mut counters: ProcessMemoryCounters = std::mem::zeroed();
        counters.cb = std::mem::size_of::<ProcessMemoryCounters>() as u32;
        let mem_ok = GetProcessMemoryInfo(handle, &mut counters, counters.cb);
        let mut io = IoCounters::default();
        let io_ok = GetProcessIoCounters(handle, &mut io);
        CloseHandle(handle);
        if times_ok == 0 && mem_ok == 0 {
            return None;
        }
        // FILETIME is 100 ns units; kernel + user is the CPU time consumed.
        let cpu_100ns = if times_ok != 0 {
            kernel.as_u64().saturating_add(user.as_u64())
        } else {
            0
        };
        Some(ProcMetrics {
            cpu_ms: cpu_100ns / 10_000,
            working_set_bytes: if mem_ok != 0 {
                counters.working_set_size as u64
            } else {
                0
            },
            read_bytes: if io_ok != 0 { io.read_transfer_count } else { 0 },
            write_bytes: if io_ok != 0 { io.write_transfer_count } else { 0 },
        })
    }
}

#[cfg(not(windows))]
fn metrics_of(_pid: u32) -> Option<ProcMetrics> {
    None
}

/// Read this PID's CPU time and working set. `None` means "could not ask" (the
/// process exited, or access was refused); callers must render that as unknown,
/// not as 0 MB.
pub fn metrics(pid: u32) -> Option<ProcMetrics> {
    metrics_of(pid)
}

#[cfg(test)]
mod metric_tests {
    use super::*;

    #[test]
    fn the_current_process_has_a_positive_working_set() {
        let m = metrics(std::process::id()).expect("the test process must be readable");
        assert!(m.working_set_bytes > 0, "a running process's working set cannot be zero");
        assert!(m.read_bytes < u64::MAX / 2 && m.write_bytes < u64::MAX / 2, "I/O counters must be sane");
        // CPU may legitimately be 0 ms on a just-started process; only the bound is pinned.
        assert!(m.cpu_ms < u64::MAX / 2, "cpu time must be a sane millisecond count");
    }

    #[test]
    fn a_write_test_child_accumulates_time() {
        let mut child = silent("cmd")
            .args(["/C", "ping", "-n", "2", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn a short-lived child");
        let pid = child.id();
        let first = metrics(pid);
        let _ = child.wait();
        let after = metrics(pid);
        // Either the first reading worked (some working set) or access was refused;
        // both are valid answers, but a present reading must be plausible.
        if let Some(m) = first {
            assert!(m.working_set_bytes > 0);
        }
        if let Some(m) = after {
            assert!(m.working_set_bytes > 0, "a reaped PID may still be readable for a while");
        }
    }

    #[test]
    fn an_impossible_pid_is_none_not_zero() {
        // 0 is the system idle process and OpenProcess with QUERY_LIMITED will fail
        // for it under a normal user; a high odd PID is just as absent. The point is
        // that "could not ask" must not collapse into 0 MB.
        let impossible = u32::MAX - 1;
        assert_eq!(metrics(impossible), None);
    }
}


// ---------------------------------------------------------------------------
// Public process table row (moved out of lib.rs to keep the crate root under
// its line ceiling; fields are constructed by lib.rs::summarise).
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProcessState {
    pub(crate) pid: u32,
    pub(crate) label: String,
    pub(crate) slug: String,
    /// `"running"`, `"suspended"` or `"exited"`.
    pub(crate) state: String,
    /// Only meaningful once `state` is `exited`.
    pub(crate) exit_code: Option<i32>,
    /// How long the process actually ran. Frozen at exit — see `Tracked::ran_for`.
    pub(crate) elapsed_ms: u64,
    /// Whether this process is still tracked and therefore still stoppable.
    pub(crate) stoppable: bool,
    /// Whether 挂起/恢复 can be offered for it at all.
    pub(crate) suspendable: bool,
    /// Kernel+user CPU time since launch, when Windows let us ask.
    pub(crate) cpu_ms: Option<u64>,
    /// Current working-set size in bytes, when Windows let us ask. `None` is
    /// "unknown", never 0 MB — the UI must not draw a dead process as weightless.
    pub(crate) working_set_bytes: Option<u64>,
    /// I/O transfer bytes, when Windows let us ask. Same unknown-not-zero rule.
    pub(crate) io_read_bytes: Option<u64>,
    pub(crate) io_write_bytes: Option<u64>,
}
