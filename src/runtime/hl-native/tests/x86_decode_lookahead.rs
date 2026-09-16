// Same-ISA x86 transliterator fixtures: `hl_x86_64_translit_displaced_test` is the weak
// `return -1` stub from `target/aarch64.c` on an AArch64 host, because `target/x86_64.c`
// includes `interp.c` -- which defines the real entry point -- only on a non-AArch64 host.
// This is the crate-level gate every sibling x86 test target carries; it was omitted here.
#![cfg(all(feature = "native-test-hooks", target_os = "linux", target_arch = "x86_64"))]

#[test]
fn admitted_direct_jmp_successor_is_decoded_once() {
    assert_eq!(
        hl_native::x86_64_translit_displaced_test(85),
        0,
        "direct JMP successor lookahead"
    );
}

#[test]
fn admitted_jcc_fallthrough_successor_is_decoded_once() {
    assert_eq!(
        hl_native::x86_64_translit_displaced_test(228),
        0,
        "JCC fall-through successor lookahead"
    );
}

#[test]
fn smc_during_successor_lookahead_rejects_then_rebuilds() {
    assert_eq!(
        hl_native::x86_64_translit_displaced_test(229),
        0,
        "SMC invalidates the whole transaction containing a decoded successor"
    );
}
