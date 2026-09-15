#![cfg(feature = "native-test-hooks")]

//! Differential boundary coverage for the thread-local decode memo's byte
//! authority (`HL_X86_DECODE_THREAD_AUTHORITY`, off by default).
//!
//! What the option changes: `hl_x86_decode()` -- the JIT block loop, the
//! flag-liveness lookahead, and the SSE/AVX fallbacks -- currently re-reads the
//! guest instruction bytes and `memcmp`s them on EVERY memo hit. With the
//! option on it may instead accept the hit while the process-wide guest-fetch
//! authority word is stable and unchanged, which is the admission the
//! per-context memo has always had.
//!
//! A wrong "yes" here executes a translation of bytes that have since changed:
//! silent miscompilation of the guest, not a crash. So scenario 69 is
//! differential rather than expectation-based -- every probe is decoded with
//! the option off (the shipped re-read path), then twice with it on (cold and
//! warm), and any disagreement in the decoded instruction fails. It covers the
//! first byte and the last byte of a decoded instruction changing, a change
//! that lands while a writer is inside its window, a change that lands between
//! the decode's two authority loads, the sticky DISABLED latch that a writable
//! alias of executable bytes sets, a transaction that must be refused at commit
//! and retried, and the real execute-permission ledger writer that the guest
//! mprotect and SMC invalidation paths both go through.
//!
//! It also asserts its own non-vacuity: the battery must contain at least four
//! grants and four refusals with the option on, and the option-off arm must
//! refuse every single step -- so neither an implementation that always
//! re-reads nor one that never does can pass it unchanged.

use hl_native::exec_page_cache_test;

#[test]
fn the_thread_decode_authority_agrees_with_the_shipped_re_read_on_every_boundary_case() {
    // isa=2 is the x86-64 backend; the decoder under test is x86-only, so the
    // aarch64 backend's scenario table has no case 69 to route to.
    let result = exec_page_cache_test(2, 69);
    assert!(
        result.is_ok(),
        "thread decode authority disagreed with the shipped re-read path: {result:?}"
    );
    // 16 steps x 4 observations. Reported so a battery that silently shrank
    // cannot pass as a clean run.
    assert_eq!(result.unwrap(), 64, "probe count changed");
}
