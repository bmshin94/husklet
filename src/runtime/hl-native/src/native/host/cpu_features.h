#ifndef HL_HOST_CPU_FEATURES_H
#define HL_HOST_CPU_FEATURES_H

/* Runtime host-CPU capability probes that the EMITTED CODE's correctness depends on.
 *
 * Distinct from host/cpu.h, which is compile-time only (which host ISA am I built for). The
 * properties here cannot be answered at compile time: an aarch64 build runs on ARMv8.0 parts and
 * on ARMv8.4+ parts alike, and the translator emits a different, stronger contract on the latter.
 *
 * ----------------------------------------------------------------------------------------------
 * hl_host_atomic_pair16(): may a naturally-aligned 16-byte {uint64,uint64} pair be published with
 * ONE store and consumed with ONE load, such that a concurrent lock-free reader observes the pair
 * WHOLE or not at all -- never one new half beside one old half?
 *
 * This is the property both IBTC implementations rest on. Each IBTC entry is a 16-byte
 * {target, body} pair; the writer publishes it with a single `stp` (aarch64) / `movdqa` (x86_64)
 * and the EMITTED probe consumes it with a single `ldp` / `movdqa`, comparing the loaded `target`
 * against the guest target and branching to the loaded `body` on a match. A TORN observation --
 * the new `target` beside the previous occupant's `body` -- passes that compare and branches into
 * the wrong translation. That is a miscompile, silent and unbounded, not a crash.
 *
 * AARCH64: this is FEAT_LSE2, and it is NOT baseline.
 *   ARM ARM (DDI 0487) B2.2.1 "Requirements for single-copy atomicity" specifies LDP/STP of two
 *   64-bit registers as TWO separate 8-byte single-copy-atomic accesses. Alignment does not help:
 *   a 16-byte-ALIGNED LDP/STP is still architecturally permitted to be observed as two 8-byte
 *   accesses on a part without FEAT_LSE2. FEAT_LSE2 (mandatory from ARMv8.4-A, optional earlier)
 *   is what upgrades a 16-byte-aligned LDP/STP of two X registers to a single-copy-atomic 16-byte
 *   whole for Normal cacheable memory.
 *
 *   DISCOVERY. Linux advertises FEAT_LSE2 as HWCAP_USCAT -- "unaligned single-copy atomicity",
 *   bit 25 of AT_HWCAP, spelled `uscat` in /proc/cpuinfo. Note AT_HWCAP, not AT_HWCAP2, and note
 *   there is no HWCAP2_LSE2: the name that does exist in AT_HWCAP2 is HWCAP2_LSE128, which is
 *   FEAT_LSE128 (128-bit atomic RMW instructions), a DIFFERENT and later feature. The kernel sets
 *   HWCAP_USCAT from ID_AA64MMFR2_EL1.AT != 0, which is the architectural field; we do not read
 *   that register directly because EL0 access to it is trapped and emulated by the kernel's
 *   MRS emulation, which is both slower and not universally enabled.
 *
 * X86_64: an aligned 16-byte SSE load/store (movdqa) is architecturally guaranteed atomic only on
 *   parts that enumerate AVX -- Intel SDM Vol.3A 9.1.1 and the AMD APM both state the 16-byte
 *   guarantee for processors supporting AVX. Probe CPUID for it rather than assume, on the same
 *   principle.
 *
 * Detected ONCE, on first call, and cached. Idempotent and free of allocation, so the benign race
 * between two first callers costs at most a duplicate probe.
 *
 * hl_host_atomic_pair16_detail() returns a short static string naming what the probe actually
 * found, for the engine to report. Never NULL.
 *
 * hl_host_atomic_pair16_assume_absent() forces the answer to 0 for the remainder of the process,
 * so the refuse/fall-back paths can be exercised on a host that DOES have the feature. It must be
 * called before the first hl_host_atomic_pair16(); calling it later is honoured but the engine
 * wires it at init, ahead of any translation. There is deliberately no "assume present" override:
 * the unsafe direction is not offered. */
int hl_host_atomic_pair16(void);
const char *hl_host_atomic_pair16_detail(void);
void hl_host_atomic_pair16_assume_absent(void);

#endif
