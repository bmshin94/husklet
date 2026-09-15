// -------------------------------------------- signalfd capture must not mutate a live OFD: behavioral fixture
//
// Drives the REAL ckpt_capture_signalfd against the REAL object production hands it. A guest signalfd in
// this engine is the read end of a self-pipe (signal.c, `struct sfd_ofd`): the guest holds the read end as
// an ordinary guest fd, the host signal handlers poke the write end, and dup(2) gives another descriptor
// onto the SAME open file description. That is what makes the property below a product property rather than
// a style preference -- O_NONBLOCK is a property of the open file description, not of the descriptor, so a
// drain that sets it changes what every alias and every forked holder of that signalfd sees, for the rest of
// the process's life.
//
// The drain used to set O_NONBLOCK and never put it back: not after a successful capture, not on the abort
// path, and not when the whole capture was abandoned afterwards because another member refused. Scenario 1
// is that abandoned capture. Scenario 2 is the obligation the O_NONBLOCK was there to discharge in the first
// place -- a drain that must not block on a blocking descriptor with nothing queued -- so a "fix" that
// simply deleted the mutation and reintroduced the hang fails here rather than hanging the suite.

struct ckpt_sfd_test_shared {
    _Atomic int claim;
    _Atomic unsigned length;
    _Atomic int fail_write;
    unsigned char bytes[4096];
};

static struct ckpt_sfd_test_shared *g_ckpt_sfd_test_shared;

static int ckpt_sfd_test_begin(struct ckpt_sink *sink, const char *group, const char *name, uint32_t flags,
                               struct ckpt_sink_stream **out) {
    (void)group;
    (void)name;
    (void)flags;
    static struct ckpt_sink_stream stream;
    memset(&stream, 0, sizeof stream);
    stream.sink = sink;
    *out = &stream;
    return 0;
}

static int ckpt_sfd_test_write(struct ckpt_sink_stream *stream, const void *data, size_t size) {
    (void)stream;
    struct ckpt_sfd_test_shared *shared = g_ckpt_sfd_test_shared;
    if (atomic_load(&shared->fail_write)) return -1; // the abandoned-capture arm
    unsigned at = atomic_load(&shared->length);
    if (size > sizeof shared->bytes - at) return -1;
    memcpy(shared->bytes + at, data, size);
    atomic_store(&shared->length, at + (unsigned)size);
    return 0;
}

static int ckpt_sfd_test_finish(struct ckpt_sink_stream *stream) {
    (void)stream;
    return 0;
}

static void ckpt_sfd_test_abort(struct ckpt_sink_stream *stream) {
    (void)stream;
}

static int ckpt_sfd_test_claim(struct ckpt_sink *sink, const char *name) {
    (void)sink;
    (void)name;
    int free_slot = 0;
    return atomic_compare_exchange_strong(&g_ckpt_sfd_test_shared->claim, &free_slot, 1) ? 0 : 1;
}

static void ckpt_sfd_test_unclaim(struct ckpt_sink *sink, const char *name) {
    (void)sink;
    (void)name;
    atomic_store(&g_ckpt_sfd_test_shared->claim, 0);
}

static const ckpt_sink_vtable g_ckpt_sfd_test_ops = {
    .begin = ckpt_sfd_test_begin,
    .write = ckpt_sfd_test_write,
    .finish = ckpt_sfd_test_finish,
    .abort = ckpt_sfd_test_abort,
    .claim = ckpt_sfd_test_claim,
    .unclaim = ckpt_sfd_test_unclaim,
};

static int ckpt_sfd_test_open_shared(void) {
    void *page =
        mmap(NULL, sizeof(struct ckpt_sfd_test_shared), PROT_READ | PROT_WRITE, MAP_SHARED | MAP_ANONYMOUS, -1, 0);
    if (page == MAP_FAILED) return -1;
    memset(page, 0, sizeof(struct ckpt_sfd_test_shared));
    g_ckpt_sfd_test_shared = page;
    return 0;
}

static void ckpt_sfd_test_close_shared(void) {
    if (g_ckpt_sfd_test_shared) munmap(g_ckpt_sfd_test_shared, sizeof(struct ckpt_sfd_test_shared));
    g_ckpt_sfd_test_shared = NULL;
}

// One queued signalfd record, as the host signal handlers poke it into the self-pipe's write end.
#define CKPT_SFD_TEST_RECORD 128u

static unsigned char ckpt_sfd_test_byte(unsigned index) {
    return (unsigned char)(index * 11u + 5u);
}

static int ckpt_sfd_test_queue(int writer, unsigned records) {
    for (unsigned record = 0; record < records; ++record) {
        unsigned char block[CKPT_SFD_TEST_RECORD];
        for (unsigned index = 0; index < CKPT_SFD_TEST_RECORD; ++index)
            block[index] = ckpt_sfd_test_byte(record * CKPT_SFD_TEST_RECORD + index);
        if (write(writer, block, sizeof block) != (ssize_t)sizeof block) return -1;
    }
    return 0;
}

static int ckpt_sfd_test_nonblocking(int fd) {
    int flags = fcntl(fd, F_GETFL);
    return flags < 0 ? -1 : (flags & O_NONBLOCK) != 0;
}

HL_API int HL_TARGET_LOCAL(checkpoint_signalfd_capture_test)(uint32_t scenario) {
    if (scenario > 3) return 99;
    struct ckpt_sink *saved_sink = ckpt_sink_current();
    int saved_admission = g_ckpt_admission_only;
    int verdict = 0;
    int pair[2] = {-1, -1};
    int alias = -1;

    if (ckpt_sfd_test_open_shared() != 0) return 10;
    if (pipe(pair) != 0) {
        ckpt_sfd_test_close_shared();
        return 11;
    }
    g_ckpt_admission_only = 0; // the drain belongs to pass 2; pass 1 returns before touching anything

    // The guest's signalfd is a BLOCKING descriptor unless the guest asked otherwise, and that is the whole
    // premise of the measurement: assert it before the drain so a fixture that silently started out
    // non-blocking could not report a pass.
    if (scenario == 3) {
        int flags = fcntl(pair[0], F_GETFL);
        if (flags < 0 || fcntl(pair[0], F_SETFL, flags | O_NONBLOCK) != 0) verdict = 12;
        if (verdict == 0 && ckpt_sfd_test_nonblocking(pair[0]) != 1) verdict = 13;
    } else if (ckpt_sfd_test_nonblocking(pair[0]) != 0) {
        verdict = 14;
    }

    // A second descriptor on the SAME open file description: what dup(2) gives a guest and what fork gives
    // every child. If the drain mutates the description, this alias sees it too.
    if (verdict == 0) {
        alias = dup(pair[0]);
        if (alias < 0) verdict = 15;
    }

    unsigned queued = scenario == 2 ? 0u : 2u;
    if (verdict == 0 && ckpt_sfd_test_queue(pair[1], queued) != 0) verdict = 16;
    if (verdict == 0) atomic_store(&g_ckpt_sfd_test_shared->fail_write, scenario == 1 ? 1 : 0);
    ckpt_sink_install(&g_ckpt_sfd_test_ops);

    int captured = verdict == 0 ? ckpt_capture_signalfd(pair[0], 0x51) : -1;

    if (verdict == 0 && scenario == 1) {
        // The abandoned capture: the sink refuses the first byte, so the arm aborts and reports failure.
        // A fixture whose sink stopped refusing would make the rest of this arm meaningless.
        if (captured == 0) verdict = 20;
        if (verdict == 0 && atomic_load(&g_ckpt_sfd_test_shared->length) != 0) verdict = 21;
    } else if (verdict == 0) {
        if (captured != 0) verdict = 22;
    }

    unsigned expected = queued * CKPT_SFD_TEST_RECORD;
    if (verdict == 0 && scenario != 1 && atomic_load(&g_ckpt_sfd_test_shared->length) != expected) verdict = 23;
    for (unsigned index = 0; verdict == 0 && scenario != 1 && index < expected; ++index)
        if (g_ckpt_sfd_test_shared->bytes[index] != ckpt_sfd_test_byte(index)) verdict = 24;

    // THE PROPERTY. The capture -- committed, abandoned, or draining nothing at all -- leaves the open file
    // description's status flags exactly as the guest set them, on the descriptor it drained through AND on
    // every alias of the same description.
    int expected_nonblock = scenario == 3 ? 1 : 0;
    if (verdict == 0 && ckpt_sfd_test_nonblocking(pair[0]) != expected_nonblock) verdict = 30;
    if (verdict == 0 && ckpt_sfd_test_nonblocking(alias) != expected_nonblock) verdict = 31;

    if (alias >= 0) close(alias);
    if (pair[0] >= 0) close(pair[0]);
    if (pair[1] >= 0) close(pair[1]);
    ckpt_sink_install(saved_sink ? saved_sink->ops : NULL);
    g_ckpt_admission_only = saved_admission;
    ckpt_sfd_test_close_shared();
    return verdict;
}
