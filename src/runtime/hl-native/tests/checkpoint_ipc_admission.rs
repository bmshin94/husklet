#![cfg(feature = "native-test-hooks")]

//! A checkpoint must never publish an image that silently omits state the format
//! does not carry. `SysV` IPC objects and `fcntl`/`flock` record locks live outside the
//! guest descriptor table, so the descriptor scan cannot see them; without an
//! explicit gate a live `PostgreSQL` cluster (which holds both) checkpointed and
//! restored without its shared memory or its data-directory interlock.
//!
//! `SysV` is now captured rather than refused, so scenarios 1-3 drive a real
//! capture/restore round trip through a fresh namespace hash; the lock domain is
//! still uncaptured and scenarios 4-5 still assert its refusal.

/// Nothing held -> the checkpoint is admitted.
#[test]
fn checkpoint_admits_a_process_holding_neither_sysv_nor_lock_state() {
    for isa in [1, 2] {
        hl_native::checkpoint_ipc_admission_test(isa, 0)
            .unwrap_or_else(|status| panic!("ISA {isa} empty-state admission failed with status {status}"));
    }
}

/// A shared-memory segment, a semaphore set with its `SEM_UNDO` list, and a message queue
/// survive a capture/restore round trip into a different IPC namespace -- and the segment
/// comes back at its original attach address with its original bytes.
#[test]
fn sysv_objects_survive_a_capture_and_restore_round_trip() {
    for isa in [1, 2] {
        for scenario in 1..=3 {
            hl_native::checkpoint_ipc_admission_test(isa, scenario)
                .unwrap_or_else(|status| panic!("ISA {isa} scenario {scenario} did not round-trip: status {status}"));
        }
    }
}

/// Each still-uncaptured lock object refuses the checkpoint, and the refusal is not sticky.
#[test]
fn checkpoint_refuses_every_uncaptured_file_lock_object() {
    for isa in [1, 2] {
        for scenario in 4..=5 {
            hl_native::checkpoint_ipc_admission_test(isa, scenario)
                .unwrap_or_else(|status| panic!("ISA {isa} scenario {scenario} did not fail closed: status {status}"));
        }
    }
}

#[test]
fn checkpoint_ipc_admission_hook_rejects_unknown_scenarios() {
    for isa in [1, 2] {
        assert_eq!(hl_native::checkpoint_ipc_admission_test(isa, 7), Err(99));
    }
}

/// A host-enforced `flock(2)` broker record is retired on `LOCK_UN`, on last close and at `exit_group`.
/// A holder that is SIGKILLed, faults, or is force-stopped runs none of those, and the `/dev/shm` segment
/// is named and persistent -- so the 512-record table fills with records nobody holds and every later
/// guest `flock(2)` fails closed with `ENOLCK`. Scenario 6 drives exactly that state and asserts both
/// halves: the dead records are reclaimed, AND a record whose holder is still alive is not.
///
/// The table is a segment shared by every engine on the host, so filling it in the ambient one would
/// perturb concurrent work and make the result depend on whatever ran before. Re-exec this one test with
/// `HL_POSLK_SHM_SUFFIX` set: `poslk_init` then opens a PRIVATE object of the identical layout, and the
/// scenario is deterministic no matter what state the production table is in.
#[test]
fn flock_broker_reclaims_dead_holders_and_spares_a_live_one() {
    const NAME: &str = "flock_broker_reclaims_dead_holders_and_spares_a_live_one";
    if std::env::var_os("HL_POSLK_SHM_SUFFIX").is_none() {
        let suffix = format!("test{}", std::process::id());
        // Capture rather than inherit: the child is a full libtest process and its own `test result:` line
        // would otherwise land in this run's output and be miscounted as a parent verdict.
        let child = std::process::Command::new(std::env::current_exe().expect("test binary path"))
            .args([NAME, "--exact", "--nocapture", "--test-threads=1"])
            .env("HL_POSLK_SHM_SUFFIX", &suffix)
            .stdin(std::process::Stdio::null())
            .output()
            .expect("re-exec the test in a private lock domain");
        let status = child.status;
        if !status.success() {
            println!("{}", String::from_utf8_lossy(&child.stdout));
            eprintln!("{}", String::from_utf8_lossy(&child.stderr));
        }
        // Remove only THIS test's private object. The production segment shares the prefix but never the
        // suffix, so the match cannot reach it.
        if let Ok(entries) = std::fs::read_dir("/dev/shm") {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.starts_with("husklet-poslk-v1-") && name.ends_with(&format!("-{suffix}")) {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
        assert!(status.success(), "private-segment child exited {status}");
        return;
    }
    for isa in [1, 2] {
        hl_native::checkpoint_ipc_admission_test(isa, 6)
            .unwrap_or_else(|status| panic!("ISA {isa} broker reclamation failed with status {status}"));
    }
}
