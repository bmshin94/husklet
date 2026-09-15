#![cfg(all(target_os = "linux", feature = "native-test-hooks"))]
#![allow(unsafe_code)]

use std::{
    ffi::CString,
    os::unix::{ffi::OsStrExt, fs::PermissionsExt},
    path::Path,
    process::{Command, Stdio},
};
use tempfile::TempDir;

fn classify(proc_root: &Path, pid: i32, private_fds: &[i32]) -> i32 {
    let root = CString::new(proc_root.as_os_str().as_bytes()).unwrap();
    hl_native::native_checkpoint_admission_test(&root, pid, private_fds)
}

fn wait_for_mapping(pid: i32, needle: &str) {
    for _ in 0..1000 {
        if std::fs::read_to_string(format!("/proc/{pid}/maps")).is_ok_and(|maps| maps.contains(needle)) {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    panic!("child {pid} did not map {needle}");
}

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

fn live_fixture(work: &Path) -> std::path::PathBuf {
    let source = work.join("wait.c");
    let executable = work.join("wait");
    std::fs::write(&source, b"#include <unistd.h>\nint main(void){for(;;) pause();}\n").unwrap();
    #[cfg(target_arch = "x86_64")]
    let compiler = "x86_64-linux-gnu-gcc";
    #[cfg(target_arch = "aarch64")]
    let compiler = "/usr/bin/cc";
    assert!(
        Command::new(compiler)
            .args(["-static", "-O2", "-o"])
            .arg(&executable)
            .arg(source)
            .status()
            .unwrap()
            .success()
    );
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o555)).unwrap();
    executable
}

fn fixture() -> (TempDir, i32) {
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
        // The lock gate reads per-descriptor lock attribution out of fdinfo, so the closed world
        // has to model it: an unlocked descriptor is one whose fdinfo carries no `lock:` line.
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

#[test]
fn synthetic_proc_fixture_is_closed_world() {
    let (work, pid) = fixture();
    let process = work.path().join(pid.to_string());
    assert_eq!(classify(work.path(), pid, &[]), 0);

    std::fs::write(process.join("task/4242/children"), b"9\n").unwrap();
    assert_ne!(classify(work.path(), pid, &[]), 0, "child");
    std::fs::write(process.join("task/4242/children"), b"\n").unwrap();

    std::fs::create_dir(process.join("task/4243")).unwrap();
    assert_ne!(classify(work.path(), pid, &[]), 0, "thread");
    std::fs::remove_dir(process.join("task/4243")).unwrap();

    std::os::unix::fs::symlink("socket:[7]", process.join("fd/9")).unwrap();
    assert_ne!(classify(work.path(), pid, &[]), 0, "unknown fd");
    assert_eq!(classify(work.path(), pid, &[9]), 0, "explicit private fd");
    std::fs::remove_file(process.join("fd/9")).unwrap();

    let safe_maps = std::fs::read(process.join("maps")).unwrap();
    std::fs::write(process.join("maps"), b"").unwrap();
    assert_ne!(classify(work.path(), pid, &[]), 0, "empty maps");
    for unsafe_map in [
        b"00400000-00401000 r-xp 00000000 08:01 1 /bin/app (deleted)\n".as_slice(),
        b"00400000-00401000 r-xs 00000000 08:01 1 /bin/app\n".as_slice(),
        b"00400000-00401000 rwxp 00000000 00:00 0\n".as_slice(),
        b"00400000-00401000 r--p 00000000 00:00 0 [unknown]\n".as_slice(),
    ] {
        std::fs::write(process.join("maps"), unsafe_map).unwrap();
        assert_ne!(classify(work.path(), pid, &[]), 0, "unsafe mapping");
    }
    std::fs::write(process.join("maps"), safe_maps).unwrap();
    std::fs::write(
        work.path().join("locks"),
        b"2: -> POSIX ADVISORY WRITE 9001 08:01:2 0 EOF\n",
    )
    .unwrap();
    assert_eq!(classify(work.path(), pid, &[]), 0, "unrelated blocked lock waiter");
    std::fs::write(
        work.path().join("locks"),
        b"1: POSIX ADVISORY WRITE 4242 08:01:1 0 EOF\n",
    )
    .unwrap();
    assert_ne!(classify(work.path(), pid, &[]), 0, "owned lock");
    std::fs::write(
        work.path().join("locks"),
        b"1: POSIX ADVISORY WRITE 9001 08:01:1 0 EOF\n2: -> POSIX ADVISORY WRITE 4242 08:01:1 0 EOF\n",
    )
    .unwrap();
    assert_ne!(classify(work.path(), pid, &[]), 0, "owned blocked lock waiter");
    std::fs::write(work.path().join("locks"), b"").unwrap();
    assert_eq!(classify(work.path(), pid, &[]), 0, "cleared lock table");

    // Per-descriptor attribution. An OFD lock is printed in the global table with owner pid -1,
    // because it belongs to the open file description rather than to a process, so the table can
    // never implicate this pid; fdinfo names it against the descriptor that reaches it.
    let unlocked = std::fs::read(process.join("fdinfo/1")).unwrap();
    for held in [
        b"lock:\t1: OFDLCK ADVISORY  WRITE -1 08:01:1 0 EOF\n".as_slice(),
        b"lock:\t1: POSIX  ADVISORY  WRITE 4242 08:01:1 0 EOF\n".as_slice(),
        b"lock:\t1: FLOCK  ADVISORY  WRITE 9001 08:01:1 0 EOF\n".as_slice(),
        b"lock:\t1: LEASE  ACTIVE    READ 4242 08:01:1 0 EOF\n".as_slice(),
    ] {
        let mut fdinfo = unlocked.clone();
        fdinfo.extend_from_slice(held);
        std::fs::write(process.join("fdinfo/1"), &fdinfo).unwrap();
        assert_ne!(classify(work.path(), pid, &[]), 0, "lock reachable through fd 1");
    }
    std::fs::write(process.join("fdinfo/1"), &unlocked).unwrap();
    assert_eq!(classify(work.path(), pid, &[]), 0, "fdinfo lock released");

    // A descriptor the supervisor declared private is not part of the workload -- the fd gate
    // already excludes it -- so a lock reachable only through it does not refuse the capture.
    std::os::unix::fs::symlink("/dev/null", process.join("fd/9")).unwrap();
    let mut private_fdinfo = unlocked.clone();
    private_fdinfo.extend_from_slice(b"lock:\t1: FLOCK  ADVISORY  READ 9001 08:01:1 0 EOF\n");
    std::fs::write(process.join("fdinfo/9"), &private_fdinfo).unwrap();
    assert_ne!(classify(work.path(), pid, &[]), 0, "lock on undeclared fd");
    assert_eq!(classify(work.path(), pid, &[9]), 0, "lock on declared private fd");
    std::fs::remove_file(process.join("fd/9")).unwrap();
    std::fs::remove_file(process.join("fdinfo/9")).unwrap();

    // Missing attribution is refused rather than assumed clean.
    std::fs::remove_file(process.join("fdinfo/1")).unwrap();
    assert_ne!(classify(work.path(), pid, &[]), 0, "unreadable fdinfo");
    std::fs::write(process.join("fdinfo/1"), &unlocked).unwrap();
    assert_eq!(classify(work.path(), pid, &[]), 0, "closed world restored");
}

#[test]
fn live_process_admits_only_before_unknown_descriptor() {
    let work = TempDir::new().unwrap();
    let executable = live_fixture(work.path());
    let mapped = executable.to_string_lossy();
    let mut child = Command::new(&executable)
        .env_clear()
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let pid = i32::try_from(child.id()).unwrap();
    wait_for_mapping(pid, &mapped);
    let inherited = harness_private_fds(pid);
    assert_eq!(classify(Path::new("/proc"), pid, &inherited), 0, "minimal live child");
    child.kill().unwrap();
    child.wait().unwrap();

    let mut extra = Command::new("/bin/sh")
        .args(["-c", &format!("exec 9</dev/null; exec {}", executable.display())])
        .env_clear()
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let pid = i32::try_from(extra.id()).unwrap();
    wait_for_mapping(pid, &mapped);
    let inherited = harness_private_fds(pid);
    assert_ne!(classify(Path::new("/proc"), pid, &inherited), 0, "unknown live fd");
    let mut recognized = inherited;
    recognized.push(9);
    assert_eq!(
        classify(Path::new("/proc"), pid, &recognized),
        0,
        "recognized private fd"
    );
    extra.kill().unwrap();
    extra.wait().unwrap();
}

#[test]
fn production_phase1_freezes_before_scan_and_thaws_refusal() {
    assert_eq!(classify(Path::new("phase1:test"), 0, &[]), 0);
}

#[test]
fn production_empty_allowlist_accepts_child_with_only_stdio() {
    assert_eq!(classify(Path::new("empty-fds:test"), 0, &[]), 0);
}

#[test]
fn native_domain_freeze_is_atomic_reversible_and_incarnation_safe() {
    assert_eq!(classify(Path::new("domain-freeze:test"), 0, &[]), 0);
}

/// Fixture source for the lock battery. It parks on `pause()` holding one lock flavour on
/// **fd 0**, which is the only production-reachable way to reach the lock gate: the fd gate
/// refuses every descriptor above 2 first.
///
/// Leak safety is built into the fixture itself rather than bolted on by the caller:
///   * it closes every inherited descriptor above 2 before parking, so a leaked child can
///     never pin the shared `/var/tmp/husklet-box.lock` the way an ordinary `pause()` child
///     would, and `harness_private_fds` consequently has nothing to allowlist; and
///   * it arms `alarm()` so an escaped child reaps itself even if the harness dies outright.
const LOCK_FIXTURE_SOURCE: &[u8] = br#"
#define _GNU_SOURCE
#include <fcntl.h>
#include <signal.h>
#include <string.h>
#include <stdio.h>
#include <sys/file.h>
#include <sys/prctl.h>
#include <unistd.h>

int main(int argc, char **argv) {
    if (argc != 4) return 2;
    const char *kind = argv[1], *lock_path = argv[2], *ready_path = argv[3];
    int fd = open(lock_path, O_RDWR | O_CREAT, 0644);
    if (fd < 0) return 3;
    if (dup2(fd, 0) < 0) return 4;
    if (fd != 0) close(fd);
    struct flock request;
    memset(&request, 0, sizeof request);
    request.l_type = F_WRLCK;
    request.l_whence = SEEK_SET;
    if (strcmp(kind, "posix") == 0) {
        if (fcntl(0, F_SETLK, &request) < 0) return 5;
    } else if (strcmp(kind, "ofd") == 0) {
        if (fcntl(0, F_OFD_SETLK, &request) < 0) return 6;
    } else if (strcmp(kind, "flock") == 0) {
        if (flock(0, LOCK_EX | LOCK_NB) < 0) return 7;
    } else if (strcmp(kind, "flock-inherited") == 0) {
        /* Take the lock, then fork. The child holds it through the shared open file description
         * while the global table keeps naming the parent as its owner. */
        if (flock(0, LOCK_EX | LOCK_NB) < 0) return 7;
        pid_t child = fork();
        if (child < 0) return 10;
        if (child == 0) {
            /* Die with the parent so the harness's kill of the parent reaps this too, and never
             * pin an inherited descriptor. */
            if (prctl(PR_SET_PDEATHSIG, SIGKILL) != 0) _exit(11);
            if (getppid() == 1) _exit(12);
            for (int extra = 3; extra < 4096; ++extra) close(extra);
            alarm(120);
            for (;;) pause();
        }
        for (int extra = 3; extra < 4096; ++extra) close(extra);
        char line[32];
        int written = snprintf(line, sizeof line, "%d", (int)child);
        int ready = open(ready_path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
        if (ready < 0) return 9;
        if (write(ready, line, (size_t)written) != written) return 13;
        close(ready);
        alarm(120);
        for (;;) pause();
    } else if (strcmp(kind, "none") != 0) {
        return 8;
    }
    for (int extra = 3; extra < 4096; ++extra) close(extra);
    int ready = open(ready_path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (ready < 0) return 9;
    close(ready);
    alarm(120);
    for (;;) pause();
}
"#;

fn lock_fixture(work: &Path) -> std::path::PathBuf {
    let source = work.join("lockwait.c");
    let executable = work.join("lockwait");
    std::fs::write(&source, LOCK_FIXTURE_SOURCE).unwrap();
    #[cfg(target_arch = "x86_64")]
    let compiler = "x86_64-linux-gnu-gcc";
    #[cfg(target_arch = "aarch64")]
    let compiler = "/usr/bin/cc";
    assert!(
        Command::new(compiler)
            .args(["-static", "-O2", "-o"])
            .arg(&executable)
            .arg(source)
            .status()
            .unwrap()
            .success()
    );
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o555)).unwrap();
    executable
}

/// Kills and reaps on every exit path, including panic unwind, so a failing assertion cannot
/// strand a parked fixture.
struct Reaped(std::process::Child);

impl Drop for Reaped {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn classify_lock_shape(executable: &Path, work: &Path, kind: &str, lock_file: &Path) -> i32 {
    let ready = work.join(format!("ready-{kind}"));
    let _ = std::fs::remove_file(&ready);
    let child = Command::new(executable)
        .arg(kind)
        .arg(lock_file)
        .arg(&ready)
        .env_clear()
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let child = Reaped(child);
    let pid = i32::try_from(child.0.id()).unwrap();
    let mut parked = false;
    for _ in 0..5000 {
        if std::fs::metadata(&ready).is_ok() {
            parked = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    assert!(parked, "{kind} fixture never parked");
    // The inherited shape reports the descendant that actually holds the lock through the shared
    // open file description; every other shape holds it itself.
    let pid = match std::fs::read_to_string(&ready).unwrap().trim() {
        "" => pid,
        reported => reported.parse::<i32>().unwrap(),
    };
    // The fixture closes every inherited descriptor above 2, so this must come back empty; if it
    // ever does not, the fixture is pinning the shared box lock and the leak guard has regressed.
    let inherited = harness_private_fds(pid);
    assert!(inherited.is_empty(), "{kind} fixture retained private fds {inherited:?}");
    classify(Path::new("/proc"), pid, &inherited)
}

/// A restored process cannot re-acquire a file lock, so the gate must refuse capture of any
/// process holding one. `/proc/locks` attributes an OFD lock to pid `-1` by construction -- the
/// lock belongs to the open file description, not to a process -- so owner-pid matching alone
/// cannot see it. This battery pins every flavour at once, and asserts its own non-vacuity so a
/// gate that simply refused everything would fail it too.
#[test]
fn native_checkpoint_refuses_every_self_held_lock_flavour() {
    const REFUSED_FOR_LOCKS: i32 = -5;
    let work = TempDir::new().unwrap();
    let executable = lock_fixture(work.path());

    // Every shape is classified before anything is asserted, so a failure reports the whole
    // matrix rather than stopping at the first flavour that regressed.
    let mut verdicts = Vec::new();
    for kind in ["posix", "flock", "ofd", "flock-inherited"] {
        let lock_file = work.path().join(format!("held-{kind}"));
        verdicts.push((kind, classify_lock_shape(&executable, work.path(), kind, &lock_file)));
    }
    for (kind, verdict) in &verdicts {
        println!("lock battery: {kind:<16} rc={verdict} (expected {REFUSED_FOR_LOCKS})");
    }
    let mut refusals = 0;
    for (kind, verdict) in &verdicts {
        assert_eq!(
            *verdict, REFUSED_FOR_LOCKS,
            "{kind} lock held on fd 0 must be refused by the lock gate, got {verdict}"
        );
        refusals += 1;
    }
    let mut admissions = 0;

    // Non-vacuity: the same fixture with no lock at all must still be admitted, so the battery
    // cannot be satisfied by a gate that refuses unconditionally.
    let unlocked = work.path().join("held-none");
    let verdict = classify_lock_shape(&executable, work.path(), "none", &unlocked);
    assert_eq!(verdict, 0, "unlocked fixture must remain admissible, got {verdict}");
    admissions += 1;

    // A lock held by a *different* process on a file this process merely has open is not this
    // process's lock, and must not be refused. The foreign holder is another instance of the same
    // fixture, so no `unsafe` is needed to take a real OFD lock from outside.
    let foreign = work.path().join("held-by-another");
    let foreign_ready = work.path().join("ready-foreign-holder");
    let _ = std::fs::remove_file(&foreign_ready);
    let holder = Reaped(
        Command::new(&executable)
            .arg("ofd")
            .arg(&foreign)
            .arg(&foreign_ready)
            .env_clear()
            .env("LC_ALL", "C")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let mut held = false;
    for _ in 0..5000 {
        if std::fs::metadata(&foreign_ready).is_ok() {
            held = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    assert!(held, "foreign OFD holder never parked");
    let verdict = classify_lock_shape(&executable, work.path(), "none", &foreign);
    assert_eq!(
        verdict, 0,
        "an OFD lock held by another process must not refuse this one, got {verdict}"
    );
    admissions += 1;
    drop(holder);

    assert!(
        refusals >= 4 && admissions >= 2,
        "battery must contain both refusals and admissions ({refusals} refusals, {admissions} admissions)"
    );
}

/// Reads the two pending-signal bitmasks out of a `/proc/<pid>/status` body.
fn pending_signal_fields(status: &str) -> (u64, u64) {
    let field = |name: &str| {
        status
            .lines()
            .find_map(|line| line.strip_prefix(name))
            .and_then(|value| u64::from_str_radix(value.trim(), 16).ok())
            .unwrap_or_else(|| panic!("missing {name} in status"))
    };
    (field("SigPnd:"), field("ShdPnd:"))
}

/// A process with queued signals must be refused, because the NativeX86V1 image cannot hold them.
///
/// Measured before this gate existed: a fixture blocking SIGUSR1 and SIGRTMIN and queueing one
/// SIGUSR1 plus three SIGRTMIN with distinct payloads parked at `ShdPnd=0000000200000200`, was
/// captured and restored into a fresh process, and came back with `SigBlk` intact but
/// `ShdPnd=0000000000000000`; unblocking delivered none of the four. Capture reads only
/// `PTRACE_GETSIGMASK`, and no interface outside the process can enumerate a pending queue with its
/// multiplicity and `siginfo`, so a refusal is the only honest outcome.
///
/// Non-vacuity is asserted inside the battery: every refusal below is bracketed by an admission of
/// the same fixture with the pending fields cleared, so a gate that refused everything fails here.
#[test]
fn queued_signals_refuse_capture_and_a_quiescent_process_still_admits() {
    let (work, pid) = fixture();
    let process = work.path().join(pid.to_string());
    let status = process.join("status");
    let quiet = std::fs::read_to_string(&status).unwrap();
    assert_eq!(pending_signal_fields(&quiet), (0, 0), "baseline fixture is quiescent");

    // Admission half: nothing pending, and a non-zero blocked mask alone is not a refusal. The image
    // does carry the mask, so blocking signals without queueing any stays capturable.
    assert_eq!(classify(work.path(), pid, &[]), 0, "quiescent synthetic process");
    std::fs::write(&status, quiet.replace("SigBlk:\t0000000000000000", "SigBlk:\t0000000200000200")).unwrap();
    assert_eq!(classify(work.path(), pid, &[]), 0, "blocked mask without a queue is capturable");
    std::fs::write(&status, &quiet).unwrap();

    // Refusal half. Each case is followed by a restore-and-readmit, so the gate is shown to be
    // reacting to the pending fields and not simply refusing this fixture outright.
    for (field, value, what) in [
        ("SigPnd:\t0000000000000000", "SigPnd:\t0000000000000200", "thread-directed SIGUSR1"),
        ("ShdPnd:\t0000000000000000", "ShdPnd:\t0000000000000200", "process-directed SIGUSR1"),
        ("ShdPnd:\t0000000000000000", "ShdPnd:\t0000000200000000", "process-directed SIGRTMIN"),
        ("ShdPnd:\t0000000000000000", "ShdPnd:\t0000000200000200", "a mixed standard and RT queue"),
        ("SigPnd:\t0000000000000000", "SigPnd:\t8000000000000000", "the highest-numbered signal"),
    ] {
        std::fs::write(&status, quiet.replace(field, value)).unwrap();
        assert_ne!(classify(work.path(), pid, &[]), 0, "{what} must refuse capture");
        std::fs::write(&status, &quiet).unwrap();
        assert_eq!(classify(work.path(), pid, &[]), 0, "readmitted once {what} is cleared");
    }

    // The gate must never admit by default when it cannot read the evidence.
    for malformed in [
        quiet.replace("ShdPnd:\t0000000000000000\n", ""),
        quiet.replace("SigPnd:\t0000000000000000\n", ""),
        quiet.replace("SigPnd:\t0000000000000000", "SigPnd:\tnot-a-mask"),
        quiet.replace("SigPnd:\t0000000000000000", "SigPnd:\t0000000000000000 trailing"),
    ] {
        std::fs::write(&status, &malformed).unwrap();
        assert_ne!(classify(work.path(), pid, &[]), 0, "unreadable pending fields must refuse");
    }
    std::fs::remove_file(&status).unwrap();
    assert_ne!(classify(work.path(), pid, &[]), 0, "absent status must refuse");
    std::fs::write(&status, &quiet).unwrap();
    assert_eq!(classify(work.path(), pid, &[]), 0, "battery ends on an admission");
}

/// The live half. A refusal that also refused ordinary capturable processes would be a regression
/// dressed as a fix, so this pairs a real parked process carrying a queued signal (must refuse) with
/// an otherwise identical parked process carrying none (must still admit), including while
/// group-stopped, which is the state the phase-1 freeze leaves a member in before this scan runs.
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

fn parked_fixture(work: &Path) -> std::path::PathBuf {
    let source = work.join("parked.c");
    let executable = work.join("parked");
    // Leak-proof by construction: dies with the harness, inherits no descriptor above stderr, and
    // self-terminates if it is ever orphaned past the alarm.
    std::fs::write(
        &source,
        br#"#include <signal.h>
#include <string.h>
#include <unistd.h>
#include <sys/prctl.h>
int main(int argc, char **argv) {
    prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0);
    for (int fd = 3; fd < 1024; ++fd) close(fd);
    alarm(120);
    /* Both roles block SIGUSR1. SigBlk becoming non-zero is the harness's barrier that main has run
       past the close loop above, so classification can never race the inherited descriptors. */
    sigset_t blocked;
    sigemptyset(&blocked);
    sigaddset(&blocked, SIGUSR1);
    sigprocmask(SIG_BLOCK, &blocked, 0);
    if (argc > 1 && strcmp(argv[1], "pending") == 0) {
        union sigval value;
        value.sival_int = 0x5a;
        sigqueue(getpid(), SIGUSR1, value);
    }
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
            .status()
            .unwrap()
            .success()
    );
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o555)).unwrap();
    executable
}

/// Waits for the fixture to reach its blocked mask (the barrier proving `main` closed the inherited
/// descriptors) and, for the queueing role, for the signal to actually be pending.
fn await_pending(pid: i32, want_pending: bool) -> (u64, u64) {
    for _ in 0..5000 {
        if let Ok(status) = std::fs::read_to_string(format!("/proc/{pid}/status")) {
            let blocked = status
                .lines()
                .find_map(|line| line.strip_prefix("SigBlk:"))
                .and_then(|value| u64::from_str_radix(value.trim(), 16).ok())
                .unwrap_or(0);
            let fields = pending_signal_fields(&status);
            if blocked != 0 && ((fields.0 | fields.1) != 0) == want_pending {
                return fields;
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    panic!("process {pid} never reached want_pending={want_pending}");
}

#[test]
fn live_parked_process_refuses_with_a_queued_signal_and_admits_without_one() {
    let work = TempDir::new().unwrap();
    let executable = parked_fixture(work.path());
    let mapped = executable.to_string_lossy().into_owned();
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
        wait_for_mapping(pid, &mapped);
        pid
    };

    let quiet = spawn("quiet");
    let (quiet_private, quiet_shared) = await_pending(quiet, false);
    assert_eq!((quiet_private, quiet_shared), (0, 0));
    assert_eq!(classify(Path::new("/proc"), quiet, &[]), 0, "quiescent live process admits");

    // The production scan runs against a frozen member, so prove the freeze itself leaves nothing
    // pending. If SIGSTOP left a bit set, this gate would refuse every real checkpoint.
    assert_eq!(unsafe { libc::kill(quiet, libc::SIGSTOP) }, 0);
    let (stopped_private, stopped_shared) = await_pending(quiet, false);
    assert_eq!(
        (stopped_private, stopped_shared),
        (0, 0),
        "group-stop must not leave a signal pending"
    );
    assert_eq!(
        classify(Path::new("/proc"), quiet, &[]),
        0,
        "group-stopped quiescent process still admits"
    );
    assert_eq!(unsafe { libc::kill(quiet, libc::SIGCONT) }, 0);

    let pending = spawn("pending");
    let (pending_private, pending_shared) = await_pending(pending, true);
    assert_eq!(
        (pending_private, pending_shared),
        (0, 1 << (libc::SIGUSR1 - 1)),
        "a process-directed sigqueue lands in ShdPnd, not SigPnd"
    );
    assert_ne!(
        classify(Path::new("/proc"), pending, &[]),
        0,
        "live process with a queued SIGUSR1 must refuse capture"
    );
}
