// Runtime host-CPU capability probes. Contract and the architectural citations: cpu_features.h.
#include "cpu_features.h"

#include "cpu.h"

/* Tri-state cache: -1 not yet probed, 0 absent, 1 present. `g_assume_absent` latches the test
   override separately so it survives a probe that has already run. */
static int g_pair16 = -1;
static int g_assume_absent;
static const char *g_pair16_detail = "not probed";

#if defined(HL_HOST_CPU_AARCH64) && defined(__linux__)
#include <sys/auxv.h>
/* FEAT_LSE2. Bit 25 of AT_HWCAP, `uscat` in /proc/cpuinfo. Defined here rather than relied upon
   from <bits/hwcap.h> because an older libc's header may predate the bit; the VALUE is ABI and
   cannot change. Deliberately NOT HWCAP2_LSE128, which is a different, later feature. */
#ifndef HL_HWCAP_USCAT
#define HL_HWCAP_USCAT (1UL << 25)
#endif

static int hl_probe_pair16(void) {
    unsigned long hwcap = getauxval(AT_HWCAP);
    if (hwcap & HL_HWCAP_USCAT) {
        g_pair16_detail = "aarch64: FEAT_LSE2 present (AT_HWCAP bit 25, HWCAP_USCAT/uscat)";
        return 1;
    }
    g_pair16_detail = "aarch64: FEAT_LSE2 ABSENT (AT_HWCAP bit 25, HWCAP_USCAT/uscat, is clear)";
    return 0;
}

#elif defined(HL_HOST_CPU_AARCH64) && defined(__APPLE__)
#include <sys/sysctl.h>
/* Every Apple Silicon part is ARMv8.5+ and therefore has FEAT_LSE2 unconditionally, but ask
   anyway: the sysctl is authoritative and costs one call at init. */
static int hl_probe_pair16(void) {
    int value = 0;
    size_t size = sizeof value;
    if (sysctlbyname("hw.optional.arm.FEAT_LSE2", &value, &size, (void *)0, 0) == 0 && value) {
        g_pair16_detail = "aarch64: FEAT_LSE2 present (sysctl hw.optional.arm.FEAT_LSE2)";
        return 1;
    }
    g_pair16_detail = "aarch64: FEAT_LSE2 not reported by sysctl hw.optional.arm.FEAT_LSE2";
    return 0;
}

#elif defined(HL_HOST_CPU_X86_64)
/* The 16-byte guarantee for an aligned SSE access is documented for AVX-capable parts (Intel SDM
   Vol.3A 9.1.1; AMD APM Vol.2 7.3.2). __builtin_cpu_supports emits the CPUID/XGETBV sequence and
   is available on both compilers that build this tree for an x86-64 host. */
static int hl_probe_pair16(void) {
#if defined(__GNUC__) || defined(__clang__)
    if (__builtin_cpu_supports("avx")) {
        g_pair16_detail = "x86_64: aligned 16-byte SSE access atomic (AVX enumerated)";
        return 1;
    }
    g_pair16_detail = "x86_64: AVX absent, aligned 16-byte SSE atomicity not architecturally stated";
    return 0;
#else
    g_pair16_detail = "x86_64: no CPUID probe available for this compiler";
    return 0;
#endif
}

#else
static int hl_probe_pair16(void) {
    g_pair16_detail = "no 16-byte pair atomicity probe for this host";
    return 0;
}
#endif

int hl_host_atomic_pair16(void) {
    if (g_assume_absent) {
        g_pair16 = 0;
        g_pair16_detail = "forced ABSENT by HL_HOST_ASSUME_NO_LSE2 (test injection)";
        return 0;
    }
    if (g_pair16 < 0) g_pair16 = hl_probe_pair16();
    return g_pair16;
}

const char *hl_host_atomic_pair16_detail(void) {
    (void)hl_host_atomic_pair16();
    return g_pair16_detail;
}

void hl_host_atomic_pair16_assume_absent(void) {
    g_assume_absent = 1;
    g_pair16 = 0;
    g_pair16_detail = "forced ABSENT by HL_HOST_ASSUME_NO_LSE2 (test injection)";
}
