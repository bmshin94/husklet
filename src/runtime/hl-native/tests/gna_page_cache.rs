#![cfg(feature = "native-test-hooks")]

//! Differential boundary coverage for the guest PROT_NONE prefix page cache
//! (`HL_X86_GNA_PAGE_CACHE`, off by default).
//!
//! The registry the cache sits in front of decides memory-FAULT behaviour: a
//! wrong answer is a wrong SIGSEGV, or a missing one, which is silent
//! corruption rather than a crash. So the test is differential, not
//! expectation-based: the engine answers every probe with the cache off (the
//! shipped full ledger walk), then twice with it on, and any disagreement
//! fails. Scenario 67 covers an address exactly at a range start and at a
//! range end, a query spanning two adjacent ranges, a query spanning a gap, a
//! zero-length query, a range added and removed mid-run, the prefix query's
//! partial-coverage case, and sub-page queries inside a page the cache has
//! published as clean. It also asserts its own non-vacuity: the battery must
//! contain both refusals and grants, so a cache that always answered "the
//! whole length is accessible" could not pass it.

use hl_native::exec_page_cache_test;

#[test]
fn the_gna_page_cache_agrees_with_the_full_ledger_walk_on_every_boundary_case() {
    for isa in [1, 2] {
        let result = exec_page_cache_test(isa, 67);
        assert!(
            result.is_ok(),
            "isa={isa}: gna page cache disagreed with the full walk: {result:?}"
        );
        // Every probe in the battery is compared; the count is reported so a
        // battery that silently shrank cannot pass as a clean run.
        assert_eq!(result.unwrap(), 22, "isa={isa}: probe count changed");
    }
}
