//! Native-supervised checkpoint: the kernel-side timer and alternate-signal-stack
//! state a `/proc` scan cannot see.
//!
//! `sigaltstack` and the interval timers have no external view at all (measured:
//! an armed `ITIMER_REAL` of 7200 s leaves `/proc/<pid>/stat` `itrealvalue` at 0
//! and `/proc/<pid>/timers` empty), so nothing a read-only preflight can look at
//! distinguishes an armed process from a free one.  A POSIX timer *is* published
//! in `/proc/<pid>/timers`, and a timerfd is an ordinary descriptor.  This file
//! pins all four: the two invisible ones refuse through the supervisor's sticky
//! taint, the POSIX timer refuses through a direct `/proc` read, and the timerfd
//! refuses through the descriptor gate that was already there.
#![cfg(all(target_os = "linux", target_arch = "x86_64"))]
// `kill(2)` is the only way to lift a group stop, and there is no safe wrapper
// for it; every call below names a pid this harness just read out of /proc.
#![allow(unsafe_code)]

use hl_engine::{
    activation::GuestIsa,
    composition::{
        CheckpointSink, CheckpointSource, CompositionError, StandardStream, StandardStreamPort, StandardStreams,
    },
    launcher::plan::{RuntimeBoxPolicy, RuntimePlan},
    options::Options,
    runtime::Engine,
};
use std::collections::BTreeMap;
use std::num::NonZeroU64;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tempfile::TempDir;

#[derive(Default)]
struct Output {
    stdout: Mutex<Vec<u8>>,
    stderr: Mutex<Vec<u8>>,
}

impl StandardStreamPort for Output {
    fn read(&self, _: &mut [u8]) -> std::io::Result<usize> {
        Ok(0)
    }
    fn write(&self, stream: StandardStream, input: &[u8]) -> std::io::Result<usize> {
        match stream {
            StandardStream::Stdout => self.stdout.lock().unwrap().extend_from_slice(input),
            StandardStream::Stderr => self.stderr.lock().unwrap().extend_from_slice(input),
        }
        Ok(input.len())
    }
    fn close(&self) {}
}

#[derive(Default)]
struct Store {
    state: Mutex<(BTreeMap<String, Vec<u8>>, BTreeMap<String, Vec<u8>>)>,
    commits: std::sync::atomic::AtomicUsize,
}

impl CheckpointSink for Store {
    fn replace(&self, manifest: &[u8]) -> Result<(), CompositionError> {
        self.state.lock().unwrap().0.insert("MANIFEST".into(), manifest.to_vec());
        Ok(())
    }
    fn begin_until(&self, _: std::time::Instant) -> Result<NonZeroU64, CompositionError> {
        self.state.lock().unwrap().1.clear();
        Ok(NonZeroU64::MIN)
    }
    fn put_until(
        &self,
        _: NonZeroU64,
        name: &str,
        bytes: &[u8],
        _: std::time::Instant,
    ) -> Result<(), CompositionError> {
        self.state.lock().unwrap().1.insert(name.into(), bytes.to_vec());
        Ok(())
    }
    fn abort_until(&self, _: NonZeroU64, _: std::time::Instant) -> Result<(), CompositionError> {
        self.state.lock().unwrap().1.clear();
        Ok(())
    }
    fn commit_until(&self, _: NonZeroU64, manifest: &[u8], _: std::time::Instant) -> Result<(), CompositionError> {
        let mut state = self.state.lock().unwrap();
        state.0 = std::mem::take(&mut state.1);
        state.0.insert("MANIFEST".into(), manifest.to_vec());
        self.commits.fetch_add(1, std::sync::atomic::Ordering::Release);
        Ok(())
    }
}

impl CheckpointSource for Store {
    fn read(&self, offset: usize) -> Result<Vec<u8>, CompositionError> {
        Ok(self
            .state
            .lock()
            .unwrap()
            .0
            .get("MANIFEST")
            .and_then(|bytes| bytes.get(offset..))
            .unwrap_or_default()
            .to_vec())
    }
    fn get_until(&self, name: &str, _: std::time::Instant) -> Result<Vec<u8>, CompositionError> {
        self.state
            .lock()
            .unwrap()
            .0
            .get(name)
            .cloned()
            .ok_or(CompositionError::RuntimeConstruction)
    }
    fn list_until(&self, _: std::time::Instant) -> Result<Vec<String>, CompositionError> {
        Ok(self.state.lock().unwrap().0.keys().cloned().collect())
    }
}

fn fixture(directory: &Path) -> PathBuf {
    let output = directory.join("native-timer-state");
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/native_timer_state.c");
    let status = std::process::Command::new("x86_64-linux-gnu-gcc")
        .args(["-static-pie", "-O2", "-o"])
        .arg(&output)
        .arg(source)
        .arg("-lrt")
        .status()
        .unwrap();
    assert!(status.success(), "fixture compile failed");
    output
}

fn plan(executable: &Path, identity: &str, variant: &str, restore: bool) -> RuntimePlan {
    assert_eq!(variant.len(), 4, "variant tokens must be equal length");
    assert_eq!(identity.len(), 16, "identity tokens must be equal length");
    let mut options = Options::default();
    options.set("HL_NATIVE_SUPERVISED", "1", true).unwrap();
    options.set("HL_C_DIAGNOSTICS", "1", true).unwrap();
    if restore {
        options.set("HL_RESTORE", "1", true).unwrap();
    }
    RuntimePlan {
        rootfs: Some(b"/".to_vec()),
        executable_host: Some(executable.as_os_str().as_encoded_bytes().to_vec()),
        arguments: vec![
            executable.as_os_str().as_encoded_bytes().to_vec(),
            identity.as_bytes().to_vec(),
            variant.as_bytes().to_vec(),
        ],
        environment: Vec::new(),
        result_path: None,
        options,
        box_policy: RuntimeBoxPolicy {
            flags: 1 << 2,
            ..Default::default()
        },
    }
}

fn wait_ready(output: &Output) {
    for _ in 0..20_000 {
        if output.stdout.lock().unwrap().as_slice() == b"timerstate-ready\n" {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(1));
    }
    panic!(
        "fixture never reported ready: {:?}",
        String::from_utf8_lossy(&output.stderr.lock().unwrap())
    );
}

fn line_of(output: &Output, prefix: &str) -> String {
    let text = String::from_utf8_lossy(&output.stdout.lock().unwrap()).into_owned();
    text.lines()
        .find(|line| line.starts_with(prefix))
        .unwrap_or_else(|| panic!("no {prefix:?} line in {text:?}"))
        .to_owned()
}

fn report_of(output: &Output) -> String {
    let text = String::from_utf8_lossy(&output.stdout.lock().unwrap()).into_owned();
    text.lines()
        .find(|line| line.starts_with("timerstate "))
        .unwrap_or_else(|| panic!("no timerstate report in {text:?}"))
        .to_owned()
}

/// Runs the fixture through the same engine with no checkpoint at all, and wakes
/// its park from outside.  This is the control: it proves the readout reports the
/// armed values when they really are armed.
fn control_report(executable: &Path, variant: &str) -> String {
    control_report_under(executable, variant, None)
}

/// `refuse` selects the supervisor's third BPF program (the refusal one), which
/// is otherwise unreachable from these arms; the syscall number it names is not
/// one the fixture issues, so the only thing it changes is which filter is built.
fn control_report_under(executable: &Path, variant: &str, refuse: Option<&str>) -> String {
    let output = Arc::new(Output::default());
    let mut plan = plan(executable, "0000000000000000", variant, false);
    if let Some(refuse) = refuse {
        plan.options.set("HL_NATIVE_SUPERVISED_REFUSE", refuse, true).unwrap();
    }
    let engine = Engine::with_streams(
        GuestIsa::X86_64,
        plan,
        StandardStreams::default().with_output(output.clone()),
    )
    .unwrap();
    engine.start().unwrap();
    wait_ready(&output);
    // Nothing else will wake this park: the whole point of the redesign is that
    // the fixture carries no timer of its own.
    let task = await_fixture_task(executable, &["0000000000000000"], variant);
    wait_parked(task, variant);
    wake_task(task, variant);
    let status = engine.wait().expect("control run result");
    engine.destroy().unwrap();
    assert_eq!(status.guest_status, 0, "control guest status for {variant}");
    // Under the filter this launch selected, the newly notified syscalls still do
    // exactly what the guest asked.  `alarm(4321)` replaces the 1234 s ITIMER_REAL
    // set the instruction before, which is the kernel's own semantics.
    assert_eq!(
        line_of(&output, "timerstate-late "),
        "timerstate-late altstack=1 realtimer=4321",
        "{variant}: a notified syscall did not take effect under this supervisor filter"
    );
    report_of(&output)
}

/// The kernel's own statement that a task is blocked in `pause(2)`.
///
/// `/proc/<pid>/syscall` names the syscall a stopped-in-kernel task is inside;
/// `34` is `__NR_pause` on x86-64.  This is the whole non-vacuity argument for
/// the park: a fixture that raced past its park, or that never got there, is not
/// in syscall 34 and this returns `None` until it times out.
const NR_PAUSE: &str = "34 ";

/// The one task of this test's fixture, found by the argv the kernel publishes.
///
/// Matching on `comm` would not work: the supervisor renames the guest task (it reports
/// `Name:\t65537`).  The executable path is a per-test temporary directory, so it names this
/// test's guest and no other.
///
/// Several identities are accepted on purpose: a restore target is launched under one and then has
/// the CAPTURED one written over its argv by the memory image, so insisting on a single value would
/// make the lookup race the event it exists to observe.
fn fixture_task(executable: &Path, identities: &[&str]) -> Option<libc::pid_t> {
    for entry in std::fs::read_dir("/proc").into_iter().flatten().flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<libc::pid_t>() else {
            continue;
        };
        let Ok(cmdline) = std::fs::read(entry.path().join("cmdline")) else {
            continue;
        };
        let mut fields = cmdline.split(|byte| *byte == 0);
        if fields.next() != Some(executable.as_os_str().as_encoded_bytes()) {
            continue;
        }
        let Some(identity) = fields.next() else { continue };
        if identities.iter().any(|want| want.as_bytes() == identity) {
            return Some(pid);
        }
    }
    None
}

fn task_identity(pid: libc::pid_t) -> String {
    std::fs::read(format!("/proc/{pid}/cmdline"))
        .map(|line| String::from_utf8_lossy(line.split(|byte| *byte == 0).nth(1).unwrap_or_default()).into_owned())
        .unwrap_or_default()
}

fn await_fixture_task(executable: &Path, identities: &[&str], what: &str) -> libc::pid_t {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
    loop {
        if let Some(pid) = fixture_task(executable, identities) {
            return pid;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "{what}: no task of this fixture is running at all"
        );
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}

/// Waits for ONE named task to block in `pause`, polling only that task.
///
/// Deliberately not a rescan of all of /proc per iteration: under load that scan is the expensive
/// part, and paying it in a tight loop is what made the sibling wait in `native_supervised` miss its
/// window under a fully parallel run while passing in isolation.
fn wait_parked(pid: libc::pid_t, what: &str) -> bool {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
    loop {
        if std::fs::read_to_string(format!("/proc/{pid}/syscall")).is_ok_and(|text| text.starts_with(NR_PAUSE)) {
            return true;
        }
        // A task that has DIED is a different fact from one that is slow, and it is
        // not this wait's to report: the caller's own assertions already say why a
        // restore failed, and drowning that out with "never reached pause" would
        // misattribute a product failure to the park.  Measured: under a fully
        // parallel run this binary's restores intermittently fail outright -- on
        // the BASELINE too, with the old timer-driven fixture, where the same two
        // tests report `CaptureFailed` from the same cause.
        if !std::path::Path::new(&format!("/proc/{pid}")).exists() {
            return false;
        }
        if std::time::Instant::now() >= deadline {
            let state = std::fs::read_to_string(format!("/proc/{pid}/syscall")).unwrap_or_else(|e| format!("<{e}>"));
            panic!(
                "{what}: task {pid} never reached syscall {NR_PAUSE}(pause); it is in {state:?} carrying \
                 identity {:?}",
                task_identity(pid)
            );
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
}

fn wake_task(pid: libc::pid_t, what: &str) {
    assert_eq!(unsafe { libc::kill(pid, libc::SIGUSR1) }, 0, "{what}: waking the parked guest");
}

struct Captured {
    store: Arc<Store>,
    stderr: String,
}

/// Launches `variant`, waits for its park, and asks for a capture.  Returns the
/// committed store on success and the engine's own refusal text on refusal.
fn capture(executable: &Path, variant: &str) -> Result<Captured, String> {
    let store = Arc::new(Store::default());
    let output = Arc::new(Output::default());
    let engine = Engine::with_checkpoint(
        GuestIsa::X86_64,
        plan(executable, "1111111111111111", variant, false),
        StandardStreams::default().with_output(output.clone()),
        store.clone(),
        store.clone(),
    )
    .unwrap();
    engine.start().unwrap();
    wait_ready(&output);
    // The park is genuine: the workload is in state `T` before the capture is
    // ever asked for.  Without this the capture's own freeze would stop it and a
    // fixture that never parked would be indistinguishable from one that did.
    let workload = await_fixture_task(executable, &["1111111111111111"], variant);
    assert!(
        wait_parked(workload, variant),
        "{variant}: the guest died before it parked, so nothing was captured from a parked process"
    );
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    let outcome = engine.capture_checkpoint_until(deadline);
    let stderr = String::from_utf8_lossy(&output.stderr.lock().unwrap()).into_owned();
    match outcome {
        Ok(()) => {
            engine.wait().expect("captured process terminated");
            engine.destroy().unwrap();
            assert_eq!(
                store.commits.load(std::sync::atomic::Ordering::Acquire),
                1,
                "{variant}: capture reported success without committing an image"
            );
            Ok(Captured { store, stderr })
        }
        Err(error) => {
            // A refusal owes TWO things, and this arm asserts both.
            //
            // The first is that nothing was published.  The second is that the
            // container comes back unharmed -- a refusal that kills the workload
            // it refused is a destructive refusal, and it is not made acceptable
            // by the image being absent.  So the aftermath is asserted here, not
            // the decision: the guest must still be parked where it was, must do
            // REAL work after it is released, and must exit cleanly.  The wait is
            // bounded so that a hung tree reports failure instead of quietly
            // scoring as a clean refusal.
            //
            // The TYPE is deliberately not asserted, and the reason is measured
            // rather than assumed.  A native phase-1 admission refusal still
            // reaches the caller as a deadline (`WaitFailed`) instead of the
            // typed `CaptureRefused` the translated path now produces.  That is
            // not something these arms introduced: the `tfdt` arm in this very
            // test is refused by the DESCRIPTOR gate, which long predates them,
            // and it degrades identically in the same run.  So it is a
            // refusal-typing gap in the native phase-1 path, shared by every arm
            // from -2 to -8, and it is left to the lane that owns that path.
            // What matters for safety is asserted below and does hold: nothing is
            // published, and the workload survives.
            assert_eq!(
                store.commits.load(std::sync::atomic::Ordering::Acquire),
                0,
                "{variant}: a refused capture published an image"
            );
            let survivor = fixture_task(executable, &["1111111111111111"]).unwrap_or_else(|| {
                let _ = engine.destroy();
                panic!(
                    "{variant}: the refusal destroyed the container it refused -- the workload is gone. \
                     A refusal must publish nothing AND leave the workload running. \
                     error={error:?} stderr={stderr}"
                )
            });
            assert_eq!(survivor, workload, "{variant}: a different task survived the refusal");
            assert!(
                wait_parked(survivor, &format!("{variant} after refusal")),
                "{variant}: the refused guest died instead of resuming its park"
            );
            wake_task(survivor, variant);
            // Real post-release work, not merely "still alive": the guest has to
            // reach its report AND the line after it, which re-arms state through
            // syscalls the supervisor is notified about.
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
            loop {
                let seen = String::from_utf8_lossy(&output.stdout.lock().unwrap()).into_owned();
                if seen.contains("timerstate-late ") {
                    break;
                }
                if std::time::Instant::now() >= deadline {
                    let _ = engine.destroy();
                    panic!(
                        "{variant}: the refused guest was released and never finished its post-release \
                         work inside the window; stdout so far={seen:?} error={error:?} stderr={stderr}"
                    );
                }
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
            let resumed = engine.wait();
            engine.destroy().unwrap();
            let resumed = resumed.unwrap_or_else(|failure| {
                panic!("{variant}: the refused guest did not exit cleanly: {failure:?}")
            });
            assert_eq!(
                resumed.guest_status, 0,
                "{variant}: the refused guest resumed but exited {}",
                resumed.guest_status
            );
            let guest = String::from_utf8_lossy(&output.stdout.lock().unwrap()).into_owned();
            Err(format!("{error:?} survived=pid{survivor} guest_stdout={guest:?}"))
        }
    }
}

/// Restores a committed image into a fresh process launched as `variant` and
/// returns that process's own report of the live task's kernel state.
fn restore_into(executable: &Path, captured: &Captured, variant: &str) -> String {
    let output = Arc::new(Output::default());
    let engine = Engine::with_checkpoint(
        GuestIsa::X86_64,
        plan(executable, "2222222222222222", variant, true),
        StandardStreams::default().with_output(output.clone()),
        captured.store.clone(),
        captured.store.clone(),
    )
    .unwrap();
    engine.start().unwrap();
    // Waiting for the guest to appear under the CAPTURED identity, parked inside
    // syscall 34, is the proof that the restore landed -- and it is what makes the
    // wake race-free.  The fresh process was launched with a different argv
    // identity and never reaches `pause` on its own (its own `write` of the ready
    // line is the notification the restore hijacks), so the only way a task whose
    // `/proc/<pid>/cmdline` carries the captured identity can be sitting in
    // `pause` is that the captured memory and the captured registers both landed.
    let restore_task = await_fixture_task(executable, &["2222222222222222", "1111111111111111"], "restore");
    if wait_parked(restore_task, "restore") {
        assert_eq!(
            task_identity(restore_task),
            "1111111111111111",
            "the restored task is parked, but its argv is still the fresh process's own"
        );
        wake_task(restore_task, "restore");
    }
    let status = engine.wait().expect("restored process result");
    engine.destroy().unwrap();
    assert_eq!(
        status.guest_status, 0,
        "restored guest status ({variant}); capture stderr={}",
        captured.stderr
    );
    // The restored process must not have re-run `main`.
    //
    // This is the whole difference between "the image carried it" and "the fresh
    // exec of the same binary armed it itself on the way to its own park".  The
    // counter lives in BSS, so it travels in the memory image; a restored process
    // that re-entered `main` would report `mains=2` and everything it says about
    // armed state would be its own doing rather than the image's.  `mains=1`
    // together with the CAPTURED identity says the image landed and execution
    // resumed at the captured registers, inside `pause`, past every arming line.
    let report = report_of(&output);
    assert!(
        report.contains(" mains=1 "),
        "the restored guest re-entered main, so nothing it reports about armed state is the image's: {report}"
    );
    // The restore filter is a different BPF program from the capture one, and it
    // notifies these syscalls too.  This is the executed statement that a restored
    // guest can still arm them, and that the supervisor answering the notification
    // neither deadlocks the restore rendezvous nor changes the outcome.
    assert_eq!(
        line_of(&output, "timerstate-late "),
        "timerstate-late altstack=1 realtimer=4321",
        "a notified syscall did not take effect under the restore filter"
    );
    report_of(&output)
}

/// The whole cell, in one test.
///
/// Controls first, so a later "refused" reading is known to be discriminating
/// rather than a harness that refuses everything; then the four armed shapes.
#[test]
fn native_checkpoint_refuses_every_timer_and_altstack_shape_the_image_cannot_carry() {
    let work = TempDir::new().unwrap();
    let executable = fixture(work.path());

    let free_control = control_report(&executable, "free");
    let armd_control = control_report(&executable, "armd");
    let posx_control = control_report(&executable, "posx");
    let tfdt_control = control_report(&executable, "tfdt");
    // The third filter the supervisor can build, exercised for the same property.
    let refusal_control = control_report_under(&executable, "armd", Some("999:38"));
    assert!(
        refusal_control.ends_with("altstack=1 realtimer=1 posix=0 timerfd=0"),
        "armd control under the refusal filter: {refusal_control}"
    );
    println!("TIMERSTATE free_control = {free_control}");
    println!("TIMERSTATE armd_control = {armd_control}");
    println!("TIMERSTATE posx_control = {posx_control}");
    println!("TIMERSTATE tfdt_control = {tfdt_control}");
    // Every control enters `main` exactly once, which is what makes the restored
    // process's `mains=1` a measurement rather than a tautology: the field is read
    // out of the same place in both, and the restored one gets its value from the
    // image instead of from its own execution.
    for control in [&free_control, &armd_control, &posx_control, &tfdt_control] {
        assert!(control.contains(" mains=1 "), "control entered main more than once: {control}");
    }
    assert!(
        free_control.ends_with("altstack=0 realtimer=0 posix=0 timerfd=0"),
        "free control: {free_control}"
    );
    assert!(
        armd_control.ends_with("altstack=1 realtimer=1 posix=0 timerfd=0"),
        "armd control: {armd_control}"
    );
    assert!(
        posx_control.ends_with("altstack=0 realtimer=0 posix=1 timerfd=0"),
        "posx control: {posx_control}"
    );
    assert!(
        tfdt_control.ends_with("altstack=0 realtimer=0 posix=0 timerfd=1"),
        "tfdt control: {tfdt_control}"
    );

    // The discriminating control: an unarmed guest of the very same fixture, with
    // the very same park, IS admitted, committed and restored.  Without this the
    // three refusals below would be consistent with a gate that refuses always.
    let free = capture(&executable, "free").expect("an unarmed guest must still be capturable");
    let restored = restore_into(&executable, &free, "free");
    println!("TIMERSTATE free_restored = {restored}");
    assert!(
        restored.contains("identity=1111111111111111"),
        "the restore did not carry captured guest memory: {restored}"
    );
    assert!(
        restored.ends_with("altstack=0 realtimer=0 posix=0 timerfd=0"),
        "free restore: {restored}"
    );

    let mut admitted = Vec::new();
    for (variant, what) in [
        ("armd", "sigaltstack + setitimer"),
        ("posx", "a POSIX timer"),
        ("tfdt", "a timerfd"),
    ] {
        match capture(&executable, variant) {
            Ok(captured) => {
                let restored = restore_into(&executable, &captured, "free");
                admitted.push(format!("{variant} ({what}) ADMITTED, restored as: {restored}"));
            }
            Err(refusal) => println!("TIMERSTATE {variant}_refused = {refusal}"),
        }
    }
    assert!(
        admitted.is_empty(),
        "a guest holding state the native image cannot carry was admitted, and the restore silently \
         dropped it: {admitted:#?}"
    );
}

