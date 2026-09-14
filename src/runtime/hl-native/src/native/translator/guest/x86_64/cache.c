// translator/guest/x86_64 persistent translated-code cache (HL_PCACHE=1; default off).
//
// Idea: cold start of a short-lived container is dominated by translating the dynamic linker (musl
// ld.so) + the program's startup path -- ~1000 blocks for `busybox echo`. That work is identical on
// every launch of the same binary. We persist the translated arena + block map to a file and mmap it
// back on the next run of the same binary, skipping translation entirely (~40% of internal cold start).
//
// What makes the bytes reusable across *processes*:
//   * The guest image + interp are mapped at FIXED addresses (PC_IMG_BASE / PC_INTERP_BASE), so guest
//     PCs (the block-map keys) and any guest address baked into host code are stable, and arena-internal
//     absolute pointers (g_map host/body, g_pend slots) + PC-relative chaining are valid as-is on reload.
//   * The host addresses baked into emitted blocks (block_return, &g_ibtc, &g_fast_count, &g_pending,
//     &g_sig_inline_count, &g_yield_inline_count, &hl_rep_movs/stos, ...) ALL live in this one PIE binary,
//     which dyld slides as a unit; each baked site is emitted as a fixed 4-insn movz/movk slot and recorded
//     in g_reloc, and rewritten on load by the single image slide. if the g_reloc table ever fills we
//     poison the arena (g_pcache_poison) so save() refuses -- a persisted arena has EVERY baked site
//     recorded by construction, so a reload can never keep a stale absolute host address (was: silent drop
//     -> intermittent, ASLR-slide-dependent SIGSEGV once the arena grew past the old 1<<16 cap).
//   * The JIT arena does NOT need fixing (MAP_JIT can't be MAP_FIXED anyway): g_map/g_pend are persisted
//     as arena OFFSETS and rebuilt against the live g_cache.
//   * LIBRARY blocks. The dynamic linker's library maps land wherever the host kernel places them,
//     which used to make every library block's gpc key non-reusable (dead weight in the restored map --
//     and worse, a LIVE hazard: a later run mapping a DIFFERENT lib over a cached gpc range would HIT a
//     stale translation of the old bytes -> intermittent warm-only SIGSEGV). Now, when the cache is on,
//     the guest's file-backed non-fixed mmaps get DETERMINISTIC base hints from a per-process bump
//     allocator at PC_LIB_BASE (os/linux/syscall/mem.c hook), and each hinted map that lands on its hint
//     is recorded in a MANIFEST {base, len, file-identity}. Library blocks are persisted with the
//     manifest, and on a warm run they are NOT inserted into the block map at load -- they are DEFERRED
//     and only activated when the guest actually maps a file with the SAME identity at the SAME base
//     (pcache_note_libmap). Identity mismatch / different layout -> those blocks are dropped. So a
//     restored block can never shadow different guest bytes, by construction.
//
// Invalidation: the cache file is keyed by (engine version, cpu-struct size, map/IBTC sizes, both fixed
// bases, entry PC, argv[0] basename, and the identity -- dev/ino/size/mtime -- of the guest binary AND
// its interpreter). Any mismatch / truncation / corruption -> graceful MISS: ignore the file and
// translate fresh, re-save.
//
// EXEC RE-KEY: an in-process execve (proc.c case 221) flushes the arena and re-loads a NEW image;
// both the save AND load side re-key at that boundary (pcache_exec_reload). g_pc_binid/g_pc_entry are
// ONLY ever assigned (a) at initial load, before any translation, and (b) inside pcache_exec_reload,
// immediately after the exec flushed the arena -- so the key can never describe a different image than
// the arena content. (Pre-#373 the x86 engine never re-keyed: a `sh -c tar` run persisted tar's arena
// under busybox-sh's key -- an accidental win for that chain, silent poison for every other exec.)
//
// WARM-STAT SELF-TUNING: a sidecar "<file>.warm" records how much of the restored map a warm run
// actually reused (waste = restored blocks that never became usable -- deferred library entries whose
// image never re-mapped with the matching identity). When waste*2 >= restored, the restore is dead
// weight (layout drifted / lib changed) -> later runs SKIP the restore entirely (header-only read, no
// arena I/O, no map pollution) instead of paying for it. Fresh translations of NEW code never count
// against the restore (a bigger workload under the same key must not poison the policy). The sidecar is
// advisory only: it never gates correctness, only the restore/skip decision, and it is written with the
// same atomic temp+rename protocol (the .pcache file itself is NEVER modified after publication).

#include "../../cache_abi.h"
#include "../../digest.h"
#include "../../identity.h"
#include "../../window.h"
#include "../../persist.h"

#define PC_MAGIC 0x31304350544a4c48ull // "HLJTPC01" (LE)
#define PC_VERSION 12                  // v12 keys library mappings by mapped-file CONTENT digest.
#define PC_VERSION_EFF PC_VERSION
#define PC_TRANSLATOR_ABI HL_PCACHE_ABI_X86_64
// Fixed guest VA bases (high, reliably free above the kernel-chosen heap/stack and below the dyld shared
// cache). Probed stable on Apple silicon; PIE images so we choose the base.
#define PC_IMG_BASE 0x0000040000000000ull    // 4 TB
#define PC_INTERP_BASE 0x0000048000000000ull // 4.5 TB
// deterministic library window (file-backed non-fixed guest mmaps get bump-allocated hints here).
#define PC_LIB_BASE 0x0000050000000000ull // 5 TB
#define PC_LIB_SPAN (1ull << 38)          // 256 GB window (beyond it: no hint, kernel placement)
#define PC_LIB_MAX 512                    // manifest entries persisted (beyond: unhinted, not cached)
// Cap on a library whose CONTENT we are willing to digest. A mapping bigger than this is simply not
// cacheable (no hint, no manifest) rather than silently falling back to a weaker identity.
#define PC_LIB_HASH_MAX (UINT64_C(512) << 20)

static hl_persist_directory g_pc_directory;
static char g_pc_directory_path[1024];

struct pc_hdr {
    uint64_t magic, version;
    uint64_t translator_abi;
    uint64_t cpu_sz, map_n, ibtc_n;
    uint64_t img_base, interp_base;
    hl_identity_digest bin_id; // full identity of guest binary + interp + argv0 + engine build
    uint64_t entry_jump;       // initial rip (sanity)
    uint64_t arena_used;       // bytes of translated code
    uint64_t n_mapent, n_pend, n_reloc, n_lib;
    uint64_t csum;            // v6: FNV-1a over every byte after this header (parity with the aarch64 pcache)
    uint64_t block_return_at; // block_return's host addr at save time -> the image-slide anchor on load
    uint64_t ibtc_at;         // g_ibtc host addr at save time (diagnostic)
    uint64_t generation;      // v12: how many bounded warm re-saves this file has accumulated
};

struct pc_mapent {
    uint64_t gpc, guest_start, guest_end, host_off, body_off;
}; // host/body as arena offsets

struct pc_pend {
    uint64_t slot_off, target;
    uint32_t is_bl;
};

struct pc_lib {
    uint64_t base, len, id;     // manifest: a deterministic-hinted file map (id = fstat identity hash)
    hl_identity_digest content; // v12: SHA-256 of the mapped file's bytes -- the activation AUTHORITY
};

// warm-stat sidecar ("<cachefile>.warm"): written by warm runs, read by the next load's
// restore-or-skip decision. Advisory only -- validated against the .pcache generation via arena_used/
// restored, ignored (and the restore performed as usual) on any mismatch.
struct pc_warm {
    uint64_t magic, arena_used, restored, waste; // waste = restored blocks that never became usable
    uint64_t strikes;                            // v12: consecutive dead-weight verdicts, decaying
};

#define PC_WARM_MAGIC UINT64_C(0x334d525743504c48) // "HLPCWRM3" (LE) -- v12 adds the strike counter

// ---- convergence bounds (HL_PCACHE_CONVERGE; default off) ----
// The once-only save rule exists for a real reason: a warm run keeps translating -- notably tier-2
// hot-block recompiles, which re-emit into the arena WITHOUT a map entry -- so arena_used grows every
// run. Re-persisting that unboundedly snowballs the file across sequential runs until it overruns
// CACHE_SZ, and before the next load's bounds check can turn that into a graceful miss the in-memory
// arena has already run past its end (silent guest SIGSEGV). So a re-save is allowed only while BOTH
// bounds hold: the arena still fits well inside the cap, and the file has not already re-saved too
// many times. Within those bounds the file learns the steady-state working set instead of being frozen
// at whatever the least representative run (the very first one) happened to touch.
#define PC_RESAVE_ARENA_MAX (CACHE_SZ / 2) // hard ceiling on a re-saved arena
#define PC_RESAVE_GEN_MAX 8                // stop growing the file after this many re-saves
#define PC_WARM_STRIKE_MAX 3               // consecutive dead-weight verdicts before restores are skipped

static int g_pcache_forked;          // set in a fork child (fresh arena, inherited bookkeeping) -> never save
static int g_pcache_skip;            // this run intentionally skipped a dead-weight restore -> don't churn-resave
static int g_pc_flushed;             // a wholesale cache flush ran this epoch (restored blocks are gone)
static uint64_t g_pc_restored_n;     // mapents the last load restored (0 = no load this epoch)
static uint64_t g_pc_restored_arena; // arena_used of the loaded file (sidecar generation tie)
// The two fixed images' live guest spans, recorded by load_elf when it consumes g_force_base. Everything
// outside these spans (and outside the manifest) is unrevivable by key construction and is neither
// persisted nor restored into the block map.
static uint64_t g_pc_img_lo, g_pc_img_hi, g_pc_interp_lo, g_pc_interp_hi;
// #210: latched by load_elf (linux_abi/x86.c) when a fixed-VA (MAP_FIXED) image map collides and falls back to a
// kernel-chosen base. This run's arena then mixes bases, so the pcache must neither RESTORE a fixed-base
// file over it (block-map keys + baked guest addresses belong to PC_IMG_BASE, not the fallback base ->
// wild fault) nor PERSIST one (a later fixed-base run could HIT a file whose baked bytes name a random
// base). Parity with the aarch64 loader's g_force_base_failed (guest/aarch64/cache.c).
static int g_force_base_failed;
// runtime state: the deterministic-hint bump pointer, the manifest this run RECORDS (cold path),
// the manifest the load RESTORED (warm path), and the deferred (not-yet-activated) restored map entries.
static uint64_t g_pc_lib_next = PC_LIB_BASE;
static struct pc_lib g_pc_libs[PC_LIB_MAX]; // cold: recorded as the guest maps; warm: the file's manifest
static int g_pc_nlib;
static struct pc_mapent *g_pc_defer; // deferred restored entries (library gpc ranges), until activation
static uint64_t g_pc_ndefer;
static uint64_t g_pc_live_n;    // restored entries that went live at load (fixed-image ranges)
static uint64_t g_pc_activated; // deferred entries activated by identity-matching library maps

static uint64_t pcache_id_of(const char *path) {
    return hl_identity_source(&g_jit_services, path);
}

// A per-engine-build tag mixed into every cache id so the cache self-invalidates across engine builds:
// host code emitted by a DIFFERENT engine build must never be loaded, because loading it executes
// instructions the current translator would not have emitted.
//
// The explicit translator ABI is authoritative for embedded engines, where g_self_path identifies the
// outer application rather than the translator archive. The executable identity and compile-time tag remain
// useful mix-ins, but neither replaces bumping PC_TRANSLATOR_ABI after an incompatible codegen change.
static uint64_t pcache_engine_id(void) {
    uint64_t h = 1469598103934665603ull;
    uint64_t modes;
    uint64_t self = pcache_id_of(g_self_path);
    for (const char *p = __DATE__ " " __TIME__; *p; p++) {
        h ^= (uint8_t)*p;
        h *= 1099511628211ull;
    }
    h ^= self;
    h *= 1099511628211ull;
    h ^= PC_TRANSLATOR_ABI;
    h *= 1099511628211ull;
    modes = (uint64_t)(g_fastsys != 0) | ((uint64_t)(g_fastclk != 0) << 1) | ((uint64_t)(g_siginline != 0) << 2) |
            ((uint64_t)(slimsys_on() != 0) << 3);
    return hl_identity_configuration(h, 2, HL_HOST_CPU_ISA, modes);
}

static hl_identity_digest pcache_translator_identity(void) {
    static const char tag[] = __DATE__ " " __TIME__;
    uint64_t modes = (uint64_t)(g_fastsys != 0) | ((uint64_t)(g_fastclk != 0) << 1) |
                     ((uint64_t)(g_siginline != 0) << 2) | ((uint64_t)(slimsys_on() != 0) << 3);
    return hl_identity_engine_digest(tag, sizeof tag - 1, PC_TRANSLATOR_ABI, 2, HL_HOST_CPU_ISA, modes,
                                     hl_c_backend_build_fingerprint());
}

// hash the BASENAME of argv[0]. A multicall binary (busybox, toolchain drivers) runs a DIFFERENT
// code path per applet, and with the exec re-key each epoch persists its own arena -- so the key must
// separate `sh` from `tar` or one applet's arena would shadow the other's. Basename (not full argv) so a
// single-purpose binary invoked with varying flags keeps ONE cache (mirrors the aarch64 pcache).
static uint64_t pcache_argv0_id(const char *argv0) {
    return hl_identity_name(argv0);
}

static hl_identity_digest pcache_make_id(hl_identity_digest program, hl_identity_digest interpreter,
                                         const char *argv0) {
    return hl_identity_digest_mix(program, interpreter, pcache_translator_identity(), argv0);
}

static int pcache_file(char *out, size_t n) {
    const char *dir = hl_option_get("HL_PCACHE_DIR");
    if (!dir || !dir[0]) dir = "/tmp/hl-engine-pcache-x86_64";
    if (g_pc_directory.handle != HL_HOST_HANDLE_INVALID && strcmp(g_pc_directory_path, dir) != 0) {
        (void)hl_persist_directory_close(&g_pc_directory);
        g_pc_directory_path[0] = 0;
    }
    if (g_pc_directory.handle == HL_HOST_HANDLE_INVALID &&
        !hl_persist_directory_open(&g_pc_directory, &g_jit_services, dir, 1))
        return 0;
    if (!g_pc_directory_path[0]) {
        int copied = snprintf(g_pc_directory_path, sizeof g_pc_directory_path, "%s", dir);
        if (copied <= 0 || (size_t)copied >= sizeof g_pc_directory_path) {
            (void)hl_persist_directory_close(&g_pc_directory);
            g_pc_directory_path[0] = 0;
            return 0;
        }
    }
    static const char hex[] = "0123456789abcdef";
    if (n < 72) return 0;
    for (size_t i = 0; i < sizeof g_pc_binid.bytes; ++i) {
        out[i * 2] = hex[g_pc_binid.bytes[i] >> 4];
        out[i * 2 + 1] = hex[g_pc_binid.bytes[i] & 15];
    }
    memcpy(out + 64, ".pcache", 8);
    return 1;
}

static void pcache_directory_close(void) {
    if (g_pc_directory.handle != HL_HOST_HANDLE_INVALID) (void)hl_persist_directory_close(&g_pc_directory);
    g_pc_directory_path[0] = 0;
}

// ---- deterministic library-map hints + the identity manifest ----
// load_elf (linux_abi/x86.c) records the two fixed images' spans when it consumes g_force_base;
// everything else revivable must come from a manifest-validated library map.
static int g_pc_converge = -1;      // -1 undecided; 0 off (default); 1 on
static uint64_t g_pc_generation;    // generation of the file this epoch loaded (0 when cold)
static uint64_t g_pc_warm_strikes;  // strike count carried in from the loaded file's sidecar

static int pcache_converge_enabled(void) {
    if (g_pc_converge < 0) g_pc_converge = hl_option_flag_value("HL_PCACHE_CONVERGE", 0);
    return g_pc_converge;
}

static int g_pc_link_image = -1; // -1 undecided; 0 off (default); 1 on

// A non-PIE ET_EXEC is mapped AT ITS LINK ADDRESS (nonpie_place_at_link_address returns exactly that
// address or fails), so its guest PCs are already deterministic across runs -- which is the only
// property g_force_base exists to manufacture for a PIE image. Treating it as a revivable fixed image
// is therefore sound, and the cache key already pins the image's content identity, so a hit cannot
// describe different bytes at those addresses.
static int pcache_link_image_enabled(void) {
    if (g_pc_link_image < 0) g_pc_link_image = hl_option_flag_value("HL_PCACHE_LINK_IMAGE", 0);
    return g_pc_link_image;
}

// `role` names which image this is rather than inferring it from the address. The previous form
// classified by comparing base against PC_INTERP_BASE / PC_IMG_BASE, which silently recorded NOTHING
// for a non-PIE main image at its link address (e.g. 0x400000 < PC_IMG_BASE = 4 TB). Every block of
// such an image then failed pc_gpc_fixed(), so pcache_save's revivability filter dropped all of them
// and pcache_load had nothing to restore -- the cache "worked" while reviving almost nothing.
#define PC_IMG_ROLE_MAIN 0
#define PC_IMG_ROLE_INTERP 1

static void pcache_note_fixed_img_role(uint64_t base, uint64_t span, int role) {
    if (role == PC_IMG_ROLE_INTERP) {
        g_pc_interp_lo = base;
        g_pc_interp_hi = base + span;
    } else {
        g_pc_img_lo = base;
        g_pc_img_hi = base + span;
    }
}

static void pcache_note_fixed_img(uint64_t base, uint64_t span) {
    pcache_note_fixed_img_role(base, span, base >= PC_INTERP_BASE ? PC_IMG_ROLE_INTERP : PC_IMG_ROLE_MAIN);
}

// The deterministic-link-address main image. Default off: an unset launch keeps the old behaviour, in
// which this image contributes nothing to the cache.
#define PCACHE_LINK_IMAGE_HOOK 1

static void pcache_note_link_img(uint64_t base, uint64_t span) {
    if (!g_pcache || !pcache_link_image_enabled()) return;
    pcache_note_fixed_img_role(base, span, PC_IMG_ROLE_MAIN);
}

static int pc_gpc_fixed(uint64_t gpc) {
    return (gpc >= g_pc_img_lo && gpc < g_pc_img_hi) || (gpc >= g_pc_interp_lo && gpc < g_pc_interp_hi);
}

static int pc_gpc_in_lib(uint64_t gpc) { // in the RECORDED (cold) / RESTORED (warm) manifest?
    for (int i = 0; i < g_pc_nlib; i++)
        if (gpc >= g_pc_libs[i].base && gpc < g_pc_libs[i].base + g_pc_libs[i].len) return 1;
    return 0;
}

// ---- cross-process translation census (diagnostic; HL_XLAT_CENSUS=<path>) ----
// Sizes the reuse prize WITHOUT disabling the cache: it hangs off its own option, not g_prof, so a run
// can cache and be observed at the same time. Every genuine translation (dispatch.c's map-miss site)
// records the PROVENANCE of the block it is about to emit -- the backing file's (dev, ino) plus the
// block's byte offset WITHIN that file -- which is the only block name that is stable across processes
// (the guest VA is not: libraries land wherever the kernel puts them). At each epoch boundary (guest
// exit or in-process execve) the buffered keys are appended to the census file. Aggregating the file
// over a whole multi-process workload answers the question directly: total translations vs DISTINCT
// provenance keys = how much translation work is re-translation of bytes some earlier epoch already did.
struct pc_census_key {
    uint64_t dev, ino, off;
};

static struct pc_census_key *g_census_buf;
static size_t g_census_n, g_census_cap;
static uint64_t g_census_xlat;   // genuine translations this epoch
static uint64_t g_census_anon;   // translations with no file backing (unnameable across processes)
static int g_census_on = -1;     // -1 = undecided, 0 = off, 1 = on
static unsigned g_census_epoch;  // exec epoch ordinal within this process

// Guest text ranges whose bytes have a NAME that survives a process boundary. Populated from the two
// places an executable guest range can come from: the engine's own ELF loader (main image + PT_INTERP,
// mapped as anonymous memory with the file read in, so the kernel's file-mapping registry never sees
// them) and the typed VFS file-mapping route in syscall/binding/watch.c (every shared library the guest
// dynamic linker loads -- these never reach the raw mmap syscall path, which is why the census has to
// hook the typed route rather than the host's own mapping tables).
static int pc_census_enabled(void);

#define PC_CENSUS_MAP_MAX 1024
struct pc_census_map {
    uint64_t lo, hi, off, dev, ino;
};
static struct pc_census_map g_census_map[PC_CENSUS_MAP_MAX];
static int g_census_nmap;
static pthread_mutex_t g_census_lock = PTHREAD_MUTEX_INITIALIZER;

static void pc_census_note_map(uint64_t base, uint64_t len, uint64_t off, uint64_t dev, uint64_t ino) {
    if (!pc_census_enabled() || !len || base > UINT64_MAX - len) return;
    pthread_mutex_lock(&g_census_lock);
    if (g_census_nmap < PC_CENSUS_MAP_MAX) {
        g_census_map[g_census_nmap].lo = base;
        g_census_map[g_census_nmap].hi = base + len;
        g_census_map[g_census_nmap].off = off;
        g_census_map[g_census_nmap].dev = dev;
        g_census_map[g_census_nmap].ino = ino;
        g_census_nmap++;
    }
    pthread_mutex_unlock(&g_census_lock);
}

// Newest-first: a MAP_FIXED segment laid over an earlier whole-file reservation is the authority for
// its range, and it was recorded later.
static int pc_census_provenance(uint64_t gpc, uint64_t *dev, uint64_t *ino, uint64_t *off) {
    int found = 0;
    pthread_mutex_lock(&g_census_lock);
    for (int i = g_census_nmap - 1; i >= 0; i--) {
        if (gpc < g_census_map[i].lo || gpc >= g_census_map[i].hi) continue;
        *dev = g_census_map[i].dev;
        *ino = g_census_map[i].ino;
        *off = g_census_map[i].off + (gpc - g_census_map[i].lo);
        found = 1;
        break;
    }
    pthread_mutex_unlock(&g_census_lock);
    return found;
}

static const char *pc_census_path(void) {
    const char *p = hl_option_get("HL_XLAT_CENSUS");
    return (p && p[0]) ? p : NULL;
}

static int pc_census_enabled(void) {
    if (g_census_on < 0) g_census_on = pc_census_path() != NULL;
    return g_census_on;
}

// Called from the dispatcher's map-miss translate site, i.e. once per genuine block translation.
static void pc_census_note(uint64_t gpc) {
    if (!pc_census_enabled()) return;
    g_census_xlat++;
    uint64_t dev = 0, ino = 0, off = 0;
    if (!pc_census_provenance(gpc, &dev, &ino, &off)) {
        g_census_anon++;
        return;
    }
    if (g_census_n == g_census_cap) {
        size_t cap = g_census_cap ? g_census_cap * 2 : 4096;
        struct pc_census_key *grown = realloc(g_census_buf, cap * sizeof *grown);
        if (!grown) return; // out of memory: drop the key, keep the counters honest via g_census_xlat
        g_census_buf = grown;
        g_census_cap = cap;
    }
    g_census_buf[g_census_n].dev = dev;
    g_census_buf[g_census_n].ino = ino;
    g_census_buf[g_census_n].off = off;
    g_census_n++;
}

// Flush this epoch's keys and its summary line. Appends (O_APPEND) so every process and every exec
// epoch of a multi-process workload lands in one file without coordination.
static void pc_census_epoch_end(const char *outcome) {
    if (!pc_census_enabled()) return;
    const char *path = pc_census_path();
    if (!path) {
        g_census_n = 0;
        g_census_xlat = g_census_anon = 0;
        return;
    }
    size_t cap = 256 + g_census_n * 56;
    char *out = malloc(cap);
    if (out) {
        int w = snprintf(out, cap, "EPOCH pid=%ld gen=%u outcome=%s xlat=%llu anon=%llu keyed=%zu restored_live=%llu activated=%llu deferred=%llu maps=%d flushed=%d\n",
                         (long)getpid(), g_census_epoch, outcome, (unsigned long long)g_census_xlat,
                         (unsigned long long)g_census_anon, g_census_n, (unsigned long long)g_pc_live_n,
                         (unsigned long long)g_pc_activated, (unsigned long long)g_pc_ndefer, g_census_nmap, g_pc_flushed);
        size_t used = (w > 0) ? (size_t)w : 0;
        for (size_t i = 0; i < g_census_n && used + 56 < cap; i++) {
            int k = snprintf(out + used, cap - used, "K %llx %llx %llx\n", (unsigned long long)g_census_buf[i].dev,
                             (unsigned long long)g_census_buf[i].ino, (unsigned long long)g_census_buf[i].off);
            if (k <= 0) break;
            used += (size_t)k;
        }
        /* One file per (process, exec epoch): a forking workload has many engine processes writing
           concurrently, and per-epoch files remove any interleaving question from the aggregate. */
        char shard[1200];
        int shard_written = snprintf(shard, sizeof shard, "%s.%ld.%u", path, (long)getpid(), g_census_epoch);
        if (shard_written <= 0 || (size_t)shard_written >= sizeof shard) {
            free(out);
            goto census_done;
        }
        int fd = open(shard, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
        if (fd >= 0) {
            ssize_t ignored = write(fd, out, used);
            (void)ignored;
            close(fd);
        }
        free(out);
    }
census_done:
    g_census_n = 0;
    g_census_xlat = g_census_anon = 0;
    g_census_epoch++;
    pthread_mutex_lock(&g_census_lock);
    g_census_nmap = 0; // execve replaces the address space; the next epoch re-registers its own ranges
    pthread_mutex_unlock(&g_census_lock);
}

#define G_TRANSLATE_CENSUS(pc) pc_census_note(pc)
#define G_XLAT_CENSUS_EPOCH(outcome) pc_census_epoch_end(outcome)

// ---- deterministic library hinting + content-keyed manifest (HL_PCACHE_LIBS; default off) ----
//
// WHAT d28f70475 CLOSED, AND WHY THIS IS NOT A REVERT.
// That commit reacted to a real hazard: a file-backed mapping is MUTABLE. A translation cached for the
// guest VA range of "some library" is only sound if the bytes at that range are the bytes it was
// translated from -- and the v11 manifest proved that with dev/ino/size/mtime alone. A stat tuple can
// repeat across genuinely different content (mtime granularity, a restored backup, an overlay/bind
// swapping the lower file, a rebuild landing in the same second), so a warm run could activate a
// translation over different bytes. That is a silent wrong-code execution, not a miss.
// Rather than delete the check, this keys activation on the mapped file's CONTENT: the manifest records
// a SHA-256 over the file's bytes, and a warm run activates deferred blocks only when the file it
// actually mapped hashes to the same value at the same base with the same length. Content equality is
// exactly the property the cached translation depends on, so activation can no longer be wrong -- only
// pessimistic (an unrecognised library simply re-translates). This is the identity the sibling same-ISA
// implementation already uses (interp.c x64_pc_file_digest); the ARM-host cache was left on the weaker
// stat identity, which is what made wholesale exclusion the only safe option at the time.
//
// d28f70475 also removed `#define PCACHE_MMAP_HINT 1` here, which compiled the ENTIRE library path out
// of this translation unit -- the hint, the manifest, and the activation gate. That is why the
// `h.n_lib != 0` load rejection it added never actually fires on this build: g_pc_nlib can no longer
// become non-zero, so every file is written with n_lib == 0. The operative defect was never that cache
// files are rejected; it is that library blocks are never recorded, persisted, or restored at all.
#define PCACHE_MMAP_HINT 1

static int g_pc_libcache = -1; // -1 undecided; 0 off (default); 1 on
static int g_pc_lib_unsupported;

static int pcache_libs_enabled(void) {
    if (g_pc_libcache < 0) g_pc_libcache = hl_option_flag_value("HL_PCACHE_LIBS", 0);
    return g_pc_libcache;
}

// SHA-256 over the mapped file's bytes: the manifest's activation authority. Read through host services
// (the same route the main image's identity uses), never through the guest mapping -- the guest could
// have written to a private copy already, and we want the FILE's identity, measured identically on the
// cold run that records it and the warm run that checks it.
static int pcache_file_digest(hl_host_handle handle, const hl_host_file_metadata *metadata,
                              hl_identity_digest *digest) {
    if (metadata == NULL || metadata->type != HL_HOST_FILE_TYPE_REGULAR || metadata->size == 0 ||
        metadata->size > PC_LIB_HASH_MAX || metadata->size > SIZE_MAX || g_host_services == NULL ||
        g_host_services->file == NULL || g_host_services->file->read_at == NULL)
        return 0;
    uint8_t *image = malloc((size_t)metadata->size);
    if (image == NULL) return 0;
    uint64_t done = 0;
    while (done < metadata->size) {
        hl_host_result read = g_host_services->file->read_at(g_host_services->context, handle, done,
                                                             (hl_host_bytes){image + done,
                                                                             (size_t)(metadata->size - done)});
        if (read.status != HL_STATUS_OK || read.value == 0 || read.value > metadata->size - done) {
            free(image);
            return 0;
        }
        done += read.value;
    }
    *digest = hl_identity_image_digest(image, (size_t)metadata->size);
    free(image);
    return !hl_identity_digest_empty(digest);
}

// Bump-allocated deterministic hint for a file-backed non-fixed guest mmap. 2 MB-aligned spans with a
// 2 MB hole between neighbours; deterministic because the SAME binary issues the SAME ordered sequence
// of library maps. Beyond the window (or when the cache/library caching is off): 0 = no hint, kernel
// placement -- which is also the default build's behaviour, byte for byte.
static uint64_t pcache_mmap_hint(uint64_t len) {
    if (!g_pcache || !pcache_libs_enabled()) return 0;
    uint64_t span = ((len + 0x1fffffull) & ~0x1fffffull) + 0x200000ull;
    uint64_t a = __atomic_fetch_add(&g_pc_lib_next, span, __ATOMIC_RELAXED);
    if (a + span > PC_LIB_BASE + PC_LIB_SPAN) return 0;
    return a;
}

// Called after a hinted, file-backed, EXECUTABLE guest mmap succeeded at its hint. Cold epoch: record
// {base, len, stat-id, content digest} in the manifest so this mapping's blocks persist. Warm epoch:
// this is the activation gate -- deferred blocks in [base, base+len) go live only when base, length,
// stat identity AND content digest all match the manifest entry restored for this base.
static void pcache_note_libmap(uint64_t base, uint64_t len, hl_host_handle handle,
                               const hl_host_file_metadata *metadata) {
    if (!g_pcache || !pcache_libs_enabled() || !metadata || !len || base > UINT64_MAX - len) return;
    /* hl_identity_file preserves the v7 five-field dev/ino/size/mtime-sec/mtime-nsec hash. It is a cheap
     * pre-filter only; the content digest below is what authorizes an activation. */
    uint64_t id = hl_identity_file(metadata);
    hl_identity_digest content;
    if (!id || !pcache_file_digest(handle, metadata, &content)) {
        // Unhashable (too large, unreadable, not a regular file) -> this mapping is simply not cacheable.
        // Latch it so the save side does not persist a manifest that silently omits a mapping whose
        // blocks it would otherwise have to claim were revivable.
        g_pc_lib_unsupported = 1;
        if (g_coldprof)
            fprintf(stderr, "[pcache] library not cacheable base=%llx len=%llu\n", (unsigned long long)base,
                    (unsigned long long)len);
        return;
    }
    if (!g_pcache_loaded) { // cold epoch: record for save
        if (g_pc_nlib < PC_LIB_MAX) {
            g_pc_libs[g_pc_nlib].base = base;
            g_pc_libs[g_pc_nlib].len = len;
            g_pc_libs[g_pc_nlib].id = id;
            g_pc_libs[g_pc_nlib].content = content;
            g_pc_nlib++;
        } else
            g_pc_lib_unsupported = 1; // manifest full: the overflow mapping's blocks are not revivable
        return;
    }
    if (!g_pc_ndefer) return; // warm epoch, nothing deferred (or all activated/dropped already)
    for (int i = 0; i < g_pc_nlib; i++) {
        if (g_pc_libs[i].base != base) continue;
        if (g_pc_libs[i].id != id || g_pc_libs[i].len != len ||
            !hl_identity_digest_equal(&g_pc_libs[i].content, &content)) {
            if (g_coldprof)
                fprintf(stderr, "[pcache] library identity drift at base=%llx -> deferred blocks dropped\n",
                        (unsigned long long)base);
            return; // identity drifted: leave deferred (never activates)
        }
        // Activate every deferred block in this range. map_put is a shared-map mutation: take the
        // translation lock when guest threads exist (same discipline as the dispatcher).
        if (g_threaded) pthread_mutex_lock(&g_jit_lock);
        for (uint64_t j = 0; j < g_pc_ndefer; j++) {
            uint64_t gpc = g_pc_defer[j].gpc;
            if (gpc >= base && gpc < base + len && g_pc_defer[j].host_off) {
                if (map_put(gpc, g_pc_defer[j].guest_start, g_pc_defer[j].guest_end,
                            g_cache + g_pc_defer[j].host_off, g_cache + g_pc_defer[j].body_off) == MAP_PUT_OK) {
                    g_pc_defer[j].host_off = 0; // consumed only after publication
                    g_pc_activated++;
                }
            }
        }
        if (g_threaded) pthread_mutex_unlock(&g_jit_lock);
        return;
    }
}

// ---- warm-stat sidecar ----
static void pcache_warm_file(char *out, size_t n) {
    char p[1024];
    if (!pcache_file(p, sizeof p)) {
        if (n != 0) out[0] = 0;
        return;
    }
    int written = snprintf(out, n, "%s.warm", p);
    if (written <= 0 || (size_t)written >= n) out[0] = 0;
}

// Should this load be skipped as dead weight? Only when a PREVIOUS warm run of the SAME file generation
// reported that it re-translated at least half of what the restore brought in.
static int pcache_warm_should_skip(const struct pc_hdr *h) {
    char wp[1200];
    pcache_warm_file(wp, sizeof wp);
    if (!wp[0]) return 0;
    struct pc_warm w;
    void *data = NULL;
    size_t size = 0;
    int ok = hl_persist_load_at(&g_pc_directory, wp, sizeof w, &data, &size) && size == sizeof w;
    if (ok) memcpy(&w, data, sizeof w);
    free(data);
    if (!ok || w.magic != PC_WARM_MAGIC) return 0;
    if (w.arena_used != h->arena_used || w.restored != h->n_mapent) return 0; // different file generation
    if (w.waste > JIT_MAP_N || w.restored > JIT_MAP_N) return 0;              // implausible: ignore
    g_pc_warm_strikes = w.strikes;
    // A single bad warm run used to disable the restore FOREVER: the verdict was latched in the sidecar
    // and every later run honoured it, so one unlucky layout permanently cost every subsequent run its
    // cache. Require repeated agreement instead, and let a good run pay a strike back (pcache_warm_note),
    // so the policy decays rather than latching.
    if (!pcache_converge_enabled()) return w.restored && w.waste * 2 >= w.restored;
    return w.strikes >= PC_WARM_STRIKE_MAX;
}

// Record this warm run's revival stats (called instead of a save when the epoch was loaded). waste =
// restored entries that never became usable: deferred library blocks whose image never mapped with the
// matching identity at the recorded base (layout drift / changed lib). Fresh translations of NEW code do
// NOT count against the restore (a bigger workload under the same key must not poison the policy). A
// wholesale flush mid-run dropped the restored blocks -> the restore was oversized for this guest anyway,
// report it fully dead so later runs skip.
static void pcache_warm_note(void) {
    if (hl_identity_digest_empty(&g_pc_binid) || !g_pc_restored_n || g_pcache_forked) return;
    uint64_t used = g_pc_live_n + g_pc_activated;
    uint64_t waste = (g_pc_flushed || used > g_pc_restored_n) ? g_pc_restored_n : g_pc_restored_n - used;
    uint64_t strikes = g_pc_warm_strikes;
    if (waste * 2 >= g_pc_restored_n) {
        if (strikes < PC_WARM_STRIKE_MAX) strikes++;
    } else if (strikes)
        strikes--; // a productive warm run pays back a strike
    struct pc_warm w = {PC_WARM_MAGIC, g_pc_restored_arena, g_pc_restored_n, waste, strikes};
    char wp[1200];
    pcache_warm_file(wp, sizeof wp);
    if (wp[0]) (void)hl_persist_store_at(&g_pc_directory, wp, &w, sizeof w);
    if (g_coldprof)
        fprintf(stderr, "[pcache] warm-note restored=%llu waste=%llu%s\n", (unsigned long long)g_pc_restored_n,
                (unsigned long long)waste, waste * 2 >= g_pc_restored_n ? " (dead-weight: next run skips)" : "");
}

// Rewrite every recorded host-pointer slot for THIS process. Every baked pointer lives in this PIE
// binary's image, which dyld slides as one unit, so a single delta -- (block_return now) minus
// (block_return at save time) -- relocates them ALL. We reconstruct each slot's saved value (and its
// destination register) from the existing movz/movk encoding, add the slide, and re-emit, so we don't
// need to remember which global each slot held.
static void pcache_relocate(uint64_t saved_block_return) {
    uint64_t slide = (uint64_t)block_return - saved_block_return;
    for (int i = 0; i < g_nreloc; i++) {
        uint32_t *p = (uint32_t *)(g_cache + g_reloc[i].off);
        hl_reloc_slide(p, slide);
    }
}

// Returns 1 on a cache hit (arena + maps restored, translation can be skipped). On ANY mismatch,
// truncation, short read, or allocation failure it returns 0 (graceful MISS -> caller translates fresh).
static int pcache_load(uint64_t entry_jump) {
    if (!g_pcache || hl_identity_digest_empty(&g_pc_binid)) return 0;
    if (g_force_base_failed) return 0; // #210: fixed-base map fell back -> live layout != file's baked base
    // Every persisted block was translated under an armed ledger, so it carries memory guards; a restored
    // arena is only sound in a process whose ledger is armed and latched for good. The launch path does
    // that before it gets here -- refuse rather than restore guarded code into a bus that can still take a
    // 0 -> 1 edge and rotate it away, or a disarmed one whose later arm would have nothing to invalidate.
    if (!jit_guest_bus_active()) return 0;
    char path[1024];
    if (!pcache_file(path, sizeof path)) return 0;
    void *image = NULL;
    size_t image_size = 0;
    if (!hl_persist_load_at(&g_pc_directory, path, CACHE_SZ + UINT64_C(134217728), &image, &image_size)) return 0;
    hl_persist_cursor cursor = {image, image_size, 0};
    struct pc_hdr h;
    if (!hl_persist_take(&cursor, &h, sizeof h)) {
        free(image);
        return 0;
    }
    if (h.magic != PC_MAGIC || !hl_pcache_compatible(h.version, h.translator_abi, PC_VERSION_EFF, PC_TRANSLATOR_ABI) ||
        h.cpu_sz != sizeof(struct cpu) || h.map_n != JIT_MAP_N || h.ibtc_n != IBTC_N || h.img_base != PC_IMG_BASE ||
        h.interp_base != PC_INTERP_BASE || !hl_identity_digest_equal(&h.bin_id, &g_pc_binid) ||
        h.entry_jump != entry_jump || h.arena_used > CACHE_SZ || h.n_mapent > JIT_MAP_N || h.n_pend > (1u << 16) ||
        h.n_reloc > PC_RELOC_CAP || h.n_lib > PC_LIB_MAX ||
        (h.n_lib != 0 && !pcache_libs_enabled())) { // a manifest is only consumable by a run that validates it
        free(image);
        return 0;
    }
    // a previous warm run of this same generation proved the restore is dead weight -> skip it
    // (header-only read: no arena I/O, no map pollution, no resave churn). The file stays for the day
    // the layout becomes deterministic again (engine update re-keys everything anyway).
    if (pcache_warm_should_skip(&h)) {
        free(image);
        g_pcache_skip = 1;
        if (g_coldprof) fprintf(stderr, "[pcache] SKIP (previous warm run re-translated >=1/2 of restore)\n");
        return 0;
    }
    // pull the variable-size sections
    struct pc_mapent *me = h.n_mapent ? malloc(h.n_mapent * sizeof *me) : NULL;
    struct pc_pend *pe = h.n_pend ? malloc(h.n_pend * sizeof *pe) : NULL;
    uint8_t *abuf = h.arena_used ? malloc(h.arena_used) : NULL;
    int ok = (h.n_mapent == 0 || me) && (h.n_pend == 0 || pe) && (h.arena_used == 0 || abuf);
    if (ok && h.n_reloc) ok = hl_persist_take(&cursor, g_reloc, (size_t)h.n_reloc * sizeof g_reloc[0]);
    if (ok && h.n_mapent) ok = hl_persist_take(&cursor, me, (size_t)h.n_mapent * sizeof *me);
    if (ok && h.n_pend) ok = hl_persist_take(&cursor, pe, (size_t)h.n_pend * sizeof *pe);
    if (ok && h.n_lib) ok = hl_persist_take(&cursor, g_pc_libs, (size_t)h.n_lib * sizeof g_pc_libs[0]);
    // Arena bytes: read into a heap buffer -- checksummed below BEFORE anything is trusted, and only then
    // memcpy'd into the W^X arena under write mode. (read()'s kernel copyout cannot target a MAP_JIT page
    // gated by the thread's W^X state; a userspace memcpy can, once the write window is open.)
    if (ok) ok = hl_persist_take(&cursor, abuf, (size_t)h.arena_used) && cursor.offset == cursor.size;
    free(image);
    // v6: whole-payload checksum BEFORE trusting any record (bit rot / short file / foreign writer) --
    // the same validation-before-trust discipline as the aarch64 pcache.
    if (ok) {
        hl_digest digest;
        hl_digest_init(&digest, HL_DIGEST_SEED);
        hl_digest_update(&digest, g_reloc, h.n_reloc * sizeof g_reloc[0]);
        hl_digest_update(&digest, me, h.n_mapent * sizeof *me);
        hl_digest_update(&digest, pe, h.n_pend * sizeof *pe);
        hl_digest_update(&digest, g_pc_libs, h.n_lib * sizeof g_pc_libs[0]);
        hl_digest_update(&digest, abuf, h.arena_used);
        ok = hl_digest_value(&digest) == h.csum;
    }
    // Bounds-validate every record whose offset a later pass writes or branches through.
    for (uint64_t i = 0; ok && i < h.n_reloc; i++)
        ok = hl_window_contains(h.arena_used, g_reloc[i].off, 16, 1);
    for (uint64_t i = 0; ok && i < h.n_mapent; i++)
        ok = hl_window_contains(h.arena_used, me[i].host_off, 1, 1) &&
             hl_window_contains(h.arena_used, me[i].body_off, 1, 1);
    for (uint64_t i = 0; ok && i < h.n_pend; i++)
        ok = hl_window_contains(h.arena_used, pe[i].slot_off, 4, 1);
    if (!ok) {
        free(me);
        free(pe);
        free(abuf);
        g_pc_nlib = 0;
        return 0;
    }
    if (!jit_wprot(0)) {
        free(abuf);
        g_pc_nlib = 0;
        return 0;
    }
    memcpy(g_cache, abuf, h.arena_used);
    if (!jit_wprot(1)) {
        free(abuf);
        g_pc_nlib = 0;
        return 0;
    }
    free(abuf);
    // rebuild the engine state from the offset-relative records. fixed-image blocks (main+interp,
    // identity-validated by the cache key itself) go live NOW; manifest (library) blocks are DEFERRED
    // until the guest maps the same file identity at the same base (pcache_note_libmap); anything else
    // is unrevivable and dropped (belt-and-braces: the save side never persists such entries).
    if (!hl_reloc_import(&g_reloc_table, g_reloc, (size_t)h.n_reloc)) {
        free(me);
        free(pe);
        return 0;
    }
    g_pc_nlib = (int)h.n_lib;
    g_pc_defer = NULL;
    g_pc_ndefer = 0;
    uint64_t nlive = 0, ndefer = 0;
    for (uint64_t i = 0; i < h.n_mapent; i++) {
        if (pc_gpc_fixed(me[i].gpc)) {
            if (map_put(me[i].gpc, me[i].guest_start, me[i].guest_end,
                        g_cache + me[i].host_off, g_cache + me[i].body_off) != MAP_PUT_OK) {
                free(me);
                free(pe);
                return 0;
            }
            nlive++;
        } else if (pc_gpc_in_lib(me[i].gpc)) {
            ndefer++;
        }
    }
    if (ndefer) {
        g_pc_defer = malloc(ndefer * sizeof *g_pc_defer);
        if (g_pc_defer) {
            for (uint64_t i = 0; i < h.n_mapent; i++)
                if (!pc_gpc_fixed(me[i].gpc) && pc_gpc_in_lib(me[i].gpc)) g_pc_defer[g_pc_ndefer++] = me[i];
        }
    }
    pend_reset();
    for (uint64_t i = 0; i < h.n_pend; i++)
        add_pend2((uint32_t *)(g_cache + pe[i].slot_off), pe[i].target, (int)pe[i].is_bl);
    g_cp = g_cache + h.arena_used;
    free(me);
    free(pe);
    // re-slide every baked PIE host pointer for THIS process + publish the restored code to the i-cache
    if (!jit_wprot(0)) return 0;
    pcache_relocate(h.block_return_at);
    if (!jit_wprot(1) || !jit_publish_code(g_cache, h.arena_used)) return 0;
    memset(g_ibtc, 0, sizeof g_ibtc); // runtime cache: repopulates lazily
    g_pcache_loaded = 1;
    g_pc_restored_n = nlive + g_pc_ndefer; // what the warm-stat measures waste against
    g_pc_restored_arena = h.arena_used;
    g_pc_generation = h.generation;
    g_pc_live_n = nlive;
    g_pc_activated = 0;
    g_pc_flushed = 0;
    if (g_coldprof)
        fprintf(stderr, "[pcache] restore live=%llu deferred-lib=%llu dropped=%llu\n", (unsigned long long)nlive,
                (unsigned long long)g_pc_ndefer, (unsigned long long)(h.n_mapent - nlive - g_pc_ndefer));
    return 1;
}

// Persist the current arena + maps (atomic temp+rename). Called at guest exit AND at execve,
// right before the exec flushes the arena -- each image epoch persists under its OWN key exactly once.
static void pcache_save(void) {
    if (!g_pcache || hl_identity_digest_empty(&g_pc_binid) || g_cp == g_cache) return;
    if (g_force_base_failed) return;     // #210: mixed-base arena (a fixed-VA image map fell back) -> not revivable
    if (g_pcache_poison) return;         // arena has un-recorded baked host pointers -> not safely relocatable
    if (!jit_guest_bus_active()) return; // unguarded blocks must never reach a file that outlives this process
    // NEVER save from a fork child. jit_after_fork rebuilt a FRESH EMPTY arena in the child, but
    // the g_reloc table (and binid/entry identity) survived the fork -- a child save would persist the
    // PARENT's reloc offsets against the child's re-translated arena, and the next load's relocation pass
    // would stomp fixed-slot rewrites over live code at those stale offsets (intermittent SIGSEGV/hang,
    // the aarch64 concurrent-hit crash). The child's arena is only the post-fork slice anyway.
    // (An in-process execve fully re-keys + resets this state -- pcache_exec_reload -- so a forked child
    // that exec'd a new image saves that image normally: the go-build storm case.)
    if (g_pcache_forked) return;
    // NEVER re-save after a load. A warm run keeps translating -- notably tier-2 hot-block recompiles,
    // which re-emit into the arena WITHOUT a map entry (g_tier2_build) -- so g_cp (arena_used) grows every
    // run. Re-persisting that snowballs the on-disk arena across sequential `--rm` runs of the same image
    // (~5 MB/run here) until it overflows CACHE_SZ; the next load's `arena_used > CACHE_SZ` check then makes
    // it graceful-miss, but before that the in-memory arena has already run past its end -> silent guest
    // SIGSEGV (docker rc 255, empty output, no daemon-log error). The cold (miss) arena already covers the
    // startup/common path; any block missing from it is simply re-translated in-memory on each warm run
    // (correct, just not cached). So we persist exactly once, on the cold miss, and never grow the file.
    // instead of a no-op, a loaded epoch records its revival stats for the restore-or-skip policy.
    if (g_pcache_loaded) {
        pcache_warm_note();
        // Convergence: allow a BOUNDED re-save so the file learns the steady-state working set instead of
        // being frozen at what the very first (least representative) run happened to translate. Both
        // bounds below are what keep the documented snowball from returning; failing either leaves the
        // published file exactly as it is, which is the old behaviour.
        if (!pcache_converge_enabled()) return;
        uint64_t live = 0;
        for (uint32_t i = 0; i < map_capacity(); i++)
            if (map_live(i) && (pc_gpc_fixed(g_map[i].gpc) || pc_gpc_in_lib(g_map[i].gpc))) live++;
        if (live <= g_pc_restored_n) return;                    // learned nothing new: do not churn the file
        if (g_pc_generation >= PC_RESAVE_GEN_MAX) return;       // bound the number of re-saves
        if ((uint64_t)(g_cp - g_cache) > PC_RESAVE_ARENA_MAX) { // bound the arena the file can carry
            if (g_coldprof)
                fprintf(stderr, "[pcache] converge: arena %llu B over the re-save ceiling; keeping generation %llu\n",
                        (unsigned long long)(g_cp - g_cache), (unsigned long long)g_pc_generation);
            return;
        }
        if (g_coldprof)
            fprintf(stderr, "[pcache] converge: re-saving generation %llu (live %llu > restored %llu)\n",
                    (unsigned long long)(g_pc_generation + 1), (unsigned long long)live,
                    (unsigned long long)g_pc_restored_n);
        // fall through to the publication path below
    }
    if (g_pcache_skip) return; // we intentionally skipped the restore; re-saving would churn the file
    // A library mapping we could not content-key (too large to hash, unreadable, manifest full) means the
    // manifest does not describe every executable file mapping this arena translated. Persisting it would
    // claim revivability for blocks whose bytes nothing authenticates, so refuse the whole publication.
    if (g_pc_lib_unsupported) {
        if (g_coldprof) fprintf(stderr, "[pcache] save refused: an executable file mapping is not content-keyable\n");
        return;
    }
    uint64_t _t0 = g_coldprof ? coldprof_now_ns(effective_host_services()) : 0;
    // count occupied map slots that are REVIVABLE (fixed images + manifest libs). Anything else is keyed
    // by a kernel-chosen address that the next run won't reproduce -- persisting it would be dead weight
    // at best, and a stale-translation hazard if the next run reuses the address range for other code.
    uint64_t nmap = 0;
    for (uint32_t i = 0; i < map_capacity(); i++)
        if (map_live(i) && (pc_gpc_fixed(g_map[i].gpc) || pc_gpc_in_lib(g_map[i].gpc))) nmap++;
    char path[1024];
    if (!pcache_file(path, sizeof path)) return;
    struct pc_hdr h;
    memset(&h, 0, sizeof h);
    h.magic = PC_MAGIC;
    h.version = PC_VERSION_EFF;
    h.translator_abi = PC_TRANSLATOR_ABI;
    h.cpu_sz = sizeof(struct cpu);
    h.map_n = JIT_MAP_N;
    h.ibtc_n = IBTC_N;
    h.img_base = PC_IMG_BASE;
    h.interp_base = PC_INTERP_BASE;
    h.bin_id = g_pc_binid;
    h.entry_jump = g_pc_entry;
    h.arena_used = (uint64_t)(g_cp - g_cache);
    h.n_mapent = nmap;
    h.n_pend = (uint64_t)g_npend;
    h.n_reloc = (uint64_t)g_nreloc;
    h.n_lib = (uint64_t)g_pc_nlib;
    h.generation = g_pcache_loaded ? g_pc_generation + 1 : 0;
    h.block_return_at = (uint64_t)block_return;
    h.ibtc_at = (uint64_t)g_ibtc;
    // Build the whole image in one heap buffer and write it with a single syscall (per-record write()s
    // were ~1300 syscalls and dominated the one-time save cost).
    size_t total = sizeof h + (size_t)g_nreloc * sizeof g_reloc[0] + (size_t)nmap * sizeof(struct pc_mapent) +
                   (size_t)g_npend * sizeof(struct pc_pend) + (size_t)g_pc_nlib * sizeof(struct pc_lib) + h.arena_used;
    uint8_t *buf = malloc(total), *w = buf;
    int ok = buf != NULL;
    if (ok) {
        w += sizeof h; // header written last: its csum covers everything after it
        memcpy(w, g_reloc, (size_t)g_nreloc * sizeof g_reloc[0]);
        w += (size_t)g_nreloc * sizeof g_reloc[0];
        for (uint32_t i = 0; i < map_capacity(); i++) {
            if (!map_live(i) || !(pc_gpc_fixed(g_map[i].gpc) || pc_gpc_in_lib(g_map[i].gpc))) continue;
            // guest_start/guest_end are vestigial in the on-disk record (restore discards them; the SMC page
            // set is serialized separately). The live map entry no longer stores them, so emit 0 placeholders
            // and keep the pc_mapent layout + PC_VERSION unchanged.
            struct pc_mapent e = {g_map[i].gpc, 0, 0, (uint64_t)((uint8_t *)g_map[i].host - g_cache),
                                  (uint64_t)((uint8_t *)g_map[i].body - g_cache)};
            memcpy(w, &e, sizeof e);
            w += sizeof e;
        }
        for (int i = 0; i < g_npend; i++) {
            struct pc_pend e = {(uint64_t)((uint8_t *)g_pend[i].slot - g_cache), g_pend[i].target,
                                (uint32_t)g_pend[i].is_bl};
            memcpy(w, &e, sizeof e);
            w += sizeof e;
        }
        memcpy(w, g_pc_libs, (size_t)g_pc_nlib * sizeof(struct pc_lib));
        w += (size_t)g_pc_nlib * sizeof(struct pc_lib);
        memcpy(w, g_cache, h.arena_used); // read from W^X arena is always permitted
        h.csum = hl_digest_bytes(HL_DIGEST_SEED, buf + sizeof h, total - sizeof h);
        memcpy(buf, &h, sizeof h);
        ok = hl_persist_store_at(&g_pc_directory, path, buf, total);
    }
    free(buf);
    if (ok) {
        char wp[1200];
        pcache_warm_file(wp, sizeof wp);
        if (wp[0]) (void)hl_persist_remove_at(&g_pc_directory, wp); // old stat no longer describes this generation
    }
    if (g_coldprof)
        fprintf(stderr, "[pcache] save %s (%llu B arena, %llu blocks, %d libs) in %.3f ms\n", ok ? "ok" : "FAILED",
                (unsigned long long)h.arena_used, (unsigned long long)nmap, g_pc_nlib,
                (coldprof_now_ns(effective_host_services()) - _t0) / 1e6);
}

// hygiene hooks (shared proc.c / engine/dispatch.c call these on both engines):
//  - fork child: its arena is now a fork-private slice (kept warm by the preserved-arena fork, or
//    fresh from the threaded rebuild) under the PARENT's identity -> drop the inherited reloc records and
//    bar this process from saving (see the g_pcache_forked comment in pcache_save).
//  - wholesale cache-full flush: the arena content the records described is gone -> reset so records stay
//    in lockstep with what is re-emitted (every baked pointer recorded, by construction).
static void pcache_after_fork(void) {
    hl_reloc_reset(&g_reloc_table);
    g_pcache_forked = 1;
}

#define PCACHE_FORK_HOOK pcache_after_fork()

static void pcache_after_wholesale_flush(void) {
    if (g_coldprof)
        fprintf(stderr, "[pcache] wholesale arena flush: any restored block is gone\n");
    hl_reloc_reset(&g_reloc_table);
    g_pc_flushed = 1; // any restored blocks are gone; the warm-stat must report the restore dead
    g_pc_ndefer = 0;  // deferred entries pointed into the dropped arena content
}

#define PCACHE_FLUSH_HOOK pcache_after_wholesale_flush()

// ---- guest execve (proc.c case 221) hooks ----
// An in-process exec re-loads a NEW image after flushing the arena; the cache identity re-keys with it.
// proc.c calls PCACHE_SAVE_HOOK (above) BEFORE the flush -- persisting the outgoing image under the
// OUTGOING key -- then these force the new image onto the fixed bases and re-key + reload. This is what
// makes a wrong-key save impossible: g_pc_binid is only ever assigned in lockstep with an arena reset.
static void pcache_exec_force_main(int identity_authorized) {
    (void)identity_authorized;
    if (g_pcache) {
        g_force_base = PC_IMG_BASE;
        g_pc_img_lo = g_pc_img_hi = g_pc_interp_lo = g_pc_interp_hi = 0; // re-recorded by load_elf
    }
}

static void pcache_exec_force_interp(void) {
    if (g_pcache) g_force_base = PC_INTERP_BASE;
}

static hl_identity_digest pcache_exec_authorized_id(hl_identity_digest program, hl_identity_digest interpreter,
                                                     int interpreter_present, int identity_authorized,
                                                     const char *argv0) {
    return identity_authorized
               ? pcache_make_id(program, interpreter_present ? interpreter : (hl_identity_digest){0}, argv0)
               : (hl_identity_digest){0};
}

static void pcache_exec_reload(hl_identity_digest program, hl_identity_digest interpreter, int interpreter_present,
                               int identity_authorized, const char *argv0, uint64_t jump) {
    if (!g_pcache) return;
    // execve is a full identity + arena reset (thread_exit_others ran; the old image was unmapped and the
    // arena/map/ibtc flushed by case 221), so the recording state resets with it and saving becomes safe
    // again -- including for a fork child (the fork+execve toolchain storm is exactly the case we cache).
    hl_reloc_reset(&g_reloc_table);
    g_pcache_loaded = 0;
    g_pcache_forked = 0;
    g_pcache_skip = 0;
    g_pc_flushed = 0;
    g_pc_restored_n = g_pc_restored_arena = 0;
    g_pc_live_n = g_pc_activated = 0;
    free(g_pc_defer);
    g_pc_defer = NULL;
    g_pc_ndefer = 0;
    g_pc_nlib = 0;
    g_pc_lib_unsupported = 0;
    g_pc_generation = 0;
    g_pc_warm_strikes = 0;
    __atomic_store_n(&g_pc_lib_next, PC_LIB_BASE, __ATOMIC_RELAXED); // fresh image, fresh hint sequence
    g_pc_binid = pcache_exec_authorized_id(program, interpreter, interpreter_present, identity_authorized, argv0);
    g_pc_entry = jump;
    int hit = pcache_load(jump);
    if (g_coldprof) fprintf(stderr, "[pcache] exec %s reloc=%d\n", hit ? "HIT" : "MISS", g_nreloc);
}

#define PCACHE_EXEC_HOOKS 1

#define PCACHE_SAVE_HOOK pcache_save()
