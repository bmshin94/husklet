static void gbus_lock(void) {
    while (atomic_flag_test_and_set_explicit(&g_bus_lock, memory_order_acquire))
        sched_yield();
}

static void gbus_unlock(void) {
    atomic_flag_clear_explicit(&g_bus_lock, memory_order_release);
}

static void gbus_filter_rebuild_locked(void) {
    uint64_t lo = UINT64_MAX, hi = 0;
    if (g_bus_fail_closed || g_bus_prepares != 0) {
        lo = 0;
        hi = UINT64_MAX;
    } else {
        for (int index = 0; index < g_ngbus; ++index) {
            if (g_gbus[index].lo < lo) lo = g_gbus[index].lo;
            if (g_gbus[index].hi > hi) hi = g_gbus[index].hi;
        }
    }
    atomic_store_explicit(&g_bus_filter_lo, lo, memory_order_relaxed);
    atomic_store_explicit(&g_bus_filter_hi, hi, memory_order_release);
}

static unsigned gbus_page_hash(uint64_t page) {
    return (unsigned)page & (BUS_FILTER_BITS - 1u);
}

static void gbus_page_mark_locked(uint64_t lo, uint64_t hi) {
    if (hi <= lo) return;
    uint64_t first = lo >> 12;
    uint64_t last = (hi - 1) >> 12;
    /* Mark the preceding page too: a single instruction may begin there and
       cross into the first BUS page.  Guards then need only hash their start. */
    if (first != 0) first--;
    if (last - first >= BUS_FILTER_BITS) {
        for (unsigned i = 0; i < BUS_FILTER_WORDS; ++i)
            atomic_store_explicit(&g_bus_page_filter[i], UINT64_MAX, memory_order_release);
        return;
    }
    for (uint64_t page = first;; ++page) {
        unsigned bit = gbus_page_hash(page);
        atomic_fetch_or_explicit(&g_bus_page_filter[bit >> 6], UINT64_C(1) << (bit & 63u), memory_order_release);
        if (page == last) break;
    }
}

static void gbus_page_reset_locked(void) {
    for (unsigned i = 0; i < BUS_FILTER_WORDS; ++i)
        atomic_store_explicit(&g_bus_page_filter[i], 0, memory_order_release);
}

static void gbus_page_rebuild_locked(void) {
    gbus_page_reset_locked();
    if (g_bus_fail_closed) {
        for (unsigned i = 0; i < BUS_FILTER_WORDS; ++i)
            atomic_store_explicit(&g_bus_page_filter[i], UINT64_MAX, memory_order_release);
        return;
    }
    for (int index = 0; index < g_ngbus; ++index)
        gbus_page_mark_locked(g_gbus[index].lo, g_gbus[index].hi);
}

static void gbus_atfork_prepare(void) {
    pthread_mutex_lock(&g_bus_transition);
    gbus_lock();
}

static void gbus_atfork_parent(void) {
    gbus_unlock();
    pthread_mutex_unlock(&g_bus_transition);
}

static void gbus_atfork_child(void) {
    gbus_unlock();
    pthread_mutex_unlock(&g_bus_transition);
}

static void gbus_atfork_install(void) {
    (void)pthread_atfork(gbus_atfork_prepare, gbus_atfork_parent, gbus_atfork_child);
}

static void gbus_notify(uint64_t generation, int active) {
    gbus_lock();
    hl_linux_bus_change_fn callback = g_bus_callback;
    void *opaque = g_bus_callback_opaque;
    gbus_unlock();
    if (callback != NULL) callback(opaque, generation, active);
}

static void gbus_prepare(void) {
    (void)pthread_once(&g_bus_atfork_once, gbus_atfork_install);
    pthread_mutex_lock(&g_bus_transition);
    gbus_lock();
    int was_active = g_ngbus != 0 || g_bus_fail_closed || g_bus_prepares != 0;
    uint64_t generation = !was_active ? atomic_fetch_add_explicit(&g_bus_generation, 1, memory_order_release) + 1
                                      : atomic_load_explicit(&g_bus_generation, memory_order_relaxed);
    gbus_unlock();
    /* On first activation guarded code does not exist yet.  Complete the
       synchronous STW while the old empty ledger remains queryable; forcing
       queries to wait on a prepare here deadlocks a peer inside its guard
       before that peer can acknowledge the STW.  The caller has not changed
       the host mapping yet, so the old empty answer remains correct. */
    if (!was_active) gbus_notify(generation, 1);
    if (g_bus_transition_begin != NULL) g_bus_transition_begin(g_bus_transition_opaque);
    gbus_lock();
    /* From this point through host mapping publication and ledger commit,
       already-guarded code must use the precise transition path. */
    atomic_store_explicit(&g_bus_filter_force, 3, memory_order_release);
    if (g_bus_prepares != UINT32_MAX)
        g_bus_prepares++;
    else
        g_bus_fail_closed = 1;
    gbus_unlock();
    /* Keep the transition lock through host publication and commit/release. This serializes
       concurrent mapping transactions and prevents fork from inheriting an orphan prepare token. */
}

static void gbus_prepare_release(void) {
    gbus_lock();
    if (g_bus_prepares != 0) g_bus_prepares--;
    /* force remains set until publication below, so no translated guard can
       observe the temporary zeroes.  Rebuilding on every completed mapping
       transaction prevents a long-lived range plus distinct-page churn from
       monotonically saturating the fast rejection filter. */
    gbus_page_rebuild_locked();
    gbus_filter_rebuild_locked();
    int active = g_ngbus != 0 || g_bus_fail_closed || g_bus_prepares != 0;
    uint64_t generation = !active ? atomic_fetch_add_explicit(&g_bus_generation, 1, memory_order_release) + 1
                                  : atomic_load_explicit(&g_bus_generation, memory_order_relaxed);
    gbus_unlock();
    atomic_store_explicit(&g_bus_filter_force, active ? 1 : 0, memory_order_release);
    if (!active) gbus_notify(generation, 0);
    if (g_bus_transition_end != NULL) g_bus_transition_end(g_bus_transition_opaque);
    pthread_mutex_unlock(&g_bus_transition);
}

/* A host MAP_FIXED replacement must not run concurrently with a translated
   peer accessing the replaced range.  This is only a mapping transaction: it
   deliberately does not activate BUS instrumentation or change the ledger. */
static void gbus_mapping_transition_lock(void) {
    (void)pthread_once(&g_bus_atfork_once, gbus_atfork_install);
    pthread_mutex_lock(&g_bus_transition);
}

static void gbus_mapping_stw_begin(void) {
    if (g_bus_transition_begin != NULL) g_bus_transition_begin(g_bus_transition_opaque);
}

static void gbus_mapping_stw_end(void) {
    if (g_bus_transition_end != NULL) g_bus_transition_end(g_bus_transition_opaque);
}

static void gbus_mapping_transition_unlock(void) {
    pthread_mutex_unlock(&g_bus_transition);
}

static void gbus_mapping_prepare(void) {
    gbus_mapping_transition_lock();
    gbus_mapping_stw_begin();
}

static void gbus_mapping_prepare_release(void) {
    gbus_mapping_stw_end();
    gbus_mapping_transition_unlock();
}

int hl_linux_bus_transition_begin(hl_linux_bus_transition *transition) {
    if (transition == NULL || transition->held != 0) return -1;
    gbus_prepare();
    transition->generation = atomic_load_explicit(&g_bus_generation, memory_order_acquire);
    transition->held = 1;
    return 0;
}

int hl_linux_bus_transition_add(hl_linux_bus_transition *transition, uint64_t lo, uint64_t hi) {
    if (transition == NULL || transition->held == 0) return -1;
    return gbus_add(lo, hi);
}

void hl_linux_bus_transition_clear(hl_linux_bus_transition *transition, uint64_t lo, uint64_t hi) {
    if (transition != NULL && transition->held != 0) gbus_clear(lo, hi);
}

void hl_linux_bus_transition_end(hl_linux_bus_transition *transition) {
    if (transition == NULL || transition->held == 0) return;
    transition->held = 0;
    gbus_prepare_release();
    transition->generation = atomic_load_explicit(&g_bus_generation, memory_order_acquire);
}

void hl_linux_bus_set_change_callback(hl_linux_bus_change_fn callback, void *opaque) {
    gbus_lock();
    g_bus_callback_opaque = opaque;
    g_bus_callback = callback;
    uint64_t generation = atomic_load_explicit(&g_bus_generation, memory_order_acquire);
    int active = g_ngbus != 0 || g_bus_fail_closed || g_bus_prepares != 0;
    gbus_unlock();
    if (callback != NULL) callback(opaque, generation, active);
}

void hl_linux_bus_set_transition_callbacks(hl_linux_bus_transition_fn begin, hl_linux_bus_transition_fn end,
                                           void *opaque) {
    pthread_mutex_lock(&g_bus_transition);
    g_bus_transition_begin = begin;
    g_bus_transition_end = end;
    g_bus_transition_opaque = opaque;
    pthread_mutex_unlock(&g_bus_transition);
}

static int gbus_add(uint64_t lo, uint64_t hi) {
    if (hi <= lo) return 0;
    (void)pthread_once(&g_bus_atfork_once, gbus_atfork_install);
    gbus_lock();
    (void)gbus_clear_locked(lo, hi);
    (void)gbus_parked_clear_locked(lo, hi); // a fresh arm supersedes any parked coverage here
    int ok = g_ngbus < GNA_MAX;
    if (ok)
        g_gbus[g_ngbus++] = (struct guest_bus_range){lo, hi};
    else
        g_bus_fail_closed = 1;
    gbus_page_mark_locked(lo, hi);
    gbus_filter_rebuild_locked();
    uint64_t generation = atomic_fetch_add_explicit(&g_bus_generation, 1, memory_order_release) + 1;
    int active = g_ngbus != 0 || g_bus_fail_closed || g_bus_prepares != 0;
    atomic_store_explicit(&g_bus_filter_force, g_bus_prepares != 0 ? 3 : (active ? 1 : 0), memory_order_release);
    gbus_unlock();
    gbus_notify(generation, active);
    return ok ? 0 : -1;
}

static void gbus_clear(uint64_t lo, uint64_t hi) {
    if (hi <= lo) return;
    gbus_lock();
    int changed = gbus_clear_locked(lo, hi);
    /* The range is genuinely gone (unmapped, replaced, or grown back into the
       file), so parked coverage must go with it: a later mapping reusing this
       address must never resurrect the old past-EOF verdict. */
    (void)gbus_parked_clear_locked(lo, hi);
    if (changed && g_ngbus == 0 && !g_bus_fail_closed) gbus_page_reset_locked();
    if (changed) gbus_filter_rebuild_locked();
    uint64_t generation = changed ? atomic_fetch_add_explicit(&g_bus_generation, 1, memory_order_release) + 1
                                  : atomic_load_explicit(&g_bus_generation, memory_order_relaxed);
    int active = g_ngbus != 0 || g_bus_fail_closed || g_bus_prepares != 0;
    if (changed)
        atomic_store_explicit(&g_bus_filter_force, g_bus_prepares != 0 ? 3 : (active ? 1 : 0), memory_order_release);
    gbus_unlock();
    if (changed) gbus_notify(generation, active);
}

/* mprotect(PROT_NONE): the guest cannot reach these bytes at all, and Linux
   classifies a touch as a permission fault long before it consults the page
   cache, so no SIGBUS can be raised here.  Move the ledger's coverage of
   [lo,hi) aside instead of arming the translated guard for it.  Purely a
   relaxation of the live set, so it needs no prepare/STW -- exactly like
   gbus_clear. */
static void gbus_park(uint64_t lo, uint64_t hi) {
    if (hi <= lo) return;
    gbus_lock();
    int changed = 0;
    for (int index = 0; index < g_ngbus; ++index) {
        uint64_t base = g_gbus[index].lo, end = g_gbus[index].hi;
        if (lo >= end || hi <= base) continue;
        gbus_parked_append_locked(base > lo ? base : lo, end < hi ? end : hi);
        changed = 1;
    }
    if (changed) {
        (void)gbus_clear_locked(lo, hi);
        if (g_ngbus == 0 && !g_bus_fail_closed) gbus_page_reset_locked();
        gbus_filter_rebuild_locked();
    }
    uint64_t generation = changed ? atomic_fetch_add_explicit(&g_bus_generation, 1, memory_order_release) + 1
                                  : atomic_load_explicit(&g_bus_generation, memory_order_relaxed);
    int active = g_ngbus != 0 || g_bus_fail_closed || g_bus_prepares != 0;
    if (changed)
        atomic_store_explicit(&g_bus_filter_force, g_bus_prepares != 0 ? 3 : (active ? 1 : 0), memory_order_release);
    gbus_unlock();
    if (changed) gbus_notify(generation, active);
}

static int gbus_parked_overlap(uint64_t lo, uint64_t hi) {
    if (hi <= lo) return 0;
    gbus_lock();
    int found = 0;
    for (int index = 0; index < g_ngbus_parked; ++index)
        if (lo < g_gbus_parked[index].hi && hi > g_gbus_parked[index].lo) {
            found = 1;
            break;
        }
    gbus_unlock();
    return found;
}

/* mprotect back to an accessible protection restores the SIGBUS contract for
   the still-past-EOF bytes: move the parked coverage of [lo,hi) back into the
   live ledger.  This ARMS the guard, so the caller wraps it in the same
   prepare/STW transaction a mapping that arms the ledger uses. */
static void gbus_unpark(uint64_t lo, uint64_t hi) {
    if (hi <= lo) return;
    gbus_lock();
    int changed = 0;
    for (int index = 0; index < g_ngbus_parked;) {
        uint64_t base = g_gbus_parked[index].lo, end = g_gbus_parked[index].hi;
        if (lo >= end || hi <= base) {
            index++;
            continue;
        }
        uint64_t first = base > lo ? base : lo, last = end < hi ? end : hi;
        /* Removing the intersection can split entry `index` and move entries
           behind it, so rescan from the start; each pass strictly shrinks the
           parked coverage of [lo,hi), so this terminates. */
        (void)gbus_parked_clear_locked(first, last);
        (void)gbus_clear_locked(first, last);
        if (g_ngbus < GNA_MAX)
            g_gbus[g_ngbus++] = (struct guest_bus_range){first, last};
        else
            g_bus_fail_closed = 1;
        gbus_page_mark_locked(first, last);
        changed = 1;
        index = 0;
    }
    if (changed) gbus_filter_rebuild_locked();
    uint64_t generation = changed ? atomic_fetch_add_explicit(&g_bus_generation, 1, memory_order_release) + 1
                                  : atomic_load_explicit(&g_bus_generation, memory_order_relaxed);
    int active = g_ngbus != 0 || g_bus_fail_closed || g_bus_prepares != 0;
    if (changed)
        atomic_store_explicit(&g_bus_filter_force, g_bus_prepares != 0 ? 3 : (active ? 1 : 0), memory_order_release);
    gbus_unlock();
    if (changed) gbus_notify(generation, active);
}

uint64_t hl_linux_bus_fault(uint64_t address, uint64_t length) {
    if (length == 0) return 0;
    if (address > UINT64_MAX - length) return address != 0 ? address : 1;
    uint64_t end = address + length;
    if (atomic_load_explicit(&g_bus_filter_force, memory_order_acquire) != 3) {
        uint64_t lo = atomic_load_explicit(&g_bus_filter_lo, memory_order_relaxed);
        uint64_t hi = atomic_load_explicit(&g_bus_filter_hi, memory_order_acquire);
        if (address >= hi || end <= lo) return 0;
    }
retry:
    gbus_lock();
    /* A prepare spans activation, host mapping publication, and precise-ledger
       commit.  Wait out that short transaction rather than treating every
       address as BUS: unrelated translated threads must not receive a
       synchronous SIGBUS merely because a mapper is between publication and
       ledger insertion. */
    if (g_bus_prepares != 0) {
        gbus_unlock();
        sched_yield();
        goto retry;
    }
    if (g_bus_fail_closed) {
        gbus_unlock();
        return address != 0 ? address : 1;
    }
    for (int index = 0; index < g_ngbus; ++index)
        if (address < g_gbus[index].hi && end > g_gbus[index].lo) {
            uint64_t fault = address > g_gbus[index].lo ? address : g_gbus[index].lo;
            gbus_unlock();
            return fault != 0 ? fault : 1;
        }
    gbus_unlock();
    return 0;
}

int hl_linux_bus_hit(uint64_t address, uint64_t length) {
    return hl_linux_bus_fault(address, length) != 0;
}

uint64_t hl_linux_bus_generation(void) {
    return atomic_load_explicit(&g_bus_generation, memory_order_acquire);
}

int hl_linux_bus_active(void) {
    gbus_lock();
    int active = g_ngbus != 0 || g_bus_fail_closed || g_bus_prepares != 0;
    gbus_unlock();
    return active;
}

/* HL_X86_BUS_RANGE_COALESCE -- merge abutting intervals on insert.
   ---------------------------------------------------------------------------
   Every one of these ledgers is a set of [lo,hi) intervals carrying NO other
   state: no provenance, no owner, no refcount, no distinct removal lifetime.
   The entry struct is {uint64_t lo, hi} and nothing else, and every reader
   (gna_hit / gna_all / gna_prefix / gro_hit / gro_prefix / gnx_hit) asks a
   question about the UNION of the set.  The one reader that touches the
   arrays directly, maps_prot_at in process_maps.c, also derives its answer
   from the union -- and its `edge` (how far the verdict holds) is currently
   TRUNCATED at every abutting boundary, so it splits /proc/self/maps into two
   consecutive rows with identical perms where Linux, which merges VMAs of
   equal attributes, shows one.  Merging abutting intervals is therefore a
   union-preserving normalisation that loses no information and makes that one
   row rendering more faithful, not less.

   The add paths already clear the overlap before appending, so the live set is
   DISJOINT but never COALESCED.  Measured on a cold cc1 -O2 run, that leaves
   g_gna at 487 live intervals that describe only 115 distinct spans and g_gnx
   at 440 describing 129 -- and drives both to the 512 capacity, where the add
   silently DROPS the interval (43 times for g_gna, 7,326 for g_gnx on that
   run) and the middle-split silently drops its tail (271 times for g_gnx).
   A dropped PROT_NONE interval is a missing EFAULT; a dropped non-executable
   interval is an instruction fetch Linux would have refused.

   REMOVAL needs no new code.  *_clear_raw already splits an interval that
   straddles the cleared range -- it was written for exactly the "mprotect a
   sub-range of a big PROT_NONE reservation" case, which is the same operation
   as unmapping the middle of a merged interval.  The split's one-extra-slot
   capacity guard (`count < GNA_MAX`) is also already there; coalescing takes
   the peak population from 512 to roughly 190, so that guard stops firing
   rather than starts.

   The ADD path, in contrast, becomes SIMPLER under coalescing: an interval
   that overlaps OR abuts the added one denotes the same predicate over the
   same bytes, so it is absorbed whole and the added bounds grow to the union.
   No splitting arises on insert at all.

   THE OFF PATH IS THE ORIGINAL BODY VERBATIM.  The absorbing scan is a
   SEPARATE function from *_clear_raw and the choice is made ONCE per add
   (93k times on the cc1 run), never inside a scan loop.  A sibling lane
   measured +1.60% with its flag off after folding new bookkeeping into a scan
   loop behind a predicate; not one instruction is added to any scanned entry
   here.

   g_gbus is deliberately NOT coalesced: it holds no entries at all on this
   workload (its min/max envelope rejects every query in O(1)), and its
   park/unpark pairing moves intervals between two arrays by intersection, a
   contract that merging would have to be re-argued against for no measured
   gain. */
static int g_bus_range_coalesce_state = -1;
static int bus_range_coalesce_selected(void) {
    if (g_bus_range_coalesce_state < 0)
        g_bus_range_coalesce_state = hl_option_flag_value("HL_X86_BUS_RANGE_COALESCE", 0);
    return g_bus_range_coalesce_state;
}

/* Absorb every live interval that overlaps OR abuts [*lo,*hi) into it, so the
   caller appends ONE interval covering their union.  Reachable only with
   HL_X86_BUS_RANGE_COALESCE on.

   Growing the bounds can expose a further neighbour, so the scan repeats until
   a pass grows nothing.  Under the invariant this function itself maintains --
   no two live intervals overlap or abut -- the second pass finds nothing and
   exits, because an interval abutting the NEW bound would have had to abut the
   one just absorbed.  The loop is kept unconditional anyway: the checkpoint
   restore path and the test hooks install a saved array wholesale, and each
   continuing pass strictly removes an entry, so it terminates regardless. */
#define BUS_RANGE_ABSORB(NAME, ARR, COUNTVAR)                                                                          \
    static void NAME(uint64_t *io_lo, uint64_t *io_hi) {                                                               \
        uint64_t lo = *io_lo, hi = *io_hi;                                                                             \
        for (int pass = 0; pass < GNA_MAX; ++pass) {                                                                   \
            int grew = 0;                                                                                              \
            int count = __atomic_load_n(&COUNTVAR, __ATOMIC_RELAXED);                                                  \
            for (int i = 0; i < count;) {                                                                              \
                uint64_t b = __atomic_load_n(&ARR[i].lo, __ATOMIC_RELAXED);                                            \
                uint64_t e = __atomic_load_n(&ARR[i].hi, __ATOMIC_RELAXED);                                            \
                if (e < lo || b > hi) { /* disjoint AND not abutting: keep */                                          \
                    ++i;                                                                                               \
                    continue;                                                                                          \
                }                                                                                                      \
                if (b < lo) {                                                                                          \
                    lo = b;                                                                                            \
                    grew = 1;                                                                                          \
                }                                                                                                      \
                if (e > hi) {                                                                                          \
                    hi = e;                                                                                            \
                    grew = 1;                                                                                          \
                }                                                                                                      \
                --count; /* swap the tail entry down; re-examine slot i */                                             \
                __atomic_store_n(&ARR[i].lo, __atomic_load_n(&ARR[count].lo, __ATOMIC_RELAXED), __ATOMIC_RELAXED);     \
                __atomic_store_n(&ARR[i].hi, __atomic_load_n(&ARR[count].hi, __ATOMIC_RELAXED), __ATOMIC_RELAXED);     \
                __atomic_store_n(&COUNTVAR, count, __ATOMIC_RELEASE);                                                  \
            }                                                                                                          \
            if (!grew) break;                                                                                          \
        }                                                                                                              \
        *io_lo = lo;                                                                                                   \
        *io_hi = hi;                                                                                                   \
    }

BUS_RANGE_ABSORB(gna_absorb_adjacent, g_gna, g_ngna)

static void gna_add(uint64_t lo, uint64_t hi) {
    if (hi <= lo) return;
    gna_writer_lock();
    atomic_fetch_add_explicit(&g_gna_generation, 1, memory_order_acq_rel);
    if (bus_range_coalesce_selected())
        gna_absorb_adjacent(&lo, &hi); // absorb overlapping AND abutting; appends their union
    else
        gna_clear_raw(lo, hi); // coalesce inside the same odd-generation transaction
    int count = __atomic_load_n(&g_ngna, __ATOMIC_RELAXED);
    if (count < GNA_MAX) {
        __atomic_store_n(&g_gna[count].lo, lo, __ATOMIC_RELAXED);
        __atomic_store_n(&g_gna[count].hi, hi, __ATOMIC_RELAXED);
        __atomic_store_n(&g_ngna, count + 1, __ATOMIC_RELEASE);
        uint64_t first = atomic_load_explicit(&g_gna_filter_first, memory_order_relaxed);
        uint64_t last = atomic_load_explicit(&g_gna_filter_last, memory_order_relaxed);
        if (lo < first) atomic_store_explicit(&g_gna_filter_first, lo, memory_order_relaxed);
        if (hi > last) atomic_store_explicit(&g_gna_filter_last, hi, memory_order_relaxed);
    }
    atomic_fetch_add_explicit(&g_gna_generation, 1, memory_order_release);
    gna_writer_unlock();
}

static void gna_filter(uint64_t *first, uint64_t *last) {
    uint64_t low = atomic_load_explicit(&g_gna_filter_first, memory_order_acquire);
    uint64_t high = atomic_load_explicit(&g_gna_filter_last, memory_order_acquire);
    if (low < *first) *first = low;
    if (high > *last) *last = high;
}

// Remove [lo,hi) from the set (access granted, or the range unmapped/re-mapped), splitting any interval
// that straddles the boundary so a partial grant (mprotect of a sub-range of a big PROT_NONE reservation)
// keeps the still-inaccessible remainder tracked.
static void gna_clear(uint64_t lo, uint64_t hi) {
    if (hi <= lo) return;
    gna_writer_lock();
    atomic_fetch_add_explicit(&g_gna_generation, 1, memory_order_acq_rel);
    gna_clear_raw(lo, hi);
    atomic_fetch_add_explicit(&g_gna_generation, 1, memory_order_release);
    gna_writer_unlock();
}

static void gna_clear_raw(uint64_t lo, uint64_t hi) {
    int count = __atomic_load_n(&g_ngna, __ATOMIC_RELAXED);
    for (int i = 0; i < count;) {
        uint64_t b = __atomic_load_n(&g_gna[i].lo, __ATOMIC_RELAXED);
        uint64_t e = __atomic_load_n(&g_gna[i].hi, __ATOMIC_RELAXED);
        if (lo >= e || hi <= b) {
            i++;
            continue;
        }
        int keep_head = b < lo, keep_tail = hi < e;
        if (!keep_head && !keep_tail) {
            --count;
            __atomic_store_n(&g_gna[i].lo, __atomic_load_n(&g_gna[count].lo, __ATOMIC_RELAXED), __ATOMIC_RELAXED);
            __atomic_store_n(&g_gna[i].hi, __atomic_load_n(&g_gna[count].hi, __ATOMIC_RELAXED), __ATOMIC_RELAXED);
            __atomic_store_n(&g_ngna, count, __ATOMIC_RELEASE);
            continue;
        }
        if (keep_head)
            __atomic_store_n(&g_gna[i].hi, lo, __ATOMIC_RELAXED); // trim to the surviving head [b,lo)
        else
            __atomic_store_n(&g_gna[i].lo, hi, __ATOMIC_RELAXED); // keep_tail only: [hi,e)
        if (keep_head && keep_tail && count < GNA_MAX) {          // middle grant -> tail becomes a 2nd entry
            __atomic_store_n(&g_gna[count].lo, hi, __ATOMIC_RELAXED);
            __atomic_store_n(&g_gna[count].hi, e, __ATOMIC_RELAXED);
            __atomic_store_n(&g_ngna, ++count, __ATOMIC_RELEASE);
        }
        i++;
    }
}

// True iff any byte of [a,a+len) lies in a tracked guest PROT_NONE region.
static int gna_hit(uint64_t a, uint64_t len) {
    if (!len || __atomic_load_n(&g_ngna, __ATOMIC_ACQUIRE) == 0) return 0;
    a = nonpie_unfold(a); // registry keys are guest coordinates; callers may hold either (see the rule above)
    uint64_t end = a + len;
    uint64_t first_page = a >> 12, last_page = (end - 1) >> 12;
    uint32_t slot = (uint32_t)(first_page * 2654435761u) & (GNA_NEGATIVE_N - 1);
    for (int attempt = 0; attempt < 4096; ++attempt) {
        uint64_t generation = atomic_load_explicit(&g_gna_generation, memory_order_acquire);
        if (generation & 1) {
            sched_yield();
            continue;
        }
        if (first_page == last_page && g_gna_negative_generation[slot] == generation &&
            g_gna_negative_page[slot] == first_page &&
            atomic_load_explicit(&g_gna_generation, memory_order_acquire) == generation)
            return 0;
        int count = __atomic_load_n(&g_ngna, __ATOMIC_ACQUIRE);
        int hit = 0;
        for (int i = 0; i < count; ++i) {
            uint64_t lo = __atomic_load_n(&g_gna[i].lo, __ATOMIC_RELAXED);
            uint64_t hi = __atomic_load_n(&g_gna[i].hi, __ATOMIC_RELAXED);
            if (a < hi && end > lo) {
                hit = 1;
                break;
            }
        }
        if (atomic_load_explicit(&g_gna_generation, memory_order_acquire) != generation) continue;
        if (!hit && first_page == last_page) {
            g_gna_negative_page[slot] = first_page;
            g_gna_negative_generation[slot] = generation;
        }
        return hit;
    }
    return 1;
}

// True iff EVERY guest page of [a,a+len) is in a tracked guest PROT_NONE region -- the whole-MAPPING
// question, which gna_hit ("any byte") must not be used for: a glibc pthread stack is one mmap whose first
// page is the guard. Walks PAGES, not intervals, so it is insensitive to how the coverage is split across
// entries -- true whether or not HL_X86_BUS_RANGE_COALESCE merged a piecewise-mprotect'd reservation.
static int gna_all(uint64_t a, uint64_t len) {
    if (!len || __atomic_load_n(&g_ngna, __ATOMIC_ACQUIRE) == 0) return 0;
    uint64_t end = a + len;
    for (uint64_t page = a & ~(uint64_t)0xfff; page < end; page += 0x1000)
        if (!gna_hit(page, 1)) return 0;
    return 1;
}

// How many LEADING bytes of [a,a+len) are outside every tracked guest PROT_NONE region. Linux's
// copy_to_user is byte-granular: a read(2) whose destination straddles a PROT_NONE page copies the good
// prefix and returns that SHORT count, reporting EFAULT only when the prefix is empty. gna_hit alone
// cannot express that (it is all-or-nothing), so the read family clamps its count with this instead.
/* HL_X86_GNA_PAGE_CACHE: consult the per-thread clean-page cache instead of
   re-walking the whole PROT_NONE ledger.  Off by default; unset is
   byte-identical to the full walk.

   WHY THIS IS THE SAME ANSWER, NOT AN APPROXIMATION.  gna_prefix answers "how
   many LEADING bytes of [a,a+len) lie outside every tracked interval".  A slot
   is published only when the walk it replaces returned the FULL length -- i.e.
   proved that no interval overlaps [a,a+len) at all -- and only for pages
   ENTIRELY inside that proven-clean span.  A later query is answered from a
   slot only when [a,a+len) lies entirely inside that one page and the ledger
   generation is unchanged.  "No interval overlaps page P" implies "no interval
   overlaps any sub-range of P", so the cached answer is exactly `len`, which
   is exactly what the walk would return.  Nothing here assumes the ledger's
   intervals are page aligned, and no query is answered from a page the walk
   did not fully cover.

   SEQLOCK DISCIPLINE is unchanged: the slot is read inside the same
   even-generation window the walk uses and re-validated against the same
   generation afterwards, so a concurrent mmap/mprotect/munmap forces a retry
   exactly as it does for the walk.  The arrays are _Thread_local, so the only
   interleaving possible is a signal handler between the two publishing
   stores; page is stored before generation, so a handler either sees a slot
   that does not name its page (miss, full walk) or one that does -- and that
   page has already been proven clean at this generation. */
static int g_gna_page_cache_state = -1;
static int gna_page_cache_selected(void) {
    if (g_gna_page_cache_state < 0) g_gna_page_cache_state = hl_option_flag_value("HL_X86_GNA_PAGE_CACHE", 0);
    return g_gna_page_cache_state;
}

static unsigned gna_clean_slot(uint64_t page) {
    return (unsigned)((page >> 12) * 2654435761u) & (GNA_CLEAN_N - 1u);
}

/* Record every page lying ENTIRELY inside the proven-clean span [a,a+len).
   Bounded so a very wide grant cannot spend more publishing than the walk it
   is replacing; the pages that matter are the accessed one and its immediate
   neighbours, which come first. */
#define GNA_CLEAN_PUBLISH_MAX 8u
static void gna_clean_publish(uint64_t a, uint64_t len, uint64_t generation) {
    uint64_t end = a + len;
    if (end < a) return;
    uint64_t page = (a + UINT64_C(4095)) & ~UINT64_C(4095);
    if (page < a) return;
    for (unsigned published = 0; published < GNA_CLEAN_PUBLISH_MAX; ++published) {
        if (page > UINT64_MAX - UINT64_C(4096) || page + UINT64_C(4096) > end) return;
        unsigned slot = gna_clean_slot(page);
        g_gna_clean_page[slot] = page;
        g_gna_clean_generation[slot] = generation;
        page += UINT64_C(4096);
    }
}

/* The shipped full walk.  This body is byte-for-byte what gna_prefix was
   before HL_X86_GNA_PAGE_CACHE existed, and it is what runs when the option is
   unset or off -- no extra test inside the scan loop, so the default path is
   not merely equivalent but identical.  (An earlier revision folded the
   cache's page bookkeeping into this loop behind a predicate; with the option
   OFF that still cost one load-and-branch on each of ~130 M scanned entries
   and measured +1.60% on a whole cc1 run.  A gate that is off must cost
   nothing, so the two scans are now separate functions.) */
static uint64_t gna_prefix_full(uint64_t a, uint64_t len) {
    for (int attempt = 0; attempt < 4096; ++attempt) {
        uint64_t generation = atomic_load_explicit(&g_gna_generation, memory_order_acquire);
        if (generation & 1) {
            sched_yield();
            continue;
        }
        uint64_t end = a + len;
        int count = __atomic_load_n(&g_ngna, __ATOMIC_ACQUIRE);
        for (int i = 0; i < count; ++i) {
            uint64_t lo = __atomic_load_n(&g_gna[i].lo, __ATOMIC_RELAXED);
            uint64_t hi = __atomic_load_n(&g_gna[i].hi, __ATOMIC_RELAXED);
            if (a < hi && end > lo) {
                uint64_t first = lo > a ? lo : a;
                if (first - a < end - a) end = first;
            }
        }
        if (atomic_load_explicit(&g_gna_generation, memory_order_acquire) == generation) return end - a;
    }
    return 0;
}

/* The same question, answered through the per-thread clean-page cache. */
static uint64_t gna_prefix_cached(uint64_t a, uint64_t len) {
    uint64_t page = a & ~UINT64_C(4095);
    /* Answerable from one slot only when the WHOLE query lies inside one page. */
    int single_page = a + len > a && page <= UINT64_MAX - UINT64_C(4096) &&
                      ((a + len - 1) & ~UINT64_C(4095)) == page;
    uint64_t page_end = page + UINT64_C(4096);
    unsigned slot = single_page ? gna_clean_slot(page) : 0;
    for (int attempt = 0; attempt < 4096; ++attempt) {
        uint64_t generation = atomic_load_explicit(&g_gna_generation, memory_order_acquire);
        if (generation & 1) {
            sched_yield();
            continue;
        }
        if (single_page && g_gna_clean_generation[slot] == generation && g_gna_clean_page[slot] == page &&
            atomic_load_explicit(&g_gna_generation, memory_order_acquire) == generation)
            return len;
        uint64_t end = a + len;
        int count = __atomic_load_n(&g_ngna, __ATOMIC_ACQUIRE);
        /* Learn the containing page's verdict in the SAME pass.  The walk is
           already touching every interval, so proving "nothing overlaps this
           page" costs one extra compare per entry and makes even a narrow
           query warm the slot -- without it only a query that happened to span
           a whole page could ever publish one. */
        int page_clean = single_page;
        for (int i = 0; i < count; ++i) {
            uint64_t lo = __atomic_load_n(&g_gna[i].lo, __ATOMIC_RELAXED);
            uint64_t hi = __atomic_load_n(&g_gna[i].hi, __ATOMIC_RELAXED);
            if (a < hi && end > lo) {
                uint64_t first = lo > a ? lo : a;
                if (first - a < end - a) end = first;
            }
            if (page_clean && page < hi && page_end > lo) page_clean = 0;
        }
        if (atomic_load_explicit(&g_gna_generation, memory_order_acquire) == generation) {
            if (single_page) {
                if (page_clean) {
                    g_gna_clean_page[slot] = page;
                    g_gna_clean_generation[slot] = generation;
                }
            } else if (end - a == len) {
                gna_clean_publish(a, len, generation);
            }
            return end - a;
        }
    }
    return 0;
}

static uint64_t gna_prefix(uint64_t a, uint64_t len) {
    if (!len || __atomic_load_n(&g_ngna, __ATOMIC_ACQUIRE) == 0) return len;
    a = nonpie_unfold(a); // guest-keyed registry; the return is a LENGTH, so the coordinate cancels
    if (gna_page_cache_selected()) return gna_prefix_cached(a, len);
    return gna_prefix_full(a, len);
}


#if HL_NATIVE_TEST_HOOKS
/* ---------------------------------------------------------------------------
   Differential boundary battery for the gna page-clean cache.

   Every probe below is answered THREE times: once with the cache forced off
   (the full ledger walk, i.e. the shipped default), then twice with it forced
   on (so the second pass runs against warm slots).  Any disagreement between
   the three answers is a failure.  The battery deliberately covers the cases
   where an index most easily diverges from a walk: an address exactly at a
   range start and at a range end, a query spanning two ADJACENT ranges, a
   query spanning a GAP between ranges, a zero-length query, a range added and
   removed mid-run, the prefix query's PARTIAL-coverage case, and sub-page
   queries inside a page the cache has published as clean.
   --------------------------------------------------------------------------- */
#define GNA_DIFF_PROBES 18u

static void gna_probe_battery(uint64_t base, uint64_t *out) {
#define PG(n) (base + (uint64_t)(n)*UINT64_C(4096))
    unsigned i = 0;
    out[i++] = gna_prefix(PG(2), 1);                 /* exactly at a range start */
    out[i++] = gna_prefix(PG(2) - 1, 1);             /* the byte before it */
    out[i++] = gna_prefix(PG(4) - 1, 1);             /* last byte of the 2nd range */
    out[i++] = gna_prefix(PG(4), 1);                 /* exactly at a range end */
    out[i++] = gna_prefix(PG(2), UINT64_C(0x2000));  /* spans two ADJACENT ranges */
    out[i++] = gna_prefix(PG(4), UINT64_C(0x3000));  /* spans a GAP, then a range */
    out[i++] = gna_prefix(PG(1), 0);                 /* zero length */
    out[i++] = gna_prefix(PG(2) - 16, 32);           /* PARTIAL coverage */
    out[i++] = gna_prefix(PG(1), UINT64_C(0x1000));  /* a whole clean page */
    out[i++] = gna_prefix(PG(1) + 8, 8);             /* sub-range of that page */
    out[i++] = gna_prefix(PG(1) + UINT64_C(0xff0), UINT64_C(0x20)); /* straddles into a range */
    out[i++] = gna_prefix(PG(4), UINT64_C(0x1000));  /* clean page just past a range end */
    out[i++] = gna_prefix(PG(5), UINT64_C(0x2000));  /* clean page, then a range */
    out[i++] = gna_prefix(PG(8), UINT64_C(0x4000));  /* multi-page clean span */
    out[i++] = gna_prefix(PG(8) + UINT64_C(0x2000), 4); /* sub-range of a later page */
    out[i++] = (uint64_t)gna_hit(PG(2), 1);
    out[i++] = (uint64_t)gna_hit(PG(4), 1);
    out[i++] = (uint64_t)gna_hit(PG(1), UINT64_C(0x1000));
#undef PG
}

/* The battery, plus a mid-run add/remove of a range the cache has already
   published a clean verdict for.  Returns the probe values so the caller can
   compare cache-off against cache-on. */
static void gna_probe_round(uint64_t guest, uint64_t base, uint64_t *out) {
    gna_probe_battery(base, out);
    /* Range ADDED mid-run over a page the cache just published as clean. */
    gna_add(guest + UINT64_C(0x5000), guest + UINT64_C(0x6000));
    out[GNA_DIFF_PROBES + 0] = gna_prefix(base + UINT64_C(0x5000), UINT64_C(0x1000));
    out[GNA_DIFF_PROBES + 1] = gna_prefix(base + UINT64_C(0x5008), 8);
    /* ...and REMOVED again. */
    gna_clear(guest + UINT64_C(0x5000), guest + UINT64_C(0x6000));
    out[GNA_DIFF_PROBES + 2] = gna_prefix(base + UINT64_C(0x5000), UINT64_C(0x1000));
    out[GNA_DIFF_PROBES + 3] = gna_prefix(base + UINT64_C(0x5008), 8);
}

#define GNA_DIFF_TOTAL (GNA_DIFF_PROBES + 4u)


/* ---------------------------------------------------------------------------
   HL_X86_BUS_RANGE_COALESCE -- the cases MERGING introduces.

   Coalescing changes STORED DATA on a path that gates memory-fault behaviour,
   so the contract it must meet is not "it is faster" but "the merged ledger
   answers every question exactly as the fragmented one did".  That is a
   differential, and it is checked here by running an identical scripted
   sequence of adds and removals twice -- once with merging off, once with it
   on -- and comparing every answer.  Crossed with the page cache's own off /
   on / on-warm arms, so the cache is also proven correct against a COALESCED
   ledger, which is a ledger shape it never saw before.

   The script covers exactly the cases merging introduces: two abutting ranges
   merged; three merged where the MIDDLE arrives last; a query spanning a
   merged boundary; removal of the exact MIDDLE of a merged range (the split);
   removal of a whole merged range; removal of a PREFIX and of a SUFFIX; and
   an interleaved add/remove sequence driving the population up and down
   across the merge threshold.  gna_all is included because it is the one
   reader that walks PAGES rather than intervals, and so is the reader least
   likely to agree with the others if a merge were wrong.
   --------------------------------------------------------------------------- */
/* Restore a ledger snapshot taken before the battery ran. */
static void gna_snapshot_restore(const void *saved, int saved_count) {
    gna_writer_lock();
    atomic_fetch_add_explicit(&g_gna_generation, 1, memory_order_acq_rel);
    memcpy(g_gna, saved, sizeof g_gna);
    __atomic_store_n(&g_ngna, saved_count, __ATOMIC_RELEASE);
    atomic_fetch_add_explicit(&g_gna_generation, 1, memory_order_release);
    gna_writer_unlock();
}

#define GNA_COAL_PROBES 35u

static unsigned gna_coalesce_probe_round(uint64_t guest, uint64_t base, uint64_t *out) {
#define G(n) (guest + (uint64_t)(n)*UINT64_C(4096))
#define B(n) (base + (uint64_t)(n)*UINT64_C(4096))
    unsigned i = 0;
    gna_clear(G(0), G(32));

    /* (a) MERGE OF TWO ABUTTING RANGES, and a query spanning the boundary. */
    gna_add(G(2), G(3));
    gna_add(G(3), G(4));
    out[i++] = gna_prefix(B(2), 1);                    /* start of the merged span: refused */
    out[i++] = gna_prefix(B(4) - 1, 1);                /* its last byte: refused */
    out[i++] = gna_prefix(B(4), 1);                    /* one past it: granted */
    out[i++] = gna_prefix(B(1), UINT64_C(0x3000));     /* SPANS THE MERGED BOUNDARY */
    out[i++] = gna_prefix(B(3) - 8, 16);               /* straddles the internal seam */
    out[i++] = (uint64_t)gna_hit(B(3), 1);             /* the seam itself */
    out[i++] = (uint64_t)gna_all(B(2), UINT64_C(0x2000));
    out[i++] = gna_prefix(B(1), UINT64_C(0x1000));     /* the page BELOW stays granted */
    out[i++] = gna_prefix(B(4), UINT64_C(0x1000));     /* the page ABOVE stays granted */

    /* (b) MERGE OF THREE WHERE THE MIDDLE ARRIVES LAST.  The two probes in the
       still-open hole are what distinguish a correct merge from one whose
       reach is too wide: an absorb that swallowed a NEAR but non-abutting
       neighbour would invent coverage across exactly this gap. */
    gna_add(G(6), G(7));
    gna_add(G(8), G(9));
    out[i++] = gna_prefix(B(7), UINT64_C(0x1000));     /* THE HOLE: still granted */
    out[i++] = (uint64_t)gna_hit(B(7), UINT64_C(0x1000));
    out[i++] = gna_prefix(B(6), UINT64_C(0x3000));     /* the hole is still open */
    gna_add(G(7), G(8));                               /* ...and now it closes */
    out[i++] = gna_prefix(B(6), UINT64_C(0x3000));
    out[i++] = gna_prefix(B(7), 1);
    out[i++] = gna_prefix(B(9), 1);
    out[i++] = gna_prefix(B(5), UINT64_C(0x5000));     /* spans BOTH merged seams */
    out[i++] = (uint64_t)gna_all(B(6), UINT64_C(0x3000));

    /* (c) REMOVAL OF THE EXACT MIDDLE of a merged range -- the SPLIT case. */
    gna_clear(G(7), G(8));
    out[i++] = gna_prefix(B(7), UINT64_C(0x1000));     /* the hole is accessible again */
    out[i++] = gna_prefix(B(6), UINT64_C(0x3000));     /* still refused at the start */
    out[i++] = (uint64_t)gna_hit(B(7), UINT64_C(0x1000));
    out[i++] = (uint64_t)gna_hit(B(8), 1);
    out[i++] = (uint64_t)gna_all(B(6), UINT64_C(0x3000));

    /* (d) REMOVAL OF A PREFIX, then of a SUFFIX, of a merged range. */
    gna_add(G(7), G(8));                               /* merged back to [6,9) */
    gna_clear(G(6), G(7));                             /* prefix removed */
    out[i++] = gna_prefix(B(6), UINT64_C(0x1000));
    out[i++] = gna_prefix(B(7), 1);
    gna_clear(G(8), G(9));                             /* suffix removed */
    out[i++] = gna_prefix(B(8), UINT64_C(0x1000));
    out[i++] = gna_prefix(B(7), UINT64_C(0x2000));
    out[i++] = (uint64_t)gna_hit(B(7), UINT64_C(0x1000));

    /* (e) REMOVAL OF A WHOLE MERGED RANGE. */
    gna_clear(G(7), G(8));
    out[i++] = gna_prefix(B(6), UINT64_C(0x3000));
    out[i++] = (uint64_t)gna_hit(B(6), UINT64_C(0x3000));

    /* (f) INTERLEAVED ADD/REMOVE driving the population up and down across the
       merge threshold: 24 abutting pages in, every other one out (which under
       merging SPLITS the single entry 12 times), then all of them back. */
    for (int p = 8; p < 32; ++p) gna_add(G(p), G(p + 1));
    out[i++] = gna_prefix(B(8), UINT64_C(0x18000));
    for (int p = 8; p < 32; p += 2) gna_clear(G(p), G(p + 1));
    out[i++] = gna_prefix(B(8), UINT64_C(0x1000));
    out[i++] = gna_prefix(B(9), UINT64_C(0x1000));
    for (int p = 8; p < 32; p += 2) gna_add(G(p), G(p + 1));
    out[i++] = gna_prefix(B(8), UINT64_C(0x18000));
    out[i++] = (uint64_t)gna_all(B(8), UINT64_C(0x18000));
    gna_clear(G(0), G(32));
    out[i++] = gna_prefix(B(8), UINT64_C(0x18000));
#undef G
#undef B
    return i;
}

#define GNA_ROUND_TOTAL (GNA_DIFF_TOTAL + GNA_COAL_PROBES)

/* Reinstate the page-cache battery's three-interval window, then run both
   probe sets.  The window is reinstated per round because the coalescing
   script deliberately ends with it empty. */
static int gna_full_round(uint64_t guest, uint64_t base, uint64_t *out) {
    gna_clear(guest - UINT64_C(0x10000), guest + UINT64_C(0x20000));
    gna_add(guest + UINT64_C(0x2000), guest + UINT64_C(0x3000));
    gna_add(guest + UINT64_C(0x3000), guest + UINT64_C(0x4000)); /* ADJACENT to the first */
    gna_add(guest + UINT64_C(0x6000), guest + UINT64_C(0x7000)); /* after a GAP */
    gna_probe_round(guest, base, out);
    return gna_coalesce_probe_round(guest, base, out + GNA_DIFF_TOTAL) == GNA_COAL_PROBES ? 0 : -1;
}

static int gna_page_cache_differential_test(uint64_t *probes) {
    uint64_t *saved = malloc(sizeof g_gna);
    if (saved == NULL) return -ENOMEM;
    gna_writer_lock();
    int saved_count = __atomic_load_n(&g_ngna, __ATOMIC_RELAXED);
    memcpy(saved, g_gna, sizeof g_gna);
    gna_writer_unlock();
    int saved_state = g_gna_page_cache_state;

    int saved_coalesce = g_bus_range_coalesce_state;

    uint64_t guest = UINT64_C(0x50000000);
    guest -= nonpie_fold(guest) & UINT64_C(4095);
    uint64_t base = nonpie_fold(guest);

    /* Work on a window of the ledger rather than resetting it, so unrelated
       live entries stay in place and the walk stays representative.
       gna_full_round reinstates the window itself, because the coalescing
       script deliberately empties it. */
    static uint64_t answers[2][3][GNA_ROUND_TOTAL];
    int result = 0;
    for (int coalesce = 0; coalesce < 2 && result == 0; ++coalesce) {
        g_bus_range_coalesce_state = coalesce;
        g_gna_page_cache_state = 0;
        memset(g_gna_clean_page, 0, sizeof g_gna_clean_page);
        memset(g_gna_clean_generation, 0, sizeof g_gna_clean_generation);
        if (gna_full_round(guest, base, answers[coalesce][0]) != 0) result = -90;
        g_gna_page_cache_state = 1;
        if (gna_full_round(guest, base, answers[coalesce][1]) != 0) result = -90;
        if (gna_full_round(guest, base, answers[coalesce][2]) != 0) result = -90; /* warm */
    }

    /* (1) The PAGE CACHE agrees with the full walk -- under BOTH ledger
       shapes, so it is also proven against a coalesced ledger. */
    for (int coalesce = 0; coalesce < 2 && result == 0; ++coalesce)
        for (unsigned i = 0; i < GNA_ROUND_TOTAL; ++i)
            if (answers[coalesce][0][i] != answers[coalesce][1][i] ||
                answers[coalesce][0][i] != answers[coalesce][2][i])
                result = -(int)(100 + i);

    /* (2) The MERGED ledger answers exactly as the fragmented one, on every
       probe and in every page-cache arm.  This is the contract coalescing has
       to meet: it changes stored data, so it must change no answer. */
    for (int arm = 0; arm < 3 && result == 0; ++arm)
        for (unsigned i = 0; i < GNA_ROUND_TOTAL; ++i)
            if (answers[0][arm][i] != answers[1][arm][i]) result = -(int)(300 + i);

    /* The battery must be non-vacuous: it has to contain both refusals and
       grants, or an always-"len" cache -- or an always-"0" one -- would pass
       it.  Asserted separately over the page-cache probes and over the
       coalescing probes, so neither half can carry the other. */
    if (result == 0) {
        int refusals = 0, grants = 0;
        for (unsigned i = 0; i < GNA_DIFF_PROBES; ++i) {
            if (answers[0][0][i] == 0) refusals++;
            else grants++;
        }
        if (refusals < 4 || grants < 4) result = -99;
        refusals = grants = 0;
        for (unsigned i = GNA_DIFF_TOTAL; i < GNA_ROUND_TOTAL; ++i) {
            if (answers[0][0][i] == 0) refusals++;
            else grants++;
        }
        if (refusals < 6 || grants < 6) result = -98;
    }
    if (probes != NULL) *probes = GNA_ROUND_TOTAL;

    g_bus_range_coalesce_state = saved_coalesce;
    gna_clear(guest - UINT64_C(0x10000), guest + UINT64_C(0x20000));
    gna_snapshot_restore(saved, saved_count);
    free(saved);
    g_gna_page_cache_state = saved_state;
    return result;
}

/* Scenario 68.  The differential above proves merging changes no ANSWER; it
   cannot prove merging happened at all, and a no-op would satisfy it.  This
   asserts the structural facts directionally:

     * 24 abutting pages occupy 24 entries with the option off and exactly 1
       with it on -- the merge is real;
     * at CAPACITY the two differ in CORRECTNESS, not merely in size.  512 is a
       hard ceiling with no eviction: gna_add past it silently DROPS the
       interval, and the ledger then reports as ACCESSIBLE a page the guest
       made PROT_NONE -- a missing EFAULT, which is silent corruption.  600
       abutting pages reproduce that with merging off, and with merging on the
       same 600 pages occupy one entry and every one of them is refused.
       (This is not hypothetical: an instrumented cc1 -O2 run of THIS tree
       drops 43 g_gna adds and 7,326 g_gnx adds, plus 271 g_gnx split tails.) */
static int gna_coalesce_capacity_test(uint64_t *probes) {
    uint64_t *saved = malloc(sizeof g_gna);
    if (saved == NULL) return -ENOMEM;
    gna_writer_lock();
    int saved_count = __atomic_load_n(&g_ngna, __ATOMIC_RELAXED);
    memcpy(saved, g_gna, sizeof g_gna);
    gna_writer_unlock();
    int saved_state = g_bus_range_coalesce_state;

    uint64_t guest = UINT64_C(0x50000000);
    guest -= nonpie_fold(guest) & UINT64_C(4095);
    uint64_t base = nonpie_fold(guest);
    uint64_t span = UINT64_C(4096) * 700;
#define G(n) (guest + (uint64_t)(n)*UINT64_C(4096))
#define B(n) (base + (uint64_t)(n)*UINT64_C(4096))
    int result = 0, checks = 0;

    /* The merge is real: 24 abutting pages, off then on. */
    g_bus_range_coalesce_state = 0;
    gna_clear(guest, guest + span);
    int before = __atomic_load_n(&g_ngna, __ATOMIC_RELAXED);
    for (int p = 0; p < 24; ++p) gna_add(G(p), G(p + 1));
    int live_off = __atomic_load_n(&g_ngna, __ATOMIC_RELAXED) - before;
    g_bus_range_coalesce_state = 1;
    gna_clear(guest, guest + span);
    before = __atomic_load_n(&g_ngna, __ATOMIC_RELAXED);
    for (int p = 0; p < 24; ++p) gna_add(G(p), G(p + 1));
    int live_on = __atomic_load_n(&g_ngna, __ATOMIC_RELAXED) - before;
    checks++;
    if (live_off != 24) result = -91;
    checks++;
    if (live_on != 1) result = -92;

    /* A ledger that arrives ALREADY non-coalesced -- which the checkpoint
       restore path and the test hooks can both install wholesale -- must still
       collapse.  Build two abutting entries with merging off, turn it on, and
       add a third abutting the second: absorbing the second extends the bound
       onto the first, so only a scan that REPEATS after the bound grows finds
       it.  A single-pass absorb leaves two entries here, not one. */
    g_bus_range_coalesce_state = 0;
    gna_clear(guest, guest + span);
    before = __atomic_load_n(&g_ngna, __ATOMIC_RELAXED);
    gna_add(G(2), G(3));
    gna_add(G(3), G(4));
    g_bus_range_coalesce_state = 1;
    gna_add(G(4), G(5));
    int chained = __atomic_load_n(&g_ngna, __ATOMIC_RELAXED) - before;
    uint64_t chained_lo = gna_prefix(B(2), UINT64_C(0x3000));
    checks++;
    if (chained != 1 || chained_lo != 0) result = -96;

    /* At capacity: 600 abutting pages.  Off overflows and LOSES coverage. */
    g_bus_range_coalesce_state = 0;
    gna_clear(guest, guest + span);
    for (int p = 0; p < 600; ++p) gna_add(G(p), G(p + 1));
    int cap_off = __atomic_load_n(&g_ngna, __ATOMIC_RELAXED);
    uint64_t last_off = gna_prefix(B(599), UINT64_C(0x1000));
    g_bus_range_coalesce_state = 1;
    gna_clear(guest, guest + span);
    before = __atomic_load_n(&g_ngna, __ATOMIC_RELAXED);
    for (int p = 0; p < 600; ++p) gna_add(G(p), G(p + 1));
    int cap_on = __atomic_load_n(&g_ngna, __ATOMIC_RELAXED) - before;
    uint64_t last_on = gna_prefix(B(599), UINT64_C(0x1000));
    uint64_t first_on = gna_prefix(B(0), UINT64_C(0x1000));
    checks++;
    if (cap_off != GNA_MAX) result = -93;          /* the overflow must really occur */
    checks++;
    if (last_off != UINT64_C(0x1000)) result = -94; /* ...and must really lose the page */
    checks++;
    if (cap_on != 1 || last_on != 0 || first_on != 0) result = -95; /* merged: one entry, all refused */
#undef G
#undef B
    if (probes != NULL) *probes = (uint64_t)checks;
    gna_clear(guest, guest + span);
    gna_snapshot_restore(saved, saved_count);
    free(saved);
    g_bus_range_coalesce_state = saved_state;
    return result;
}

#endif

BUS_RANGE_ABSORB(gro_absorb_adjacent, g_gro, g_ngro)

static void gro_add(uint64_t lo, uint64_t hi) {
    if (hi <= lo) return;
    gro_writer_lock();
    atomic_fetch_add_explicit(&g_gro_generation, 1, memory_order_acq_rel);
    if (bus_range_coalesce_selected())
        gro_absorb_adjacent(&lo, &hi);
    else
        gro_clear_raw(lo, hi);
    if (g_ngro < GNA_MAX) {
        __atomic_store_n(&g_gro[g_ngro].lo, lo, __ATOMIC_RELAXED);
        __atomic_store_n(&g_gro[g_ngro].hi, hi, __ATOMIC_RELAXED);
        __atomic_store_n(&g_ngro, g_ngro + 1, __ATOMIC_RELEASE);
    }
    atomic_fetch_add_explicit(&g_gro_generation, 1, memory_order_release);
    gro_writer_unlock();
}

static void gro_clear(uint64_t lo, uint64_t hi) {
    if (hi <= lo) return;
    gro_writer_lock();
    atomic_fetch_add_explicit(&g_gro_generation, 1, memory_order_acq_rel);
    gro_clear_raw(lo, hi);
    atomic_fetch_add_explicit(&g_gro_generation, 1, memory_order_release);
    gro_writer_unlock();
}

static void gro_clear_raw(uint64_t lo, uint64_t hi) {
    for (int i = 0; i < g_ngro;) {
        uint64_t b = __atomic_load_n(&g_gro[i].lo, __ATOMIC_RELAXED);
        uint64_t e = __atomic_load_n(&g_gro[i].hi, __ATOMIC_RELAXED);
        if (lo >= e || hi <= b) {
            i++;
            continue;
        }
        int keep_head = b < lo, keep_tail = hi < e;
        if (!keep_head && !keep_tail) {
            --g_ngro;
            __atomic_store_n(&g_gro[i].lo, __atomic_load_n(&g_gro[g_ngro].lo, __ATOMIC_RELAXED), __ATOMIC_RELAXED);
            __atomic_store_n(&g_gro[i].hi, __atomic_load_n(&g_gro[g_ngro].hi, __ATOMIC_RELAXED), __ATOMIC_RELAXED);
            continue;
        }
        if (keep_head)
            __atomic_store_n(&g_gro[i].hi, lo, __ATOMIC_RELAXED);
        else
            __atomic_store_n(&g_gro[i].lo, hi, __ATOMIC_RELAXED);
        if (keep_head && keep_tail && g_ngro < GNA_MAX) {
            __atomic_store_n(&g_gro[g_ngro].lo, hi, __ATOMIC_RELAXED);
            __atomic_store_n(&g_gro[g_ngro].hi, e, __ATOMIC_RELAXED);
            __atomic_store_n(&g_ngro, g_ngro + 1, __ATOMIC_RELEASE);
        }
        i++;
    }
}

static int gro_hit(uint64_t a, uint64_t len) {
    if (!len || __atomic_load_n(&g_ngro, __ATOMIC_ACQUIRE) == 0) return 0;
    a = nonpie_unfold(a); // guest-keyed registry; a hardware fault address arrives in storage coordinates
    uint64_t end = a + len;
    // RETRY the seqlock instead of answering "read-only" while a writer is mid-update: any concurrent
    // mprotect/mmap (a peer's thread-stack allocation) otherwise EFAULTs an unrelated writable address.
    for (int attempt = 0; attempt < 4096; attempt++) {
        uint64_t generation = atomic_load_explicit(&g_gro_generation, memory_order_acquire);
        if (generation & 1) {
            sched_yield();
            continue;
        }
        int count = __atomic_load_n(&g_ngro, __ATOMIC_ACQUIRE);
        int hit = 0;
        for (int i = 0; i < count; i++) {
            uint64_t lo = __atomic_load_n(&g_gro[i].lo, __ATOMIC_RELAXED);
            uint64_t hi = __atomic_load_n(&g_gro[i].hi, __ATOMIC_RELAXED);
            if (a < hi && end > lo) {
                hit = 1;
                break;
            }
        }
        if (atomic_load_explicit(&g_gro_generation, memory_order_acquire) == generation) return hit;
    }
    return 1; // a writer that never settles: keep the conservative answer
}

// Number of leading bytes before the first guest read-only interval.  Like
// gna_prefix, this answers the span question without touching guest memory.
static uint64_t gro_prefix(uint64_t a, uint64_t len) {
    if (!len || __atomic_load_n(&g_ngro, __ATOMIC_ACQUIRE) == 0) return len;
    a = nonpie_unfold(a);
    for (int attempt = 0; attempt < 4096; ++attempt) {
        uint64_t generation = atomic_load_explicit(&g_gro_generation, memory_order_acquire);
        if (generation & 1) {
            sched_yield();
            continue;
        }
        uint64_t end = a + len;
        int count = __atomic_load_n(&g_ngro, __ATOMIC_ACQUIRE);
        for (int index = 0; index < count; ++index) {
            uint64_t low = __atomic_load_n(&g_gro[index].lo, __ATOMIC_RELAXED);
            uint64_t high = __atomic_load_n(&g_gro[index].hi, __ATOMIC_RELAXED);
            if (a < high && end > low) {
                uint64_t first = low > a ? low : a;
                if (first - a < end - a) end = first;
            }
        }
        if (atomic_load_explicit(&g_gro_generation, memory_order_acquire) == generation) return end - a;
    }
    return 0;
}

static void gnx_writer_lock(void) {
    while (atomic_flag_test_and_set_explicit(&g_gnx_writer, memory_order_acquire))
        sched_yield();
}

static void gnx_writer_unlock(void) {
    atomic_flag_clear_explicit(&g_gnx_writer, memory_order_release);
}

static void gnx_clear_raw(uint64_t lo, uint64_t hi) {
    int count = __atomic_load_n(&g_ngnx, __ATOMIC_RELAXED);
    for (int i = 0; i < count;) {
        uint64_t b = __atomic_load_n(&g_gnx[i].lo, __ATOMIC_RELAXED);
        uint64_t e = __atomic_load_n(&g_gnx[i].hi, __ATOMIC_RELAXED);
        if (lo >= e || hi <= b) {
            ++i;
            continue;
        }
        int keep_head = b < lo, keep_tail = hi < e;
        if (!keep_head && !keep_tail) {
            --count;
            __atomic_store_n(&g_gnx[i].lo, __atomic_load_n(&g_gnx[count].lo, __ATOMIC_RELAXED), __ATOMIC_RELAXED);
            __atomic_store_n(&g_gnx[i].hi, __atomic_load_n(&g_gnx[count].hi, __ATOMIC_RELAXED), __ATOMIC_RELAXED);
            __atomic_store_n(&g_ngnx, count, __ATOMIC_RELEASE);
            continue;
        }
        if (keep_head)
            __atomic_store_n(&g_gnx[i].hi, lo, __ATOMIC_RELAXED);
        else
            __atomic_store_n(&g_gnx[i].lo, hi, __ATOMIC_RELAXED);
        if (keep_head && keep_tail && count < GNA_MAX) {
            __atomic_store_n(&g_gnx[count].lo, hi, __ATOMIC_RELAXED);
            __atomic_store_n(&g_gnx[count].hi, e, __ATOMIC_RELAXED);
            __atomic_store_n(&g_ngnx, ++count, __ATOMIC_RELEASE);
        }
        ++i;
    }
}

BUS_RANGE_ABSORB(gnx_absorb_adjacent, g_gnx, g_ngnx)

static void gnx_add(uint64_t lo, uint64_t hi) {
    if (hi <= lo) return;
    gnx_writer_lock();
    int decode_authority = hl_guest_fetch_authority_begin();
    atomic_fetch_add_explicit(&g_gnx_generation, 1, memory_order_acq_rel);
    if (bus_range_coalesce_selected())
        gnx_absorb_adjacent(&lo, &hi);
    else
        gnx_clear_raw(lo, hi);
    int count = __atomic_load_n(&g_ngnx, __ATOMIC_RELAXED);
    if (count < GNA_MAX) {
        __atomic_store_n(&g_gnx[count].lo, lo, __ATOMIC_RELAXED);
        __atomic_store_n(&g_gnx[count].hi, hi, __ATOMIC_RELAXED);
        __atomic_store_n(&g_ngnx, count + 1, __ATOMIC_RELEASE);
    }
    atomic_fetch_add_explicit(&g_gnx_generation, 1, memory_order_release);
    hl_guest_fetch_authority_end(decode_authority);
    gnx_writer_unlock();
}

static void gnx_clear(uint64_t lo, uint64_t hi) {
    if (hi <= lo) return;
    gnx_writer_lock();
    int decode_authority = hl_guest_fetch_authority_begin();
    atomic_fetch_add_explicit(&g_gnx_generation, 1, memory_order_acq_rel);
    gnx_clear_raw(lo, hi);
    atomic_fetch_add_explicit(&g_gnx_generation, 1, memory_order_release);
    hl_guest_fetch_authority_end(decode_authority);
    gnx_writer_unlock();
}

static void gnx_reset(void) {
    gnx_writer_lock();
    int decode_authority = hl_guest_fetch_authority_begin();
    atomic_fetch_add_explicit(&g_gnx_generation, 1, memory_order_acq_rel);
    __atomic_store_n(&g_ngnx, 0, __ATOMIC_RELEASE);
    atomic_fetch_add_explicit(&g_gnx_generation, 1, memory_order_release);
    hl_guest_fetch_authority_end(decode_authority);
    gnx_writer_unlock();
}

#if defined(HL_X86_DECODE_MEMO_TEST)
void hl_x86_decode_test_invalidate_direct_registry(void) { gnx_reset(); }
#endif

typedef struct {
    uint64_t generation;
    uint64_t first;
    uint64_t last;
} guest_exec_page;

static _Thread_local guest_exec_page g_exec_page;
#define GUEST_EXEC_PAGE_CACHE_N 64u
static _Thread_local guest_exec_page g_exec_pages[GUEST_EXEC_PAGE_CACHE_N];
#if HL_NATIVE_TEST_HOOKS
static _Thread_local uint64_t g_gnx_scan_count;
static _Thread_local uint64_t g_guest_exec_validation_count;
#endif

static int gnx_hit(uint64_t a, uint64_t len) {
    if (!len || __atomic_load_n(&g_ngnx, __ATOMIC_ACQUIRE) == 0) return 0;
    a = nonpie_unfold(a);
    uint64_t end = a + len;
    if (end < a) return 1;
    for (int attempt = 0; attempt < 4096; ++attempt) {
        uint64_t generation = atomic_load_explicit(&g_gnx_generation, memory_order_acquire);
        if (generation & 1) {
            sched_yield();
            continue;
        }
        int count = __atomic_load_n(&g_ngnx, __ATOMIC_ACQUIRE);
#if HL_NATIVE_TEST_HOOKS
        g_gnx_scan_count++;
#endif
        int hit = 0;
        for (int i = 0; i < count; ++i) {
            uint64_t lo = __atomic_load_n(&g_gnx[i].lo, __ATOMIC_RELAXED);
            uint64_t hi = __atomic_load_n(&g_gnx[i].hi, __ATOMIC_RELAXED);
            if (a < hi && end > lo) {
                hit = 1;
                break;
            }
        }
        if (atomic_load_explicit(&g_gnx_generation, memory_order_acquire) == generation) return hit;
    }
    return 1;
}

static int guest_exec_direct_valid(uint64_t guest, size_t length) {
#if HL_NATIVE_TEST_HOOKS
    g_guest_exec_validation_count++;
#endif
    if (length == 0) return 1;
    if (guest > UINT64_MAX - length) return 0;
    uint64_t generation = atomic_load_explicit(&g_gnx_generation, memory_order_acquire);
    uint64_t end = guest + length;
    uint64_t first = guest & ~UINT64_C(4095);
    guest_exec_page *cached = &g_exec_pages[(first >> 12) & (GUEST_EXEC_PAGE_CACHE_N - 1u)];
    if (!(generation & 1) && cached->generation == generation && guest >= cached->first && end <= cached->last)
        return 1;
    if (!(generation & 1) && g_exec_page.generation == generation && guest >= g_exec_page.first &&
        end <= g_exec_page.last)
        return 1;

    if (first <= UINT64_MAX - UINT64_C(4096) && !gnx_hit(first, 4096)) {
        uint64_t confirmed = atomic_load_explicit(&g_gnx_generation, memory_order_acquire);
        if (confirmed == generation && !(confirmed & 1)) {
            g_exec_page = (guest_exec_page){confirmed, first, first + UINT64_C(4096)};
            *cached = g_exec_page;
            return 1;
        }
    }
    return !gnx_hit(guest, length);
}

#if HL_NATIVE_TEST_HOOKS
static void *g_nonpie_collision_mapping;
static int g_nonpie_collision_active;
int HL_TARGET_LOCAL(jit_rollover_mapping_test)(uint64_t *result);
int HL_TARGET_LOCAL(jit_preferred_mapping_test)(uint64_t *result);
int HL_TARGET_LOCAL(jit_fork_mapping_ownership_test)(uint64_t *result);

static int nonpie_collision_finish_release(int released) {
    if (released != 0) return -EIO;
    g_nonpie_collision_mapping = NULL;
    g_nonpie_collision_active = 0;
    return 0;
}

HL_API int HL_TARGET_LOCAL(exec_page_cache_test)(uint32_t scenario, uint64_t *scans) {
    if (scans == NULL) return -1;
    void *saved = malloc(sizeof g_gnx);
    if (saved == NULL) return -ENOMEM;
    gnx_writer_lock();
    int saved_count = __atomic_load_n(&g_ngnx, __ATOMIC_RELAXED);
    memcpy(saved, g_gnx, sizeof g_gnx);
    gnx_writer_unlock();
    guest_exec_page saved_page = g_exec_page;
    uint64_t guest_page = UINT64_C(0x40000000);
    guest_page -= nonpie_fold(guest_page) & UINT64_C(4095);
    uint64_t page = nonpie_fold(guest_page);
    gnx_reset();
    gnx_add(guest_page + UINT64_C(0x2000), guest_page + UINT64_C(0x3000));
    g_exec_page = (guest_exec_page){0};
    g_gnx_scan_count = 0;
    int result = 0;
    switch (scenario) {
    case 0: // Stable executable page: one scan, then cache hits.
        for (int i = 0; i < 32; ++i)
            if (!guest_exec_direct_valid(page + (uint64_t)i, 15)) result = -2;
        break;
    case 1: // mprotect/MAP_FIXED removing execute invalidates the warm verdict.
        if (!guest_exec_direct_valid(page, 15)) result = -3;
        gnx_add(guest_page, guest_page + UINT64_C(4096));
        if (guest_exec_direct_valid(page, 15)) result = -4;
        break;
    case 2: // munmap followed by an executable remap invalidates both transitions.
        if (!guest_exec_direct_valid(page, 15)) result = -5;
        gnx_add(guest_page, guest_page + UINT64_C(4096));
        gnx_clear(guest_page, guest_page + UINT64_C(4096));
        if (!guest_exec_direct_valid(page, 15)) result = -6;
        break;
    case 3: // exec reset drops the old image's non-executable ranges and cache verdict.
        if (!guest_exec_direct_valid(page, 15)) result = -7;
        gnx_add(guest_page, guest_page + UINT64_C(4096));
        gnx_reset();
        if (!guest_exec_direct_valid(page, 15)) result = -8;
        break;
    case 4: // A partially non-executable page is never cached as wholly valid.
        gnx_add(guest_page + 128, guest_page + 256);
        if (!guest_exec_direct_valid(page, 15) || !guest_exec_direct_valid(page + 16, 15)) result = -9;
        break;
#if defined(HL_X86_DECODE_MEMO_TEST)
    case 5:
    case 6:
    case 7:
    case 8:
    case 9:
    case 10:
    case 11: result = hl_x86_decode_memo_test(scenario, scans); break;
#endif
    case 12: {
        if (g_nonpie_collision_active) {
            result = -EALREADY;
            break;
        }
#if defined(__linux__)
        void *page = mmap((void *)(uintptr_t)UINT64_C(0x400000), 4096, PROT_READ | PROT_WRITE,
                          MAP_PRIVATE | MAP_ANONYMOUS | MAP_FIXED_NOREPLACE, -1, 0);
        if (page == MAP_FAILED || page != (void *)(uintptr_t)UINT64_C(0x400000)) {
            if (page != MAP_FAILED) (void)munmap(page, 4096);
            result = -EADDRINUSE;
            break;
        }
        g_nonpie_collision_mapping = page;
        g_nonpie_collision_active = 1;
        *scans = 1;
#else
        result = -ENOTSUP;
#endif
        break;
    }
    case 13: {
        if (!g_nonpie_collision_active) {
            result = -ENOENT;
            break;
        }
#if defined(__linux__)
        int release_result = nonpie_collision_finish_release(munmap(g_nonpie_collision_mapping, 4096));
        if (result == 0) result = release_result;
        *scans = 1;
#else
        result = -ENOTSUP;
#endif
        break;
    }
    case 14: { // A failed host release retains ownership so cleanup can be retried.
        if (!g_nonpie_collision_active) {
            result = -ENOENT;
            break;
        }
        result = nonpie_collision_finish_release(-1);
        if (!g_nonpie_collision_active || g_nonpie_collision_mapping == NULL) result = -EIO;
        break;
    }
    case 15:
    case 16:
    case 17: result = map_host_cache_test(scenario, scans); break;
    case 25: result = map_host_cache_test(scenario, scans); break;
    case 45:
    case 46:
    case 47:
    case 48:
    case 49:
    case 50:
    case 51:
    case 52: result = map_source_index_test(scenario, scans); break;
    case 67: result = gna_page_cache_differential_test(scans); break;
    case 68: result = gna_coalesce_capacity_test(scans); break;
    case 18: result = HL_TARGET_LOCAL(jit_rollover_mapping_test)(scans); break;
    case 53: result = HL_TARGET_LOCAL(jit_preferred_mapping_test)(scans); break;
    case 54: result = HL_TARGET_LOCAL(jit_fork_mapping_ownership_test)(scans); break;
    case 55:
    case 56:
    case 57:
    case 58:
    case 59:
    case 60:
    case 61:
    case 62:
    case 63:
    case 64:
    case 65:
    case 66: result = map_growth_test(scenario, scans); break;
    case 19: { // Fetch-span hits reuse the page verdict until its authority changes.
        _Alignas(4096) unsigned char page_bytes[4096] = {0};
        unsigned char byte = 0;
        hl_guest_memory_bind(&g_guest_memory_ops);
        hl_guest_fetch_set_direct_validator(guest_exec_direct_valid);
        hl_guest_fetch_set_direct_generation(&g_gnx_generation);
        g_exec_page = (guest_exec_page){0};
        g_guest_exec_validation_count = 0;
        for (size_t i = 0; i < 32; ++i) {
            if (hl_guest_fetch_exec((uint64_t)(uintptr_t)&page_bytes[i], &byte, 1) != 0 || byte != 0) {
                result = -EIO;
                break;
            }
        }
        *scans = g_guest_exec_validation_count;
        break;
    }
    case 20: { // Two hot executable pages retain independent generation-bound verdicts.
        for (int i = 0; i < 32; ++i) {
            uint64_t address = page + ((uint64_t)(i & 1) << 12);
            if (!guest_exec_direct_valid(address, 15)) {
                result = -EIO;
                break;
            }
        }
        *scans = g_gnx_scan_count;
        break;
    }
#if defined(HL_X86_DECODE_MEMO_TEST)
    case 21: result = hl_x86_hot_context_test(); break;
    case 22: result = hl_x86_hot_context_thread_test(); break;
    case 23: result = hl_x86_hot_context_allocation_test(); break;
    case 24: result = hl_x86_decode_transaction_window_test(scans); break;
    case 69: result = hl_x86_decode_thread_authority_test(scans); break;
    case 26:
    case 27:
    case 28:
    case 29:
    case 30:
    case 31:
    case 32:
    case 33:
    case 34: result = hl_x86_decode_authority_test(scenario, scans); break;
    case 35: result = hl_x86_decode_authority_test(scenario, scans); break;
    case 36: result = hl_x86_decode_authority_test(scenario, scans); break;
    case 37: result = hl_x86_decode_authority_test(scenario, scans); break;
    case 38: result = hl_x86_decode_authority_test(scenario, scans); break;
    case 39: result = hl_x86_decode_authority_test(scenario, scans); break;
    case 40: result = hl_x86_decode_authority_test(scenario, scans); break;
    case 41: result = hl_x86_decode_authority_test(scenario, scans); break;
    case 42: result = hl_x86_decode_authority_test(scenario, scans); break;
    case 43: result = hl_x86_decode_authority_test(scenario, scans); break;
    case 44: result = hl_x86_decode_authority_test(scenario, scans); break;
#endif
    default: result = -10;
    }
    if (scenario <= 4) *scans = g_gnx_scan_count;
    gnx_writer_lock();
    int decode_authority = hl_guest_fetch_authority_begin();
    atomic_fetch_add_explicit(&g_gnx_generation, 1, memory_order_acq_rel);
    memcpy(g_gnx, saved, sizeof g_gnx);
    __atomic_store_n(&g_ngnx, saved_count, __ATOMIC_RELEASE);
    atomic_fetch_add_explicit(&g_gnx_generation, 1, memory_order_release);
    hl_guest_fetch_authority_end(decode_authority);
    gnx_writer_unlock();
    free(saved);
    g_exec_page = saved_page;
    return result;
}
#endif

// execve replaces the whole address space -> drop all tracked PROT_NONE ranges (they're gone with the old
// image; a stale entry could otherwise wrongly EFAULT a fresh mapping the new image lays at the same address).
static void gna_reset(void) {
    gna_writer_lock();
    atomic_fetch_add_explicit(&g_gna_generation, 1, memory_order_acq_rel);
    __atomic_store_n(&g_ngna, 0, __ATOMIC_RELEASE);
    atomic_store_explicit(&g_gna_filter_first, UINT64_MAX, memory_order_relaxed);
    atomic_store_explicit(&g_gna_filter_last, 0, memory_order_relaxed);
    atomic_fetch_add_explicit(&g_gna_generation, 1, memory_order_release);
    gna_writer_unlock();
    __atomic_store_n(&g_ngro, 0, __ATOMIC_RELEASE);
    gnx_reset();
    pthread_mutex_lock(&g_filemap_lock);
    for (int index = 0; index < g_nfilemap; ++index) {
        int retained = g_filemap[index].fd;
        int first = 1;
        for (int previous = 0; previous < index; ++previous)
            if (g_filemap[previous].fd == retained) first = 0;
        if (first && retained >= 0) close(retained);
    }
    g_nfilemap = 0;
    pthread_mutex_unlock(&g_filemap_lock);
    hl_logical_vma_global_reset_quiescent();
    pthread_mutex_lock(&g_bus_transition);
    gbus_lock();
    int changed = g_ngbus != 0 || g_bus_fail_closed || g_bus_prepares != 0;
    atomic_store_explicit(&g_ngbus, 0, memory_order_release);
    g_ngbus_parked = 0;
    g_bus_fail_closed = 0;
    g_bus_prepares = 0;
    gbus_page_reset_locked();
    gbus_filter_rebuild_locked();
    atomic_store_explicit(&g_bus_filter_force, 0, memory_order_release);
    uint64_t generation = changed ? atomic_fetch_add_explicit(&g_bus_generation, 1, memory_order_release) + 1
                                  : atomic_load_explicit(&g_bus_generation, memory_order_relaxed);
    gbus_unlock();
    if (changed) gbus_notify(generation, 0);
    pthread_mutex_unlock(&g_bus_transition);
    /* Soft mode is intentionally sticky across temporary empty logical-VMA
       intervals.  exec/checkpoint image reset is the lifecycle boundary where
       old guarded translations are no longer useful; rotate once here before
       admitting direct, unguarded translations for the replacement image. */
    jit_guest_soft_deactivate();
}

// True iff host virtual address `a` is currently mapped. mincore() is useless on macOS (returns 0 for ANY
// address), so query the VM map directly: mach_vm_region returns the first region at-or-above `a`, and `a`
// is mapped iff it falls inside [start, start+size). Same technique as the x86 loader's lazy_addr_mapped.
// Used to mirror the kernel's fault-tolerant put_user() on the CLEARTID teardown path (futex_wake_addr).
