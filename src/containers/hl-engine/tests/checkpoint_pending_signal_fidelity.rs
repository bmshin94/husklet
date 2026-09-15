//! A blocked pending signal must survive on EVERY member of a guest tree -- with its multiplicity,
//! `si_code` and `si_value` payload intact -- both while the guest merely runs and across a
//! checkpoint/restore.
//!
//! The fixture queues a standard signal (of which at most one instance may stay pending), three
//! instances of a real-time signal with distinct payloads (all three must stay queued, FIFO), and a
//! thread-directed `raise()`.  It then reports both what `sigpending()` sees and what each handler
//! is actually handed once the signals are unblocked.  Delivery is reported, not just presence,
//! because a restore that rebuilt the pending set from a bitmask would show the signal present while
//! handing the handler an invented `si_code` and a zero payload.
//!
//! Each arm is run twice per backend column: once LIVE with no checkpoint (the control) and once
//! through a capture + restore.  The control is asserted first -- a column whose live engine already
//! loses the signal cannot distinguish "the restore lost it" from "the backend never had it".
//!
//! Two independent defects are pinned here, and each arm/column combination fails without its own
//! fix:
//!
//! 1. **Live, transliterator only** (`x86_64/default`, `x86_64/translit`): the emitted IBTC probe
//!    stored the 32-bit `cpu->jcc_ibtc_miss` with a REX.W move, whose upper four bytes landed on the
//!    `cpu->tpending` word declared immediately after it.  Every IBTC probe therefore zeroed the
//!    thread-directed pending set, so a blocked `raise()`/`tgkill(self)` vanished from `sigpending()`
//!    and was never delivered -- with no checkpoint anywhere in sight.  Without that fix the CONTROL
//!    arm of those two columns reports `pending_thread=0 thread_count=0`.
//! 2. **Restore, re-forked members only** (`child` arm, every column): the restore of a captured
//!    non-init member ran the shared after-fork engine reset over the member's own CPU image, and
//!    that reset drops pending signals -- correct for a real `fork(2)`, wrong for a restore.  The
//!    process-directed words and the siginfo queue were re-published afterwards; the per-thread word
//!    was not.  Without that fix the `child` CHECKPOINT arm reports `pending_thread=0
//!    thread_count=0` while capture and restore both report success and the restored tree exits 0.
//!
//! The `root`, `root-thread`, `peer-open` and `child-peer-open` arms are the positive bracket for
//! defect 2: they were always restored correctly, so a battery that answered "lost" everywhere would
//! fail them.
#![cfg(target_os = "linux")]

use hl_engine::{
    activation::GuestIsa,
    composition::{CheckpointSink, CheckpointSource, CompositionError, StandardStreams},
    launcher::plan::RuntimePlan,
    options::Options,
    runtime::Engine,
};
use std::collections::BTreeMap;
use std::num::NonZeroU64;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Default)]
struct Store(Mutex<BTreeMap<String, Vec<u8>>>);

impl CheckpointSink for Store {
    fn replace(&self, _: &[u8]) -> Result<(), CompositionError> {
        Err(CompositionError::RuntimeConstruction)
    }
    fn begin_until(&self, _: Instant) -> Result<NonZeroU64, CompositionError> {
        Ok(NonZeroU64::MIN)
    }
    fn put_until(&self, _: NonZeroU64, name: &str, bytes: &[u8], _: Instant) -> Result<(), CompositionError> {
        self.0.lock().unwrap().insert(name.into(), bytes.into());
        Ok(())
    }
    fn abort_until(&self, _: NonZeroU64, _: Instant) -> Result<(), CompositionError> {
        Ok(())
    }
    fn commit_until(&self, _: NonZeroU64, manifest: &[u8], _: Instant) -> Result<(), CompositionError> {
        self.0.lock().unwrap().insert("MANIFEST".into(), manifest.into());
        Ok(())
    }
}

impl CheckpointSource for Store {
    fn read(&self, offset: usize) -> Result<Vec<u8>, CompositionError> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .get("MANIFEST")
            .and_then(|bytes| bytes.get(offset..))
            .unwrap_or_default()
            .to_vec())
    }
    fn get_until(&self, name: &str, _: Instant) -> Result<Vec<u8>, CompositionError> {
        self.0
            .lock()
            .unwrap()
            .get(name)
            .cloned()
            .ok_or(CompositionError::RuntimeConstruction)
    }
    fn list_until(&self, _: Instant) -> Result<Vec<String>, CompositionError> {
        Ok(self.0.lock().unwrap().keys().cloned().collect())
    }
}

fn compiler(isa: GuestIsa) -> &'static str {
    match isa {
        GuestIsa::Aarch64 => "aarch64-linux-gnu-gcc",
        GuestIsa::X86_64 => "x86_64-linux-gnu-gcc",
    }
}

fn fixture(isa: GuestIsa, directory: &Path) -> PathBuf {
    let output = directory.join(match isa {
        GuestIsa::Aarch64 => "pending-fidelity-aarch64",
        GuestIsa::X86_64 => "pending-fidelity-x86_64",
    });
    if output.is_file() {
        return output;
    }
    let source =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/checkpoint/pending_signal_fidelity.c");
    let status = std::process::Command::new(compiler(isa))
        .args(["-static", "-O2", "-pthread", "-o"])
        .arg(&output)
        .arg(source)
        .status()
        .unwrap_or_else(|error| panic!("{}: {error}", compiler(isa)));
    assert!(status.success(), "{} failed", compiler(isa));
    output
}

fn plan(executable: &Path, release: &Path, arm: &str, options_to_set: &[(&str, &str)]) -> RuntimePlan {
    let mut options = Options::default();
    for (option, value) in options_to_set {
        options.set(option, value, true).unwrap();
    }
    RuntimePlan {
        rootfs: None,
        executable_host: Some(executable.as_os_str().as_encoded_bytes().to_vec()),
        arguments: vec![
            executable.as_os_str().as_encoded_bytes().to_vec(),
            release.as_os_str().as_encoded_bytes().to_vec(),
            arm.as_bytes().to_vec(),
        ],
        environment: Vec::new(),
        result_path: None,
        options,
        box_policy: Default::default(),
    }
}

fn wait_for(path: &Path, marker: &str, seconds: u64) -> bool {
    let deadline = Instant::now() + Duration::from_secs(seconds);
    while Instant::now() < deadline {
        if std::fs::read_to_string(path).unwrap_or_default().contains(marker) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    false
}

/// Run the arm through a capture + restore cycle and return its RESULT line.
fn round_trip(isa: GuestIsa, executable: &Path, arm: &str, extra: &[(&str, &str)]) -> String {
    let work = tempfile::tempdir().unwrap();
    let release = work.path().join("release");
    let report = work.path().join("release.output");
    let store = Arc::new(Store::default());

    let capture = Engine::with_checkpoint(
        isa,
        plan(executable, &release, arm, &[&[("HL_CHECKPOINT", "1")], extra].concat()),
        StandardStreams::default(),
        store.clone(),
        store.clone(),
    )
    .unwrap();
    capture.start().unwrap();
    assert!(
        wait_for(&report, &format!("READY {arm}"), 60),
        "{arm}: guest never became ready; report={:?}",
        std::fs::read_to_string(&report).unwrap_or_default()
    );
    let captured = capture.capture_checkpoint_until(Instant::now() + Duration::from_secs(60));
    let exit = capture.wait();
    capture.destroy().unwrap();
    assert!(captured.is_ok(), "{arm}: capture refused: {captured:?}");
    assert!(
        matches!(&exit, Ok(status) if status.guest_status == 0),
        "{arm}: captured tree exit {exit:?}"
    );
    assert!(
        store.0.lock().unwrap().contains_key("MANIFEST"),
        "{arm}: capture published no manifest"
    );

    std::fs::write(&release, []).unwrap();
    let restore = Engine::with_checkpoint(
        isa,
        plan(executable, &release, arm, &[&[("HL_RESTORE", "1")], extra].concat()),
        StandardStreams::default(),
        store.clone(),
        store.clone(),
    )
    .unwrap();
    restore.start().unwrap();
    let restored = restore.wait();
    restore.destroy().unwrap();
    let text = std::fs::read_to_string(&report).unwrap_or_default();
    let line = text
        .lines()
        .find(|line| line.starts_with("RESULT "))
        .unwrap_or_else(|| panic!("{arm}: no RESULT line; exit={restored:?}; report={text:?}"))
        .to_owned();
    format!("{line}   [restore_exit={restored:?}]")
}

/// The same arm with NO checkpoint at all.  If this does not report the correct values the probe
/// cannot distinguish "the restore lost it" from "the backend never had it", and every verdict
/// below is meaningless.
fn control_with(isa: GuestIsa, executable: &Path, arm: &str, extra: &[(&str, &str)]) -> String {
    let work = tempfile::tempdir().unwrap();
    let release = work.path().join("release");
    let report = work.path().join("release.output");
    std::fs::write(&release, []).unwrap();
    let engine = Engine::with_streams(
        isa,
        plan(executable, &release, arm, extra),
        StandardStreams::default(),
    )
    .unwrap();
    engine.start().unwrap();
    let status = engine.wait();
    engine.destroy().unwrap();
    let text = std::fs::read_to_string(&report).unwrap_or_default();
    text.lines()
        .find(|line| line.starts_with("RESULT "))
        .unwrap_or_else(|| panic!("{arm}: control produced no RESULT line; exit={status:?}; report={text:?}"))
        .to_owned()
}

/// Split a `RESULT ...` line into the observed half and the `expected ...` half.
fn observed_and_expected(line: &str) -> (Vec<String>, Vec<String>) {
    // Drop the trailing `   [restore_exit=...]` annotation: it is provenance for the reader, not a
    // measured field, and it carries an `=` that would otherwise be compared against nothing.
    let body = line.split("   [restore_exit=").next().unwrap_or(line);
    let body = body.trim_start_matches("RESULT ");
    let (observed, expected) = body.split_once(" expected ").unwrap_or_else(|| {
        panic!("malformed RESULT line (no ` expected ` separator): {line}");
    });
    let strip = |text: &str| {
        text.split_whitespace()
            .filter(|field| field.contains('='))
            .map(str::to_owned)
            .collect::<Vec<_>>()
    };
    // Drop the arm name from the observed half; it carries no `=`.
    (strip(observed), strip(expected))
}

fn assert_full_fidelity(arm: &str, label: &str, line: &str) {
    let (observed, expected) = observed_and_expected(line);
    assert_eq!(
        observed.len(),
        expected.len(),
        "{arm} {label}: field count mismatch in {line}"
    );
    let wrong: Vec<String> = observed
        .iter()
        .zip(expected.iter())
        .filter(|(seen, want)| seen != want)
        .map(|(seen, want)| format!("{seen} (expected {want})"))
        .collect();
    assert!(
        wrong.is_empty(),
        "{arm} {label}: pending signal state was not preserved: {}\n  full line: {line}",
        wrong.join(", ")
    );
}

/// Every reachable translated backend column on an x86-64 host, for both guest ISAs.  Each one is
/// asserted LIVE (no checkpoint) before its checkpoint verdict is accepted: a column whose control
/// is already wrong cannot distinguish "the restore lost it" from "the backend never had it", so a
/// verdict there would be manufactured rather than measured.
///
/// `x86_64/default` is AUTO, which forces the transliterator on an x86-64 host; `x86_64/translit`
/// is the explicit form of the same backend; `x86_64/jit` (`HL_NATIVE_SUPERVISED=0`) is the only way
/// to reach the plain JIT.  The two transliterator columns used to fail their own LIVE control --
/// `pending_thread=0 thread_count=0` with no checkpoint anywhere near them -- because the emitted
/// IBTC probe stored the 32-bit `cpu->jcc_ibtc_miss` with a 64-bit move whose upper half zeroed the
/// `cpu->tpending` word beside it.
const COLUMNS: &[(&str, GuestIsa, &[(&str, &str)])] = &[
    ("aarch64/default", GuestIsa::Aarch64, &[]),
    ("x86_64/default", GuestIsa::X86_64, &[]),
    ("x86_64/jit", GuestIsa::X86_64, &[("HL_NATIVE_SUPERVISED", "0")]),
    ("x86_64/translit", GuestIsa::X86_64, &[("HL_TRANSLIT", "1")]),
];

fn run_arm(arm: &str) {
    let fixtures = tempfile::tempdir().unwrap();
    for (label, isa, extra) in COLUMNS {
        let executable = fixture(*isa, fixtures.path());
        // The positive bracket: this column reports the full pending set correctly without a
        // checkpoint.  If this ever stops holding, the column stops being measurable and the test
        // says so here rather than quietly comparing two wrong values below.
        let control = control_with(*isa, &executable, arm, extra);
        println!("PENDING-FIDELITY {label} {arm} CONTROL    {control}");
        assert_full_fidelity(arm, &format!("{label} control"), &control);

        let restored = round_trip(*isa, &executable, arm, extra);
        println!("PENDING-FIDELITY {label} {arm} CHECKPOINT {restored}");
        assert_full_fidelity(arm, &format!("{label} after restore"), &restored);
    }
}

/// Non-vacuity: the battery must be able to answer "wrong".  The `expected ...` half of every
/// RESULT line is produced by the fixture from its own constants, so a comparison that always
/// succeeds would also succeed here -- where the two halves are deliberately different.
#[test]
fn the_fidelity_comparison_reports_a_difference_when_one_exists() {
    let matching = "RESULT root pending_std=1 rt_count=3 expected pending_std=1 rt_count=3";
    assert_full_fidelity("root", "self-test", matching);
    let differing = "RESULT child pending_std=0 rt_count=0 expected pending_std=1 rt_count=3";
    let outcome = std::panic::catch_unwind(|| assert_full_fidelity("child", "self-test", differing));
    assert!(
        outcome.is_err(),
        "the comparison accepted pending_std=0/rt_count=0 against expected 1/3 -- it can never fail"
    );
}

#[test]
fn a_blocked_pending_signal_survives_restore_on_the_root_process() {
    run_arm("root");
}

#[test]
fn a_blocked_pending_signal_survives_restore_on_a_root_peer_thread() {
    run_arm("root-thread");
}

/// The measurement for defect 2: a re-forked tree member's LEADER thread.  Its pending signals live
/// only in its own CPU image, and the restore used to run the shared after-fork engine reset over
/// that image -- which drops pending signals, correct for a real `fork(2)` and wrong for a restore.
#[test]
fn a_blocked_pending_signal_survives_restore_on_a_reforked_tree_member() {
    run_arm("child");
}

/// The shape the repo's own three-process tree fixture uses: the signal is blocked only in the
/// measuring PEER thread and delivered thread-directed, while the rest of the process never blocks
/// it.  `peer-open` is the init's peer thread; `child-peer-open` is a re-forked member's peer thread.
#[test]
fn a_thread_directed_pending_signal_survives_restore_on_a_root_peer_thread() {
    run_arm("peer-open");
}

#[test]
fn a_thread_directed_pending_signal_survives_restore_on_a_reforked_member_peer_thread() {
    run_arm("child-peer-open");
}
