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

typedef struct hl_x86_ibtc_entry {
    uint64_t target;
    void *body;
} hl_x86_ibtc_entry;

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

uint64_t coldprof_now_ns(const hl_host_services *services);
void hl_x86_count_rep_movs(void);
void hl_x86_count_rep_stos(void);

#endif
