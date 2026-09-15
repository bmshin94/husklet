#![cfg(feature = "native-test-hooks")]

//! A signalfd capture drains the queued siginfo records out of the kernel, and until this landed it bought
//! its ability to do that without blocking by setting `O_NONBLOCK` on the descriptor -- and never putting it
//! back.
//!
//! `O_NONBLOCK` is a property of the OPEN FILE DESCRIPTION, not of the descriptor. A guest signalfd in this
//! engine is the read end of a self-pipe (`signal.c`, `struct sfd_ofd`): `dup(2)` aliases it, `fork(2)` hands
//! every child the same description, and the engine reads the guest's `read(2)` out of it. So the drain's
//! implementation detail became permanent guest-visible state for every holder -- and it did so on a capture
//! that was later ABANDONED just as readily as on one that committed, which is precisely what the
//! refuse-before-mutation design exists to prevent: a refused capture must leave the container exactly as it
//! found it.
//!
//! These fixtures drive the real `ckpt_capture_signalfd` against real kernel descriptions. The pipe drain
//! next door reached the same conclusion first and solved it by never mutating; this is that conclusion
//! applied to the descriptor the pipe path could not cover.

/// The committed capture. Every queued record is published, in order, and the description the drain read
/// through is handed back to the guest exactly as blocking as the guest left it -- on the drained descriptor
/// and on a `dup(2)` alias of the same description.
#[test]
fn a_committed_signalfd_drain_leaves_the_live_descriptions_blocking_mode_alone() {
    for isa in [1, 2] {
        hl_native::checkpoint_signalfd_capture_test(isa, 0)
            .unwrap_or_else(|status| panic!("ISA {isa} committed signalfd drain failed at {status}"));
    }
}

/// The abandoned capture, which is the shape that matters most: the sink refuses the first byte, the arm
/// aborts and reports failure -- and the live process must be indistinguishable from one that was never
/// asked. A capture this engine refuses is not allowed to have cost the guest anything.
#[test]
fn an_abandoned_signalfd_capture_leaves_the_live_description_untouched() {
    for isa in [1, 2] {
        hl_native::checkpoint_signalfd_capture_test(isa, 1)
            .unwrap_or_else(|status| panic!("ISA {isa} abandoned signalfd capture failed at {status}"));
    }
}

/// The obligation the `O_NONBLOCK` was discharging in the first place: a blocking descriptor with nothing
/// queued must still terminate the drain. Removing the mutation without replacing it would hang here rather
/// than fail, so this is the arm that keeps the fix honest about what it replaced.
#[test]
fn draining_an_empty_blocking_signalfd_terminates_without_mutating_it() {
    for isa in [1, 2] {
        hl_native::checkpoint_signalfd_capture_test(isa, 2)
            .unwrap_or_else(|status| panic!("ISA {isa} empty signalfd drain failed at {status}"));
    }
}

/// The other direction, so the property is "leave it as you found it" rather than "clear it": a guest that
/// asked for `SFD_NONBLOCK` gets its descriptor back non-blocking.
#[test]
fn a_signalfd_the_guest_made_non_blocking_stays_non_blocking_across_a_drain() {
    for isa in [1, 2] {
        hl_native::checkpoint_signalfd_capture_test(isa, 3)
            .unwrap_or_else(|status| panic!("ISA {isa} non-blocking signalfd drain failed at {status}"));
    }
}

/// The hook rejects a scenario it does not implement, so a fixture number that silently stopped running
/// cannot masquerade as a pass.
#[test]
fn checkpoint_signalfd_capture_hook_rejects_unknown_scenarios() {
    for isa in [1, 2] {
        assert_eq!(hl_native::checkpoint_signalfd_capture_test(isa, 4), Err(99));
    }
}
