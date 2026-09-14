#ifndef HL_TRANSLATOR_GUEST_X86_64_GLUE_H
#define HL_TRANSLATOR_GUEST_X86_64_GLUE_H

#include "../../identity.h"
#include "../../reloc.h"
#include "hl/host_services.h"

#include <stdint.h>

#define XIBTC_SETS 8192
#define XIBTC_WAYS 2
#define PC_RELOC_CAP (1u << 20)

enum { PRELOC_BLOCKRET = 1, PRELOC_IBTC = 2, PRELOC_HOSTGLOBAL = 3 };

// 16-byte aligned so that BOTH ways of a set are naturally aligned 16-byte pairs: HL_X86_MT_IBTC
// publishes an entry with one `stp` and the emitted probe consumes it with one `ldp`, and the
// single-copy atomicity that makes that race-free (FEAT_LSE2) requires natural alignment.
typedef struct __attribute__((aligned(16))) hl_x86_ibtc_entry {
    uint64_t target;
    void *body;
} hl_x86_ibtc_entry;

// Atomic 128-bit RELEASE publish of a {target, body} pair into a 16-byte-aligned IBTC slot.
// Single writer (the dispatcher holds g_jit_lock across every fill); many lock-free readers in
// emitted code.  `dmb ish` orders everything that made `body` executable -- the translation stores
// and jit_publish_code()'s dc/dsb/ic/dsb -- before the pair becomes observable.  The `stp` of two X
// registers to a 16-byte-aligned address is single-copy atomic under FEAT_LSE2, so it is mutually
// atomic with the probe's plain `ldp`: a reader sees the pair whole or not at all, never torn.
// This is a verbatim sibling of translator/cache.c's ibtc_publish(), which the aarch64-guest
// backend already relies on; it is repeated here only because the x86 backend's 2-way table has its
// own entry type.  Explicit asm rather than a 16-byte __atomic, which may lower to a lock-taking
// libatomic call that would not be atomic against the lock-free reader.
static inline void hl_x86_xibtc_publish(hl_x86_ibtc_entry *e, uint64_t target, void *body) {
#if defined(HL_HOST_CPU_AARCH64)
    __asm__ volatile("dmb ish\n\t"
                     "stp %1, %2, [%0]\n\t"
                     :
                     : "r"(e), "r"(target), "r"(body)
                     : "memory");
#else
    // x86-TSO gives the ordering for free; the 16-byte access still has to be indivisible on BOTH
    // sides, and `lock` cannot make the reader's plain load indivisible -- hence movdqa.
    typedef unsigned long long hl_x86_ibtc_pair __attribute__((vector_size(16)));
    hl_x86_ibtc_pair pair = {target, (unsigned long long)(uintptr_t)body};
    __asm__ volatile("movdqa %1, %0" : "=m"(*e) : "x"(pair) : "memory");
#endif
}

// HL_X86_IBTC8 RELEASE PUBLISH of an 8-byte body hint.  The entry's `target` word is retained as
// the single writer's own way-selection bookkeeping (it is read only under g_jit_lock, never by
// emitted code); the ONLY word emitted code reads is `body`, and it is read as ONE naturally
// aligned 8-byte load, which DDI 0487 B2.2.1 makes single-copy atomic on every Armv8 part with no
// FEAT_LSE2 and no alignment beyond the access size.  The reader re-validates the tag from the
// immutable header at body-8 through an address dependency (see emit_ibranch), so any whole pointer
// it observes -- new or stale -- is either accepted for the right guest PC or rejected.  A release
// store is used rather than a bare one so that everything that made `body` executable, and the
// header write in particular, is ordered before the pointer becomes observable; the reader's
// address dependency is the matching consume side.
static inline void hl_x86_xibtc_publish8(hl_x86_ibtc_entry *e, uint64_t target, void *body) {
    e->target = target; // writer-private; emitted code never loads it under HL_X86_IBTC8
    __atomic_store_n(&e->body, body, __ATOMIC_RELEASE);
}

extern uint64_t g_emit_gpc;
extern uint64_t g_disp_n;
extern int g_dispatch_diagnostics;
extern uint64_t g_ibtc_fill;
extern uint64_t g_repmovs_n;
extern uint64_t g_repstos_n;
extern hl_x86_ibtc_entry g_xibtc[XIBTC_SETS * XIBTC_WAYS];
extern int g_coldprof;
extern uint64_t g_pcache_identity_ns, g_pcache_identity_bytes, g_pcache_identity_files;
extern int g_pcache;
extern int g_pcache_loaded;
extern hl_identity_digest g_pc_binid;
extern uint64_t g_pc_entry;
extern uint64_t g_force_base;
extern hl_reloc g_reloc_storage[PC_RELOC_CAP];
extern hl_reloc_table g_reloc_table;
#define g_reloc (g_reloc_table.records)
#define g_nreloc (g_reloc_table.count)
extern int g_pcache_poison;
extern uint64_t g_loadbase;
extern const char *g_exe_path;
extern const char *g_self_path;
extern uint64_t g_pmovmskb_n;
extern uint64_t g_prof_t2fold;
extern uint64_t g_prof_xflag;
extern uint64_t g_prof_xflag_scan;

/* x86->ARM64 static-expansion mechanism census (translate-time only; every one of
   these is incremented while a block is being BUILT, never while it executes).
   Wired into the diagnostics record by hl_x86_a64_route_report in translate.c. */
extern uint64_t g_x86_mech_dmb_emit;       /* DMB ISHST/ISHLD actually emitted */
extern uint64_t g_x86_mech_dmb_elide;      /* barrier site reached with no observer -> elided */
extern uint64_t g_x86_mech_ea_record;      /* address_record_guest str of the guest EA */
extern uint64_t g_x86_mech_ea_deadstore;   /* emit_memory_guard's !g_address_recorded EA str */
extern uint64_t g_x86_mech_ea_guard;       /* emit_memory_guard call sites reached */
extern uint64_t g_x86_mech_pfaf_attempt;   /* PF/AF-writing insn offered to the liveness test */
extern uint64_t g_x86_mech_pfaf_dead;      /* ... of which the test proved PF+AF dead */
extern uint64_t g_x86_mech_rmload_mem;     /* rm_load taking its memory-operand path */
extern uint64_t g_x86_mech_rmload_foldable;/* ... of which ea_imm_fold WOULD have folded */
extern uint64_t g_x86_mech_rmload_folded;  /* ... of which the fold was actually emitted */

uint64_t coldprof_now_ns(const hl_host_services *services);
void hl_x86_count_rep_movs(void);
void hl_x86_count_rep_stos(void);

#endif
