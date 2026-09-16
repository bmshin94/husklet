//! Matrix probe: which PROCESS SHAPES survive a checkpoint/restore on the
//! translated backend, for both guest ISAs, on an x86-64 host.
//!
//! Measurement only.  Every shape reports a RESULT line naming what it observed
//! and what it expected, so a shape that is restored WRONG is visible as a
//! wrong value rather than as an opaque failure.  A shape the capture refuses is
//! recorded as a refusal with its error.
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
    let name = match isa {
        GuestIsa::Aarch64 => "matrix-shapes-aarch64",
        GuestIsa::X86_64 => "matrix-shapes-x86_64",
    };
    let output = directory.join(name);
    if output.is_file() {
        return output;
    }
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/checkpoint/matrix_shapes.c");
    let status = std::process::Command::new(compiler(isa))
        .args(["-static", "-O2", "-pthread", "-o"])
        .arg(&output)
        .arg(source)
        .status()
        .unwrap_or_else(|error| panic!("{}: {error}", compiler(isa)));
    assert!(status.success(), "{} failed", compiler(isa));
    output
}

fn plan(
    executable: &Path,
    release: &Path,
    scratch: &Path,
    shape: &str,
    mode: &str,
    options_to_set: &[(&str, &str)],
) -> RuntimePlan {
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
            scratch.as_os_str().as_encoded_bytes().to_vec(),
            shape.as_bytes().to_vec(),
            mode.as_bytes().to_vec(),
        ],
        environment: Vec::new(),
        result_path: None,
        options,
        box_policy: Default::default(),
    }
}

#[derive(Debug)]
enum Verdict {
    /// Capture succeeded and the restored tree reported this line.
    Restored(String),
    /// The capture refused; nothing was restored.
    CaptureRefused(String),
    /// The capture succeeded but the restore did not produce a report.
    RestoreFailed(String),
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

fn run_shape(isa: GuestIsa, executable: &Path, shape: &str, extra: &[(&str, &str)]) -> Verdict {
    run_shape_mode(isa, executable, shape, "armed", extra)
}

fn run_shape_mode(isa: GuestIsa, executable: &Path, shape: &str, mode: &str, extra: &[(&str, &str)]) -> Verdict {
    let work = tempfile::tempdir().unwrap();
    let release = work.path().join("release");
    let report = work.path().join("release.output");
    let scratch = work.path().join("scratch");
    std::fs::create_dir(&scratch).unwrap();
    let store = Arc::new(Store::default());

    let capture = Engine::with_checkpoint(
        isa,
        plan(
            executable,
            &release,
            &scratch,
            shape,
            mode,
            &[&[("HL_CHECKPOINT", "1")], extra].concat(),
        ),
        StandardStreams::default(),
        store.clone(),
        store.clone(),
    )
    .unwrap();
    capture.start().unwrap();
    if !wait_for(&report, &format!("READY {shape}"), 30) {
        let _ = capture.destroy();
        return Verdict::CaptureRefused(format!(
            "guest never became ready; report={:?}",
            std::fs::read_to_string(&report).unwrap_or_default()
        ));
    }
    let outcome = capture.capture_checkpoint_until(Instant::now() + Duration::from_secs(30));
    if let Err(error) = outcome {
        // A refusal must leave the container as it found it.  Release the still
        // parked tree and read ITS report: the same RESULT line that scores a
        // restore also scores whether the refused capture mutated the live
        // process on its way out.
        std::fs::write(&release, []).unwrap();
        let resumed = capture.wait();
        let _ = capture.destroy();
        let text = std::fs::read_to_string(&report).unwrap_or_default();
        let survived = text
            .lines()
            .find(|line| line.starts_with("RESULT "))
            .map(str::to_owned)
            .unwrap_or_else(|| format!("no RESULT after refusal; report={text:?}"));
        return Verdict::CaptureRefused(format!(
            "{error:?} | after-refusal {survived} | resumed_exit={resumed:?}"
        ));
    }
    let exit = capture.wait();
    capture.destroy().unwrap();
    if !matches!(&exit, Ok(status) if status.guest_status == 0) {
        return Verdict::CaptureRefused(format!("captured tree exit {exit:?}"));
    }
    if !store.0.lock().unwrap().contains_key("MANIFEST") {
        return Verdict::CaptureRefused("no MANIFEST published".into());
    }

    std::fs::write(&release, []).unwrap();
    let restore = Engine::with_checkpoint(
        isa,
        plan(
            executable,
            &release,
            &scratch,
            shape,
            mode,
            &[&[("HL_RESTORE", "1")], extra].concat(),
        ),
        StandardStreams::default(),
        store.clone(),
        store.clone(),
    )
    .unwrap();
    if let Err(error) = restore.start() {
        let _ = restore.destroy();
        return Verdict::RestoreFailed(format!("start: {error:?}"));
    }
    let restored = restore.wait();
    restore.destroy().unwrap();
    let text = std::fs::read_to_string(&report).unwrap_or_default();
    match text.lines().find(|line| line.starts_with("RESULT ")) {
        Some(line) => Verdict::Restored(format!("{line}   {}   [exit={restored:?}]", provenance(&text))),
        None => Verdict::RestoreFailed(format!("no RESULT line; exit={restored:?}; report={text:?}")),
    }
}

/// The bracket that decides whether any WORKS verdict in this file means
/// anything: a genuine restore resumes the captured process image, so the
/// report holds exactly ONE `SEEDED` line and the `SEED` the result carries is
/// that same value.  A "restore" that re-executed the guest from `main` would
/// announce a second, different seed -- and would then rebuild every shape from
/// scratch and report it correct without restoring anything.
fn provenance(text: &str) -> String {
    let seeded: Vec<&str> = text
        .lines()
        .filter_map(|line| line.strip_prefix("SEEDED "))
        .collect();
    let ready = text.lines().filter(|line| line.starts_with("READY ")).count();
    let result_seed = text.lines().filter_map(|line| line.strip_prefix("SEED ")).last();
    let resumed = seeded.len() == 1 && result_seed == seeded.first().copied();
    format!(
        "[provenance seeded={} ready={ready} resumed={}]",
        seeded.len(),
        u8::from(resumed)
    )
}

/// The probe must be able to observe a wrong answer.  This runs the shapes with
/// NO checkpoint at all -- the guest simply runs through -- and requires each to
/// report the correct value.  If this control cannot report, the runner is
/// broken and every verdict below is meaningless.
fn control(isa: GuestIsa, executable: &Path, shape: &str) -> String {
    control_mode(isa, executable, shape, "armed")
}

/// Same fixture, same engine, no checkpoint -- in `armed` mode it must report
/// the correct value, and in `poison` mode (the shape built WITHOUT its
/// pre-capture kernel-side state) it must report a DIFFERENT one.  A shape
/// whose two modes agree cannot score its own cell.
fn control_mode(isa: GuestIsa, executable: &Path, shape: &str, mode: &str) -> String {
    let work = tempfile::tempdir().unwrap();
    let release = work.path().join("release");
    let report = work.path().join("release.output");
    let scratch = work.path().join("scratch");
    std::fs::create_dir(&scratch).unwrap();
    std::fs::write(&release, []).unwrap();
    let engine = Engine::with_streams(
        isa,
        plan(executable, &release, &scratch, shape, mode, &[]),
        StandardStreams::default(),
    )
    .unwrap();
    engine.start().unwrap();
    let status = engine.wait();
    engine.destroy().unwrap();
    let text = std::fs::read_to_string(&report).unwrap_or_default();
    text.lines()
        .find(|line| line.starts_with("RESULT "))
        .map(|line| format!("{line}   {}   [exit={status:?}]", provenance(&text)))
        .unwrap_or_else(|| format!("NO-RESULT exit={status:?} report={text:?}"))
}

const SHAPES: &[&str] = &[
    "plain",
    "cwd",
    "offset",
    "child",
    "threads",
    "pending",
    "pending-thread",
    "pending-child",
    "eventfd",
    "timerfd",
    "epoll",
    "inotify",
    "flock",
    "posixlock",
    "anonexec",
    "anonexec-rewrite",
    // round 3: kernel-side queued / ready state that exists BEFORE the capture
    "pipe-buffered",
    "sockpair-live",
    "sockpair-buffered",
    "sockpair-dgram",
    "epoll-ready",
    "inotify-queued",
    "timerfd-expired",
    "timerfd-remaining",
    "signalfd-queued",
    "signalfd-blocking",
    // round 3 batch 2: fidelity a "the object came back" check cannot see
    "cloexec",
    "timerfd-interval",
    "eventfd-sema",
    "epoll-oneshot",
    "sockpair-shutdown",
    "pipe-nonblock",
    "inotify-multi",
    "epoll-multi",
    "flock-child",
    // round 5: the four kernel-object families that had neither a
    // checkpoint_linux.rs test nor a matrix shape, and so were unscored
    "memfd",
    "memfd-seal",
    "fifo-buffered",
    "fifo-writer",
    "sysv-shm",
    "sysv-shm-rmid",
    "sysv-sem",
    "sysv-semadj",
    "sysv-msg",
    "mq-queued",
    "mq-attr",
];

/// The shapes whose fixture supports a `poison` build -- i.e. the ones whose
/// pre-capture kernel-side state can be omitted so the probe can be shown to
/// report its absence.
const POISONABLE: &[&str] = &[
    "eventfd",
    "timerfd",
    "flock",
    "posixlock",
    "pipe-buffered",
    "sockpair-buffered",
    "sockpair-dgram",
    "epoll-ready",
    "inotify-queued",
    "timerfd-expired",
    "timerfd-remaining",
    "signalfd-queued",
    "cloexec",
    "timerfd-interval",
    "eventfd-sema",
    "epoll-oneshot",
    "sockpair-shutdown",
    "pipe-nonblock",
    "inotify-multi",
    "epoll-multi",
    "flock-child",
    // round 5: the four kernel-object families that had neither a
    // checkpoint_linux.rs test nor a matrix shape, and so were unscored
    "memfd",
    "memfd-seal",
    "fifo-buffered",
    "fifo-writer",
    "sysv-shm",
    "sysv-shm-rmid",
    "sysv-sem",
    "sysv-semadj",
    "sysv-msg",
    "mq-queued",
    "mq-attr",
];

fn sweep(isa: GuestIsa, label: &str, extra: &[(&str, &str)]) {
    let fixtures = tempfile::tempdir().unwrap();
    let executable = fixture(isa, fixtures.path());
    // Ablation runs need one shape at a time; unset, the sweep is the full table.
    let selected = std::env::var("MATRIX_SHAPES").unwrap_or_default();
    let selected: Vec<&str> = selected.split(',').filter(|entry| !entry.is_empty()).collect();
    for shape in SHAPES {
        if !selected.is_empty() && !selected.contains(shape) {
            continue;
        }
        let control = control(isa, &executable, shape);
        println!("MATRIX {label} {shape} CONTROL   {control}");
        let verdict = run_shape(isa, &executable, shape, extra);
        println!("MATRIX {label} {shape} CHECKPOINT {verdict:?}");
    }
}

#[test]
#[ignore = "matrix probe; run explicitly"]
fn translated_shape_sweep_x86_64() {
    sweep(GuestIsa::X86_64, "x86_64/default", &[]);
}

#[test]
#[ignore = "matrix probe; run explicitly"]
fn translated_shape_sweep_aarch64() {
    sweep(GuestIsa::Aarch64, "aarch64/default", &[]);
}

/// x86-64 guest on an x86-64 host with the native backend explicitly OFF, which
/// is the only way to reach the plain JIT/interpreter translated path: AUTO sets
/// HL_TRANSLIT for an x86-64 guest whenever native is not selected.
#[test]
#[ignore = "matrix probe; run explicitly"]
fn translated_shape_sweep_x86_64_jit() {
    sweep(GuestIsa::X86_64, "x86_64/jit", &[("HL_NATIVE_SUPERVISED", "0")]);
}

#[test]
#[ignore = "matrix probe; run explicitly"]
fn translated_shape_sweep_x86_64_translit() {
    sweep(GuestIsa::X86_64, "x86_64/translit", &[("HL_TRANSLIT", "1")]);
}

/// Cache state axis: a persistent translated-code cache directory shared between
/// the capture launch and the restore launch, so the restore begins WARM.
#[test]
#[ignore = "matrix probe; run explicitly"]
fn translated_shape_sweep_x86_64_warm_cache() {
    let cache = tempfile::tempdir().unwrap();
    let directory = cache.path().to_str().unwrap().to_owned();
    sweep(
        GuestIsa::X86_64,
        "x86_64/warm-pcache",
        &[("HL_PCACHE", "1"), ("HL_PCACHE_DIR", &directory)],
    );
}

#[test]
#[ignore = "matrix probe; run explicitly"]
fn translated_shape_sweep_aarch64_warm_cache() {
    let cache = tempfile::tempdir().unwrap();
    let directory = cache.path().to_str().unwrap().to_owned();
    sweep(
        GuestIsa::Aarch64,
        "aarch64/warm-pcache",
        &[("HL_PCACHE", "1"), ("HL_PCACHE_DIR", &directory)],
    );
}

/// Warm-cache axis evidence: the capture launch must actually populate the
/// persistent translated-code cache, otherwise the "warm-restored" arm above is
/// indistinguishable from a cold one and its verdicts mean nothing.
#[test]
#[ignore = "matrix probe; run explicitly"]
fn translated_shape_sweep_x86_64_jit_warm_cache() {
    let cache = tempfile::tempdir().unwrap();
    let directory = cache.path().to_str().unwrap().to_owned();
    sweep(
        GuestIsa::X86_64,
        "x86_64/jit-warm",
        &[
            ("HL_NATIVE_SUPERVISED", "0"),
            ("HL_PCACHE", "1"),
            ("HL_PCACHE_DIR", &directory),
        ],
    );
}

#[test]
#[ignore = "matrix probe; run explicitly"]
fn translated_shape_sweep_x86_64_translit_warm_cache() {
    let cache = tempfile::tempdir().unwrap();
    let directory = cache.path().to_str().unwrap().to_owned();
    sweep(
        GuestIsa::X86_64,
        "x86_64/translit-warm",
        &[
            ("HL_TRANSLIT", "1"),
            ("HL_PCACHE", "1"),
            ("HL_PCACHE_DIR", &directory),
        ],
    );
}

/// Bracket falsification for the whole table.  For every shape that can be
/// built without its state, the engine's own control arm must report a
/// DIFFERENT line than the armed control.  Where it does not, the shape's
/// WORKS verdicts are struck out rather than believed.
#[test]
#[ignore = "matrix probe; run explicitly"]
fn poison_controls_discriminate() {
    let fixtures = tempfile::tempdir().unwrap();
    let mut blind = Vec::new();
    let selected = std::env::var("MATRIX_SHAPES").unwrap_or_default();
    let selected: Vec<&str> = selected.split(',').filter(|entry| !entry.is_empty()).collect();
    for isa in [GuestIsa::X86_64, GuestIsa::Aarch64] {
        let executable = fixture(isa, fixtures.path());
        for shape in POISONABLE {
            if !selected.is_empty() && !selected.contains(shape) {
                continue;
            }
            let armed = control_mode(isa, &executable, shape, "armed");
            let poisoned = control_mode(isa, &executable, shape, "poison");
            let armed_line = armed.split("   [").next().unwrap_or_default().to_owned();
            let poisoned_line = poisoned.split("   [").next().unwrap_or_default().to_owned();
            println!("POISON {isa:?} {shape} ARMED    {armed_line}");
            println!("POISON {isa:?} {shape} POISONED {poisoned_line}");
            if armed_line == poisoned_line || armed_line.is_empty() {
                blind.push(format!("{isa:?}/{shape}"));
            }
        }
    }
    assert!(blind.is_empty(), "shapes whose probe cannot see state loss: {blind:?}");
}

#[test]
#[ignore = "matrix probe; run explicitly"]
fn warm_cache_arm_is_actually_warm() {
    let cache = Path::new("/var/tmp/ckpt-matrix-full/pcache-evidence");
    let _ = std::fs::remove_dir_all(cache);
    std::fs::create_dir_all(cache).unwrap();
    let directory = cache.to_str().unwrap().to_owned();
    let options: &[(&str, &str)] = &[("HL_PCACHE", "1"), ("HL_PCACHE_DIR", &directory)];

    let fixtures = tempfile::tempdir().unwrap();
    let executable = fixture(GuestIsa::X86_64, fixtures.path());

    let before = std::fs::read_dir(cache).unwrap().count();
    let verdict = run_shape(GuestIsa::X86_64, &executable, "plain", options);
    let after: Vec<String> = std::fs::read_dir(cache)
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| {
            format!(
                "{} ({} bytes)",
                entry.file_name().to_string_lossy(),
                entry.metadata().map(|m| m.len()).unwrap_or(0)
            )
        })
        .collect();
    println!("MATRIX pcache before={before} after={} entries={after:?}", after.len());
    println!("MATRIX pcache round_trip={verdict:?}");
    assert!(
        !after.is_empty(),
        "HL_PCACHE_DIR stayed empty: the warm-cache arm was not warm"
    );
}
