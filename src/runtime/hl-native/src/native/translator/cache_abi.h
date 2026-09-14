#ifndef HL_TRANSLATOR_CACHE_ABI_H
#define HL_TRANSLATOR_CACHE_ABI_H

#include <stdint.h>

/*
 * Persistent caches contain executable host instructions. Their file format
 * and translator ABI are separate contracts: a layout-compatible file may
 * still contain code emitted under incompatible lowering or relocation rules.
 * Bump the matching ABI whenever those rules change.
 */
/* A64PCA03: the aarch64 chain-exit patch slot is now shaped `b .+4` (guest/aarch64/stubs.c
   emit_chain_exit_from), so a persisted arena from an A64PCA02 build has an unshaped slot -- a
   `movz`/`stp` -- that this build's patch_links_to would rewrite into a `b` under live peers, which
   is exactly the architecturally unpredictable rewrite the shaping exists to remove. Layout is
   unchanged; the emitted-code contract is not. */
#define HL_PCACHE_ABI_AARCH64 UINT64_C(0x4136345043413033) /* "A64PCA03" */
/* X86PCA03: HL_X86_IBTC8 gives every x86 region an immutable 8-byte guest-PC header immediately
   before its `body`, which the emitted indirect probe loads through the body pointer to re-validate
   an IBTC hit. A persisted X86PCA02 arena has no such header, so a probe from this build would
   compare against arbitrary emitted words. The option also keys the codegen-mode bits, but the
   layout change is an ABI change and is recorded as one. */
#define HL_PCACHE_ABI_X86_64 UINT64_C(0x5838365043413033)  /* "X86PCA03" */

static inline int hl_pcache_compatible(uint64_t stored_format, uint64_t stored_abi, uint64_t current_format,
                                       uint64_t current_abi) {
    return stored_format == current_format && stored_abi == current_abi;
}

#endif
