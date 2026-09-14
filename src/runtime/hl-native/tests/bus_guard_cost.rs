#![cfg(feature = "native-test-hooks")]

//! Per-instruction cost of the guest BUS memory guard.
//!
//! Asking for a persistent translation cache arms and LATCHES the guest BUS ledger before the guest
//! entry point, so with `--translation-cache` every guest memory operand takes the armed guard shape
//! for the whole run. The arena-level symptom is bytes per emitted block; this fixture pins the cause
//! to one instruction, so the two numbers can be reconciled instead of merely correlated.
//!
//! `HL_X86_BUS_THUNK` must not change the DISARMED shape at all, must not change the armed shape when
//! it is off, and must strictly shrink the armed site when it is on -- the invariant tail moves to one
//! shared per-arena body, so a site keeps only its fast path plus a `bl` and three literals.

/// The hook emits real code, so it is answerable only where the x86-guest emitters are compiled --
/// an `AArch64` host. Off it the hook reports `-2`, "not applicable", and the fixture asserts that
/// rather than compiling itself out: the export still has to resolve.
const NA: i32 = -2;

const ARMED: u32 = 1;
const THUNK: u32 = 2;
const PCACHE: u32 = 4;

fn cost(scenario: u32) -> i32 {
    hl_native::x86_bus_guard_cost_test(scenario)
}

#[test]
fn the_armed_bus_guard_is_what_inflates_emitted_code() {
    if cost(0) == NA {
        for s in 0..8 {
            assert_eq!(cost(s), NA, "hook must be uniformly unavailable on this host");
        }
        return;
    }

    // Disarmed: the operand pays only the unconditional guest-EA snapshot store. No guard at all.
    let disarmed = cost(0);
    assert!(disarmed <= 1, "a disarmed ledger must emit at most the EA snapshot: {disarmed}");
    assert_eq!(cost(PCACHE), disarmed, "the cache flag alone must not change the disarmed shape");
    // The option must not reach the disarmed shape.
    assert_eq!(cost(THUNK), disarmed);
    assert_eq!(cost(THUNK | PCACHE), disarmed);

    // Armed, option off: the historical inline guard. This is the per-operand price the persistent
    // cache pays on every guest memory access.
    let inline_plain = cost(ARMED);
    let inline_cache = cost(ARMED | PCACHE);
    assert!(inline_plain > 40, "armed inline guard unexpectedly small: {inline_plain}");
    assert!(
        inline_cache >= inline_plain,
        "the cache-on shape lays fixed 4-word relocatable pointer slots, so it cannot be smaller: \
         {inline_cache} < {inline_plain}"
    );

    // Armed, option on: fast path + `bl` + three literals, and nothing else.
    let thunk_plain = cost(ARMED | THUNK);
    let thunk_cache = cost(ARMED | THUNK | PCACHE);
    assert_eq!(
        thunk_plain, thunk_cache,
        "the site keeps no baked host pointer, so the cache flag must not change its size"
    );
    assert!(
        thunk_cache * 3 < inline_cache,
        "the thunk must remove the bulk of the guard, not a sliver: {thunk_cache} vs {inline_cache}"
    );

    // The saving is real per-operand arithmetic, reported so a failure reads as a number.
    println!(
        "bus guard words/operand: disarmed={disarmed} armed_inline={inline_plain} \
         armed_inline_cache={inline_cache} armed_thunk={thunk_cache} saved={}",
        inline_cache - thunk_cache
    );
}
