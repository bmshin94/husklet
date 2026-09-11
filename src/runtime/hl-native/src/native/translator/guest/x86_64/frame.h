#ifndef HL_TRANSLATOR_GUEST_X86_64_FRAME_H
#define HL_TRANSLATOR_GUEST_X86_64_FRAME_H

#include <stdint.h>

struct cpu;

typedef int (*hl_x86_signal_cache_fn)(void *context, uint64_t pc);
typedef uint64_t (*hl_x86_signal_handler_fn)(void *context, int signal_number);

typedef struct hl_x86_signal_state {
    uint64_t handler;
    uint64_t flags;
    uint64_t mask;
    int *error;
    int *code;
    uint64_t *value;
    uint64_t *address;
    int *pid;
    int *uid;
    uint64_t sigreturn_pc;
    int trace;
} hl_x86_signal_state;

typedef struct hl_x86_signal_queue {
    hl_x86_signal_handler_fn handler;
    void *context;
    int *codes;
    uint64_t *addresses;
    volatile uint64_t *pending;
} hl_x86_signal_queue;

/* HL_X86_EXIT_THUNK: route unresolved constant-rip block exits and the IBTC miss tail through one
   shared per-arena thunk body. The flag lives in the AArch64 emitter (emit.c), which is textually
   included only on an AArch64 host; every other host takes the transliterator/interpreter, has no
   exit thunks at all, and links the no-op stub in engine/target/x86_64.c. Launch code therefore sets
   the option through this seam rather than touching the emitter's static directly. */
void hl_x86_emit_set_exit_thunk(int enabled);

uint64_t hl_x86_signal_nzcv_to_eflags(uint64_t nzcv);
uint64_t hl_x86_signal_eflags_to_nzcv(uint64_t eflags);
void hl_x86_signal_build(struct cpu *cpu, int signal_number, const hl_x86_signal_state *state);
void hl_x86_signal_restore(struct cpu *cpu);
int hl_x86_signal_capture(struct cpu *cpu, void *native_context, hl_x86_signal_cache_fn cache_contains,
                          void *callback_context);
void hl_x86_signal_resume(struct cpu *cpu, void *native_context, uintptr_t dispatcher_return);
int hl_x86_signal_fast_clock_fault(struct cpu *cpu, uintptr_t fault_address, void *native_context);
int hl_x86_signal_raise_divide(struct cpu *cpu, const hl_x86_signal_queue *queue, int si_code);
int hl_x86_signal_raise_trap(struct cpu *cpu, const hl_x86_signal_queue *queue);

#endif
