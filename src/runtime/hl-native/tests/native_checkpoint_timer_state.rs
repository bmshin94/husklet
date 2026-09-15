//! The two native-checkpoint admission arms that exist because timer and
//! alternate-signal-stack state cannot be carried in the image.
//!
//! Arm `-7` is the supervisor's sticky taint, which is the only observation
//! point that exists for `sigaltstack` and the interval timers: measured on this
//! host, an armed process and a free one are byte-identical everywhere in
//! `/proc/<pid>` (`itrealvalue` reads 0 in both arms with `ITIMER_REAL` armed at
//! 7200 s, and `/proc/<pid>/timers` is empty in both), so no state read can tell
//! them apart and only the syscall request can.
//!
//! Arm `-8` is a direct state read, because POSIX timers -- unlike the other two
//! -- *are* published: a process holding one armed `CLOCK_MONOTONIC` timer shows
//! `ID: 0 ...` in `/proc/<pid>/timers` and a free one shows nothing.
//!
//! These live in their own test binary on purpose.  The taint is a process-wide
//! flag inside the loaded native library, and the hook below sets it for the
//! length of its own check; a test in another binary cannot observe that window,
//! and the mutex keeps the two here from observing each other's.
#![cfg(all(target_os = "linux", feature = "native-test-hooks"))]
#![allow(unsafe_code)]

use std::{
    ffi::CString,
    os::unix::{ffi::OsStrExt, fs::PermissionsExt},
    path::Path,
    process::{Command, Stdio},
};
use tempfile::TempDir;

/// Serialises the two tests: one of them deliberately sets the process-wide
/// taint, and while it is set every classification in this process refuses.
static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn classify(proc_root: &Path, pid: i32, private_fds: &[i32]) -> i32 {
    let root = CString::new(proc_root.as_os_str().as_bytes()).unwrap();
    hl_native::native_checkpoint_admission_test(&root, pid, private_fds)
}

/// The supervisor's own announce/box descriptors are declared private in
/// production; the harness declares its equivalent here so the descriptor gate
/// does not refuse first and mask the arm under test.
fn harness_private_fds(pid: i32) -> Vec<i32> {
    std::fs::read_dir(format!("/proc/{pid}/fd"))
        .unwrap()
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let fd = entry.file_name().to_string_lossy().parse::<i32>().ok()?;
            let target = std::fs::read_link(entry.path()).ok()?;
            (fd > 2 && target == Path::new("/var/tmp/husklet-box.lock")).then_some(fd)
        })
        .collect()
}

struct ReapedPids(Vec<i32>);

impl Drop for ReapedPids {
    fn drop(&mut self) {
        for pid in self.0.drain(..) {
            unsafe {
                libc::kill(pid, libc::SIGKILL);
                libc::waitpid(pid, std::ptr::null_mut(), 0);
            }
        }
    }
}

/// Parks holding one POSIX timer or none.  Leak-proof by construction: it dies
/// with the harness, inherits no descriptor above stderr, and self-terminates if
/// it is ever orphaned.
fn timer_fixture(work: &Path) -> std::path::PathBuf {
    let source = work.join("timer.c");
    let executable = work.join("timer");
    std::fs::write(
        &source,
        br#"#include <signal.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <sys/prctl.h>
int main(int argc, char **argv) {
    prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0);
    for (int fd = 3; fd < 1024; ++fd) close(fd);
    if (argc > 1 && strcmp(argv[1], "posix") == 0) {
        struct sigevent event;
        memset(&event, 0, sizeof event);
        event.sigev_notify = SIGEV_SIGNAL;
        event.sigev_signo = SIGUSR2;
        timer_t timer;
        if (timer_create(CLOCK_MONOTONIC, &event, &timer) != 0) return 1;
        struct itimerspec spec;
        memset(&spec, 0, sizeof spec);
        spec.it_value.tv_sec = 7200;
        if (timer_settime(timer, 0, &spec, 0) != 0) return 2;
    }
    /* Blocking SIGUSR1 is the harness's barrier that main has run past the close
       loop above and past the timer, so a classification can never race either. */
    sigset_t blocked;
    sigemptyset(&blocked);
    sigaddset(&blocked, SIGUSR1);
    sigprocmask(SIG_BLOCK, &blocked, 0);
    for (;;) pause();
}
"#,
    )
    .unwrap();
    #[cfg(target_arch = "x86_64")]
    let compiler = "x86_64-linux-gnu-gcc";
    #[cfg(target_arch = "aarch64")]
    let compiler = "/usr/bin/cc";
    assert!(
        Command::new(compiler)
            .args(["-static", "-O2", "-o"])
            .arg(&executable)
            .arg(source)
            .arg("-lrt")
            .status()
            .unwrap()
            .success()
    );
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o555)).unwrap();
    executable
}

fn await_barrier(pid: i32) {
    for _ in 0..5000 {
        if std::fs::read_to_string(format!("/proc/{pid}/status")).is_ok_and(|status| {
            status
                .lines()
                .find_map(|line| line.strip_prefix("SigBlk:"))
                .and_then(|value| u64::from_str_radix(value.trim(), 16).ok())
                .is_some_and(|blocked| blocked != 0)
        }) {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    panic!("process {pid} never reached its blocked-mask barrier");
}

fn published_timers(pid: i32) -> String {
    std::fs::read_to_string(format!("/proc/{pid}/timers")).unwrap_or_default()
}

/// A closed synthetic `/proc` that every other admission arm accepts, so the one
/// under test is the only thing that can change the verdict.
fn admissible_fixture() -> (TempDir, i32) {
    let work = TempDir::new().unwrap();
    let pid = 4242;
    let process = work.path().join(pid.to_string());
    std::fs::create_dir_all(process.join("task/4242")).unwrap();
    std::fs::create_dir_all(process.join("fd")).unwrap();
    std::fs::create_dir_all(process.join("fdinfo")).unwrap();
    std::fs::create_dir_all(process.join("root/bin")).unwrap();
    std::fs::write(process.join("task/4242/children"), b"\n").unwrap();
    for descriptor in 0..=2 {
        std::os::unix::fs::symlink("/dev/null", process.join("fd").join(descriptor.to_string())).unwrap();
        std::fs::write(
            process.join("fdinfo").join(descriptor.to_string()),
            b"pos:\t0\nflags:\t0100002\nmnt_id:\t1\nino:\t1\n",
        )
        .unwrap();
    }
    let executable = process.join("root/bin/app");
    std::fs::write(&executable, b"elf").unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o555)).unwrap();
    std::fs::write(
        process.join("maps"),
        concat!(
            "00400000-00401000 r-xp 00000000 08:01 1 /bin/app\n",
            "00600000-00601000 rw-p 00000000 00:00 0 [heap]\n",
            "7fff0000-7fff1000 r-xp 00000000 00:00 0 [vdso]\n",
        ),
    )
    .unwrap();
    std::fs::write(
        process.join("status"),
        b"Name:\tapp\nState:\tT (stopped)\nSigBlk:\t0000000000000000\nSigPnd:\t0000000000000000\nShdPnd:\t0000000000000000\n",
    )
    .unwrap();
    std::fs::write(work.path().join("locks"), b"").unwrap();
    (work, pid)
}

/// Clears the process-wide mark however the test ends.
struct ClearTaint;

impl Drop for ClearTaint {
    fn drop(&mut self) {
        assert_eq!(classify(Path::new("taint:clear"), 0, &[]), 0);
    }
}

/// Arm `-7`: the taint classifier's answer for every syscall it knows, for the
/// argument shapes that cannot arm anything, and for a syscall outside the set --
/// then the gate arm itself flipping one otherwise-admissible process from `0` to
/// `-7` and back.  The C half returns the step that failed, so it names itself.
#[test]
fn the_taint_marks_only_syscalls_that_can_arm_state_no_scan_can_see() {
    let _serial = SERIAL.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    assert_eq!(
        classify(Path::new("taint:test"), 0, &[]),
        0,
        "the taint classifier answered wrongly at the step this number names"
    );

    let (work, pid) = admissible_fixture();
    assert_eq!(
        classify(work.path(), pid, &[]),
        0,
        "the fixture must be admissible before the mark, or the refusal below proves nothing"
    );
    let _clear = ClearTaint;
    assert_eq!(classify(Path::new("taint:set"), 0, &[]), 0);
    assert_eq!(
        classify(work.path(), pid, &[]),
        -7,
        "a marked domain was admitted; the restore would silently drop its alternate stack or timer"
    );
    drop(_clear);
    assert_eq!(
        classify(work.path(), pid, &[]),
        0,
        "the mark did not clear, so every later capture in this process would refuse"
    );
}

/// Arm `-8`: a real parked process holding one armed POSIX timer refuses, and an
/// otherwise identical one holding none still admits.
///
/// The pair is the whole point: a gate that refused both would be indisguishable
/// from this one on the refusing arm alone.
#[test]
fn a_live_process_holding_a_posix_timer_refuses_and_one_without_still_admits() {
    let _serial = SERIAL.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let work = TempDir::new().unwrap();
    let executable = timer_fixture(work.path());
    let mut reaped = ReapedPids(Vec::new());

    let mut spawn = |role: &str| {
        let child = Command::new(&executable)
            .arg(role)
            .env_clear()
            .env("LC_ALL", "C")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let pid = i32::try_from(child.id()).unwrap();
        std::mem::forget(child);
        reaped.0.push(pid);
        await_barrier(pid);
        pid
    };

    let quiet = spawn("quiet");
    let armed = spawn("posix");

    // The kernel's own view, quoted into the failure message, so a verdict that
    // disagrees with it is visible rather than merely asserted.
    let quiet_timers = published_timers(quiet);
    let armed_timers = published_timers(armed);
    assert!(
        quiet_timers.trim().is_empty(),
        "the control process published timers it never created: {quiet_timers:?}"
    );
    assert!(
        armed_timers.contains("ID:"),
        "the armed process published no POSIX timer, so this proves nothing: {armed_timers:?}"
    );

    assert_eq!(
        classify(Path::new("/proc"), quiet, &harness_private_fds(quiet)),
        0,
        "a parked process holding no timer must still be capturable"
    );
    assert_eq!(
        classify(Path::new("/proc"), armed, &harness_private_fds(armed)),
        -8,
        "a parked process holding {armed_timers:?} was admitted; the restore carries no timer section"
    );
}
