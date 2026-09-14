#![cfg(feature = "native-test-hooks")]

//! Differential boundary coverage for the two guest-bus-range changes that
//! sit in front of the PROT_NONE ledger: the per-thread clean-page cache
//! (`HL_X86_GNA_PAGE_CACHE`) and interval coalescing on insert
//! (`HL_X86_BUS_RANGE_COALESCE`).  Both are off by default.
//!
//! This registry decides memory-FAULT behaviour: a wrong answer is a wrong
//! SIGSEGV, or a missing one, which is silent corruption rather than a crash.
//! So the tests are differential, not expectation-based.
//!
//! Scenario 67 answers every probe six times -- with the page cache off, on
//! cold and on warm, each of those with coalescing off and on -- and fails on
//! any disagreement.  That is two independent contracts in one battery: the
//! cache agrees with the full walk (under both ledger shapes, so it is also
//! proven against a coalesced ledger it has never seen), and the MERGED
//! ledger answers exactly as the fragmented one.  The probes cover an address
//! exactly at a range start and at a range end, a query spanning two adjacent
//! ranges, a query spanning a gap, a zero-length query, a range added and
//! removed mid-run, the prefix query's partial-coverage case, sub-page queries
//! inside a published clean page, and -- for coalescing -- two abutting ranges
//! merged, three merged where the middle arrives LAST, a query spanning a
//! merged boundary, removal of the exact MIDDLE of a merged range (the split),
//! removal of a whole merged range, removal of a prefix and of a suffix, and
//! an interleaved add/remove sequence driving the population up and down
//! across the merge threshold.  It asserts its own non-vacuity twice over --
//! each half of the battery must contain both refusals and grants on its own,
//! so neither a cache that always answered "the whole length is accessible"
//! nor one that always refused could pass.
//!
//! Scenario 68 is the other half of the argument: a differential cannot tell a
//! correct merge from a merge that never happened, so it asserts the
//! structural facts directionally -- that 24 abutting pages really collapse
//! from 24 entries to 1, and that at the ledger's hard 512 capacity the
//! unmerged ledger silently DROPS adds and reports a PROT_NONE page as
//! accessible, while the merged one does not.

use hl_native::exec_page_cache_test;

#[test]
fn the_gna_page_cache_agrees_with_the_full_ledger_walk_on_every_boundary_case() {
    for isa in [1, 2] {
        let result = exec_page_cache_test(isa, 67);
        assert!(
            result.is_ok(),
            "isa={isa}: the page cache or the coalesced ledger disagreed with the full walk: {result:?}"
        );
        // Every probe in the battery is compared; the count is reported so a
        // battery that silently shrank cannot pass as a clean run.
        assert_eq!(result.unwrap(), 57, "isa={isa}: probe count changed");
    }
}

#[test]
fn coalescing_abutting_bus_ranges_collapses_the_ledger_and_relieves_its_512_capacity() {
    for isa in [1, 2] {
        let result = exec_page_cache_test(isa, 68);
        assert!(
            result.is_ok(),
            "isa={isa}: coalescing did not change the ledger structurally as claimed: {result:?}"
        );
        assert_eq!(result.unwrap(), 6, "isa={isa}: structural check count changed");
    }
}
