/* Matrix probe fixture for the TRANSLATED backend.
 *
 * argv[1] = release path (created by the harness between capture and restore)
 * argv[2] = scratch directory
 * argv[3] = shape name
 *
 * Protocol: build the shape, print "READY <shape>", spin until the release path
 * exists, then verify the shape survived and print one "RESULT <shape> ..." line.
 * Exit status is 0 whenever the line was printed, so a shape that comes back
 * WRONG is reported rather than turned into an opaque failure. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/eventfd.h>
#include <sys/file.h>
#include <signal.h>
#include <sys/inotify.h>
#include <sys/signalfd.h>
#include <sys/socket.h>
#include <sys/mman.h>
#include <poll.h>
#include <sys/stat.h>
#include <sys/timerfd.h>
#include <sys/wait.h>
#include <pthread.h>
#include <stdatomic.h>
#include <unistd.h>
#include <sys/syscall.h>
#include <sys/ipc.h>
#include <sys/shm.h>
#include <sys/sem.h>
#include <sys/msg.h>
#include <mqueue.h>
#include <stdint.h>

/* Round-5 shapes: memfd, FIFOs, SysV IPC and POSIX mqueue -- the four kernel
   object families that had neither a checkpoint_linux.rs test nor a matrix
   shape, and were therefore unscored rather than weakly scored.  Same rule as
   the round-3 shapes: the state exists BEFORE the capture and is consumed
   AFTER the restore. */
#ifndef MFD_CLOEXEC
#define MFD_CLOEXEC 0x0001U
#endif
#ifndef MFD_ALLOW_SEALING
#define MFD_ALLOW_SEALING 0x0002U
#endif
#ifndef F_ADD_SEALS
#define F_ADD_SEALS 1033
#endif
#ifndef F_GET_SEALS
#define F_GET_SEALS 1034
#endif
#ifndef F_SEAL_SEAL
#define F_SEAL_SEAL 0x0001
#define F_SEAL_SHRINK 0x0002
#define F_SEAL_GROW 0x0004
#define F_SEAL_WRITE 0x0008
#endif

/* glibc deliberately does not define this; every SysV semaphore user declares
   it itself. */
union matrix_semun {
    int val;
    struct semid_ds *buf;
    unsigned short *array;
};

/* Render captured bytes as a single printable token so a wrong restore shows
   up as a wrong VALUE in the RESULT line rather than as unprintable noise. */
static void token(char *out, size_t room, const void *bytes, size_t count) {
    const unsigned char *raw = (const unsigned char *)bytes;
    size_t used = 0;
    if (count == 0) {
        snprintf(out, room, "-");
        return;
    }
    for (size_t index = 0; index < count && used + 4 < room; index++) {
        if (raw[index] >= 0x20 && raw[index] < 0x7f && raw[index] != ' ')
            out[used++] = (char)raw[index];
        else
            used += (size_t)snprintf(out + used, room - used, "\\x%02x", raw[index]);
    }
    out[used < room ? used : room - 1] = 0;
}

/* Every shape below can in principle block (an empty FIFO, a mqueue receive, a
   semop).  Round 3's R4.2.1 records what that costs: the runner scores a
   missing RESULT as a refusal, so a hung arm reads as the SAFE verdict.  Each
   blocking call is therefore bounded and reports its own EINTR instead. */
static void pipe_nonblock_wake(int signo);
static void bound(unsigned seconds) {
    struct sigaction wake;
    memset(&wake, 0, sizeof wake);
    wake.sa_handler = pipe_nonblock_wake;
    (void)sigaction(SIGALRM, &wake, NULL);
    alarm(seconds);
}

static char g_line[1024];
static void pipe_nonblock_wake(int signo) { (void)signo; }
/* Non-vacuity bracket: a value chosen ONCE per process image.  A genuine
   restore resumes this very process, so the RESULT line carries the same seed
   the SEEDED line announced before the capture, and the report holds exactly
   one SEEDED line.  A "restore" that merely re-executed the guest from main()
   would print a SECOND SEEDED line with a DIFFERENT value -- which is what
   would make every WORKS verdict in this probe meaningless. */
static unsigned long long g_seed;
/* Poison mode: build the shape WITHOUT its pre-capture kernel-side state, so
   the very same RESULT line reports what "the state is absent" looks like.  A
   shape whose poisoned control reports the SAME line as its armed control is a
   shape this probe cannot score, and its WORKS verdict would be worthless. */
static int g_poison;

static void say(const char *text) { (void)write(STDOUT_FILENO, text, strlen(text)); }

static void emit(void) {
    char stamp[64];
    snprintf(stamp, sizeof stamp, "SEED %llu\n", g_seed);
    (void)write(STDOUT_FILENO, stamp, strlen(stamp));
    (void)write(STDOUT_FILENO, g_line, strlen(g_line));
}

static void park(const char *release) {
    while (access(release, F_OK) != 0) usleep(2000);
}

/* Returns 1 when another process can take an exclusive flock on `path`, i.e.
   when THIS process is no longer holding one. */
static int lock_is_free(const char *path, int posix_style) {
    pid_t child = fork();
    if (child < 0) return -1;
    if (child == 0) {
        int fd = open(path, O_RDWR);
        if (fd < 0) _exit(2);
        int free_now;
        if (posix_style) {
            struct flock probe;
            memset(&probe, 0, sizeof probe);
            probe.l_type = F_WRLCK;
            probe.l_whence = SEEK_SET;
            free_now = fcntl(fd, F_SETLK, &probe) == 0;
        } else {
            free_now = flock(fd, LOCK_EX | LOCK_NB) == 0;
        }
        _exit(free_now ? 1 : 0);
    }
    int status = 0;
    if (waitpid(child, &status, 0) != child || !WIFEXITED(status)) return -1;
    return WEXITSTATUS(status) == 2 ? -1 : WEXITSTATUS(status);
}


static __thread int t_slot;
static _Atomic int g_threads_ready;
static _Atomic int g_threads_ok;
static _Atomic int g_threads_bad;
static const char *g_release;

static void *matrix_thread(void *opaque) {
    t_slot = (int)(long)opaque;
    atomic_fetch_add_explicit(&g_threads_ready, 1, memory_order_release);
    park(g_release);
    if (t_slot == (int)(long)opaque)
        atomic_fetch_add_explicit(&g_threads_ok, 1, memory_order_release);
    else
        atomic_fetch_add_explicit(&g_threads_bad, 1, memory_order_release);
    return NULL;
}

static _Atomic int g_pending_ready;
static _Atomic int g_pending_masked;
static _Atomic int g_pending_still;

static void *pending_thread(void *unused) {
    (void)unused;
    sigset_t block, observed, queued;
    sigemptyset(&block);
    sigaddset(&block, SIGUSR2);
    if (pthread_sigmask(SIG_BLOCK, &block, NULL) != 0 || pthread_kill(pthread_self(), SIGUSR2) != 0) return NULL;
    atomic_store_explicit(&g_pending_ready, 1, memory_order_release);
    park(g_release);
    sigemptyset(&observed);
    sigemptyset(&queued);
    (void)pthread_sigmask(SIG_BLOCK, NULL, &observed);
    (void)sigpending(&queued);
    atomic_store_explicit(&g_pending_masked, sigismember(&observed, SIGUSR2), memory_order_release);
    atomic_store_explicit(&g_pending_still, sigismember(&queued, SIGUSR2), memory_order_release);
    return NULL;
}

int main(int argc, char **argv) {
    if (argc < 4) return 80;
    const char *release = argv[1];
    const char *scratch = argv[2];
    const char *shape = argv[3];
    g_poison = argc > 4 && !strcmp(argv[4], "poison");
    char path[512];

    /* Route stdout to <release>.output, exactly as the established tree fixture
       does: a path-backed regular file is the descriptor shape the restore
       reopens by path, so the report survives the re-fork. */
    char redirect[1024];
    if (snprintf(redirect, sizeof redirect, "%s.output", release) >= (int)sizeof redirect) return 78;
    int sink = open(redirect, O_WRONLY | O_CREAT | O_APPEND, 0600);
    if (sink < 0 || dup2(sink, STDOUT_FILENO) != STDOUT_FILENO) return 77;
    if (sink != STDOUT_FILENO) close(sink);

    {
        int entropy = open("/dev/urandom", O_RDONLY);
        if (entropy < 0 || read(entropy, &g_seed, sizeof g_seed) != (ssize_t)sizeof g_seed) return 76;
        close(entropy);
        char stamp[64];
        snprintf(stamp, sizeof stamp, "SEEDED %llu\n", g_seed);
        say(stamp);
    }

    if (!strcmp(shape, "eventfd")) {
        int fd = eventfd(0, EFD_CLOEXEC | EFD_NONBLOCK);
        uint64_t seed = 42;
        if (fd < 0) return 81;
        if (!g_poison && write(fd, &seed, sizeof seed) != (ssize_t)sizeof seed) return 81;
        say("READY eventfd\n");
        park(release);
        uint64_t observed = 0;
        ssize_t got = read(fd, &observed, sizeof observed);
        snprintf(g_line, sizeof g_line, "RESULT eventfd read=%zd counter=%llu expected=42\n", got,
                 (unsigned long long)observed);
        emit();
        return 0;
    }

    if (!strcmp(shape, "timerfd")) {
        int fd = timerfd_create(CLOCK_MONOTONIC, TFD_CLOEXEC | TFD_NONBLOCK);
        struct itimerspec arm;
        memset(&arm, 0, sizeof arm);
        arm.it_value.tv_sec = 3600;
        if (fd < 0) return 82;
        if (!g_poison && timerfd_settime(fd, 0, &arm, NULL) != 0) return 82;
        say("READY timerfd\n");
        park(release);
        struct itimerspec remaining;
        memset(&remaining, 0, sizeof remaining);
        int result = timerfd_gettime(fd, &remaining);
        snprintf(g_line, sizeof g_line, "RESULT timerfd rc=%d remaining_s=%lld armed=%d expected_armed=1\n", result,
                 (long long)remaining.it_value.tv_sec, remaining.it_value.tv_sec != 0 || remaining.it_value.tv_nsec != 0);
        emit();
        return 0;
    }

    if (!strcmp(shape, "epoll")) {
        int pipes[2];
        if (pipe(pipes) != 0) return 83;
        int poller = epoll_create1(EPOLL_CLOEXEC);
        struct epoll_event interest;
        memset(&interest, 0, sizeof interest);
        interest.events = EPOLLIN;
        interest.data.u32 = 0xfeed;
        if (poller < 0 || epoll_ctl(poller, EPOLL_CTL_ADD, pipes[0], &interest) != 0) return 84;
        say("READY epoll\n");
        park(release);
        if (write(pipes[1], "x", 1) != 1) {
            snprintf(g_line, sizeof g_line, "RESULT epoll write_failed errno=%d\n", errno);
            emit();
            return 0;
        }
        struct epoll_event seen[4];
        memset(seen, 0, sizeof seen);
        int count = epoll_wait(poller, seen, 4, 2000);
        snprintf(g_line, sizeof g_line, "RESULT epoll count=%d token=%#x expected_count=1 expected_token=0xfeed\n",
                 count, count > 0 ? seen[0].data.u32 : 0);
        emit();
        return 0;
    }

    if (!strcmp(shape, "inotify")) {
        int instance = inotify_init1(IN_CLOEXEC | IN_NONBLOCK);
        int watch = instance < 0 ? -1 : inotify_add_watch(instance, scratch, IN_CREATE);
        if (watch < 0) return 85;
        say("READY inotify\n");
        park(release);
        snprintf(path, sizeof path, "%s/inotify-probe", scratch);
        int made = open(path, O_CREAT | O_WRONLY, 0600);
        if (made >= 0) close(made);
        char buffer[4096];
        ssize_t got = -1;
        for (int attempt = 0; attempt < 500 && got < 0; attempt++) {
            got = read(instance, buffer, sizeof buffer);
            if (got < 0) usleep(2000);
        }
        int matched = 0;
        if (got > 0) {
            struct inotify_event *event = (struct inotify_event *)buffer;
            matched = event->wd == watch && (event->mask & IN_CREATE) != 0;
        }
        snprintf(g_line, sizeof g_line, "RESULT inotify read=%zd matched=%d expected_matched=1\n", got, matched);
        emit();
        return 0;
    }

    if (!strcmp(shape, "flock") || !strcmp(shape, "posixlock")) {
        int posix_style = !strcmp(shape, "posixlock");
        snprintf(path, sizeof path, "%s/lockfile", scratch);
        int fd = open(path, O_RDWR | O_CREAT, 0600);
        if (fd < 0) return 86;
        if (posix_style) {
            struct flock held;
            memset(&held, 0, sizeof held);
            held.l_type = F_WRLCK;
            held.l_whence = SEEK_SET;
            if (!g_poison && fcntl(fd, F_SETLK, &held) != 0) return 87;
        } else if (!g_poison && flock(fd, LOCK_EX | LOCK_NB) != 0) {
            return 88;
        }
        int before = lock_is_free(path, posix_style);
        say(posix_style ? "READY posixlock\n" : "READY flock\n");
        park(release);
        int after = lock_is_free(path, posix_style);
        snprintf(g_line, sizeof g_line,
                 "RESULT %s free_before=%d free_after=%d expected_before=0 expected_after=0\n", shape, before, after);
        emit();
        return 0;
    }

    if (!strcmp(shape, "anonexec")) {
#if defined(__x86_64__)
        static const unsigned char code[] = {0xb8, 0x5a, 0x00, 0x00, 0x00, 0xc3};
#elif defined(__aarch64__)
        static const unsigned char code[] = {0x40, 0x0b, 0x80, 0x52, 0xc0, 0x03, 0x5f, 0xd6};
#else
#error "unsupported probe architecture"
#endif
        void *page = mmap(NULL, 4096, PROT_READ | PROT_WRITE | PROT_EXEC, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
        if (page == MAP_FAILED) return 89;
        memcpy(page, code, sizeof code);
        __builtin___clear_cache((char *)page, (char *)page + sizeof code);
        int (*call)(void) = (int (*)(void))page;
        int before = call();
        say("READY anonexec\n");
        park(release);
        int after = call();
        snprintf(g_line, sizeof g_line, "RESULT anonexec before=%d after=%d expected=90\n", before, after);
        emit();
        return 0;
    }

    if (!strcmp(shape, "anonexec-rewrite")) {
#if defined(__x86_64__)
        static const unsigned char first[] = {0xb8, 0x5a, 0x00, 0x00, 0x00, 0xc3};
        static const unsigned char second[] = {0xb8, 0x5b, 0x00, 0x00, 0x00, 0xc3};
#elif defined(__aarch64__)
        static const unsigned char first[] = {0x40, 0x0b, 0x80, 0x52, 0xc0, 0x03, 0x5f, 0xd6};
        static const unsigned char second[] = {0x60, 0x0b, 0x80, 0x52, 0xc0, 0x03, 0x5f, 0xd6};
#endif
        void *page = mmap(NULL, 4096, PROT_READ | PROT_WRITE | PROT_EXEC, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
        if (page == MAP_FAILED) return 89;
        memcpy(page, first, sizeof first);
        __builtin___clear_cache((char *)page, (char *)page + sizeof first);
        int (*call)(void) = (int (*)(void))page;
        int before = call();
        say("READY anonexec-rewrite\n");
        park(release);
        memcpy(page, second, sizeof second);
        __builtin___clear_cache((char *)page, (char *)page + sizeof second);
        int after = call();
        snprintf(g_line, sizeof g_line, "RESULT anonexec-rewrite before=%d after=%d expected_before=90 expected_after=91\n",
                 before, after);
        emit();
        return 0;
    }

    if (!strcmp(shape, "cwd")) {
        if (chdir(scratch) != 0) return 90;
        say("READY cwd\n");
        park(release);
        char here[512];
        if (getcwd(here, sizeof here) == NULL) strcpy(here, "?");
        snprintf(g_line, sizeof g_line, "RESULT cwd here=%s expected=%s\n", here, scratch);
        emit();
        return 0;
    }

    if (!strcmp(shape, "offset")) {
        snprintf(path, sizeof path, "%s/offsetfile", scratch);
        int fd = open(path, O_RDWR | O_CREAT | O_TRUNC, 0600);
        if (fd < 0 || write(fd, "0123456789", 10) != 10) return 91;
        if (lseek(fd, 4, SEEK_SET) != 4) return 92;
        say("READY offset\n");
        park(release);
        off_t where = lseek(fd, 0, SEEK_CUR);
        char byte = 0;
        ssize_t got = read(fd, &byte, 1);
        snprintf(g_line, sizeof g_line, "RESULT offset where=%lld byte=%c got=%zd expected_where=4 expected_byte=4\n",
                 (long long)where, got == 1 ? byte : '?', got);
        emit();
        return 0;
    }

    if (!strcmp(shape, "child")) {
        pid_t child = fork();
        if (child < 0) return 93;
        if (child == 0) {
            park(release);
            _exit(37);
        }
        say("READY child\n");
        park(release);
        int status = 0;
        pid_t reaped = waitpid(child, &status, 0);
        snprintf(g_line, sizeof g_line, "RESULT child reaped=%d same_pid=%d code=%d expected_code=37\n", (int)reaped,
                 reaped == child, WIFEXITED(status) ? WEXITSTATUS(status) : -1);
        emit();
        return 0;
    }

    if (!strcmp(shape, "pending") || !strcmp(shape, "pending-thread")) {
        int on_thread = !strcmp(shape, "pending-thread");
        g_release = release;
        pthread_t worker;
        if (on_thread) {
            if (pthread_create(&worker, NULL, pending_thread, NULL) != 0) return 96;
            while (atomic_load_explicit(&g_pending_ready, memory_order_acquire) == 0) usleep(2000);
        } else {
            sigset_t block;
            sigemptyset(&block);
            sigaddset(&block, SIGUSR2);
            if (sigprocmask(SIG_BLOCK, &block, NULL) != 0) return 97;
            if (raise(SIGUSR2) != 0) return 98;
        }
        say(on_thread ? "READY pending-thread\n" : "READY pending\n");
        park(release);
        int masked, pending_now;
        if (on_thread) {
            if (pthread_join(worker, NULL) != 0) return 99;
            masked = atomic_load_explicit(&g_pending_masked, memory_order_acquire);
            pending_now = atomic_load_explicit(&g_pending_still, memory_order_acquire);
        } else {
            sigset_t observed, queued;
            sigemptyset(&observed);
            sigemptyset(&queued);
            (void)sigprocmask(SIG_BLOCK, NULL, &observed);
            (void)sigpending(&queued);
            masked = sigismember(&observed, SIGUSR2);
            pending_now = sigismember(&queued, SIGUSR2);
        }
        snprintf(g_line, sizeof g_line, "RESULT %s masked=%d pending=%d expected_masked=1 expected_pending=1\n",
                 shape, masked, pending_now);
        emit();
        return 0;
    }

    if (!strcmp(shape, "pending-child")) {
        int ready[2];
        if (pipe(ready) != 0) return 70;
        pid_t child = fork();
        if (child < 0) return 71;
        if (child == 0) {
            close(ready[0]);
            sigset_t block, observed, queued;
            sigemptyset(&block);
            sigaddset(&block, SIGUSR2);
            if (sigprocmask(SIG_BLOCK, &block, NULL) != 0 || raise(SIGUSR2) != 0) _exit(9);
            (void)write(ready[1], "r", 1);
            close(ready[1]);
            park(release);
            sigemptyset(&observed);
            sigemptyset(&queued);
            (void)sigprocmask(SIG_BLOCK, NULL, &observed);
            (void)sigpending(&queued);
            _exit(sigismember(&observed, SIGUSR2) * 2 + sigismember(&queued, SIGUSR2));
        }
        close(ready[1]);
        char token;
        if (read(ready[0], &token, 1) != 1) return 72;
        close(ready[0]);
        say("READY pending-child\n");
        park(release);
        int status = 0;
        pid_t reaped = waitpid(child, &status, 0);
        int code = WIFEXITED(status) ? WEXITSTATUS(status) : -1;
        snprintf(g_line, sizeof g_line,
                 "RESULT pending-child reaped=%d masked=%d pending=%d expected_masked=1 expected_pending=1\n",
                 reaped == child, code >= 0 ? code / 2 : -1, code >= 0 ? code % 2 : -1);
        emit();
        return 0;
    }

    if (!strcmp(shape, "threads")) {
        g_release = release;
        pthread_t workers[3];
        for (long index = 0; index < 3; index++)
            if (pthread_create(&workers[index], NULL, matrix_thread, (void *)(index + 1)) != 0) return 94;
        while (atomic_load_explicit(&g_threads_ready, memory_order_acquire) < 3) usleep(2000);
        say("READY threads\n");
        park(release);
        for (long index = 0; index < 3; index++)
            if (pthread_join(workers[index], NULL) != 0) return 95;
        snprintf(g_line, sizeof g_line, "RESULT threads tls_ok=%d tls_bad=%d expected_ok=3 expected_bad=0\n",
                 atomic_load_explicit(&g_threads_ok, memory_order_acquire),
                 atomic_load_explicit(&g_threads_bad, memory_order_acquire));
        emit();
        return 0;
    }

    if (!strcmp(shape, "plain")) {
        volatile unsigned long accumulator = 0;
        for (unsigned long index = 0; index < 100000; index++) accumulator += index;
        say("READY plain\n");
        park(release);
        snprintf(g_line, sizeof g_line, "RESULT plain accumulator=%lu expected=4999950000\n",
                 (unsigned long)accumulator);
        emit();
        return 0;
    }


    /* ---- Round-3 shapes: kernel-side QUEUED / READY state that exists BEFORE
       the capture.  The round-1 shapes registered interest before the capture
       but generated the event AFTER the restore, which cannot tell a dropped
       queue from a live one.  These do the opposite. */

    if (!strcmp(shape, "pipe-buffered")) {
        int pipes[2];
        if (pipe(pipes) != 0) return 60;
        if (!g_poison && write(pipes[1], "ABCDEFGH", 8) != 8) return 61;
        say("READY pipe-buffered\n");
        park(release);
        char buffer[16];
        memset(buffer, 0, sizeof buffer);
        struct pollfd ready = {pipes[0], POLLIN, 0};
        int polled = poll(&ready, 1, 2000);
        ssize_t got = polled > 0 ? read(pipes[0], buffer, 8) : -1;
        snprintf(g_line, sizeof g_line,
                 "RESULT pipe-buffered polled=%d got=%zd data=%s expected_got=8 expected_data=ABCDEFGH\n",
                 polled, got, got > 0 ? buffer : "-");
        emit();
        return 0;
    }

    if (!strcmp(shape, "sockpair-buffered")) {
        int pair[2];
        if (socketpair(AF_UNIX, SOCK_STREAM, 0, pair) != 0) return 62;
        if (!g_poison && write(pair[1], "ABCDEFGH", 8) != 8) return 63;
        say("READY sockpair-buffered\n");
        park(release);
        char buffer[16];
        memset(buffer, 0, sizeof buffer);
        struct pollfd ready = {pair[0], POLLIN, 0};
        int polled = poll(&ready, 1, 2000);
        ssize_t got = polled > 0 ? read(pair[0], buffer, 8) : -1;
        snprintf(g_line, sizeof g_line,
                 "RESULT sockpair-buffered polled=%d got=%zd data=%s expected_got=8 expected_data=ABCDEFGH\n",
                 polled, got, got > 0 ? buffer : "-");
        emit();
        return 0;
    }

    if (!strcmp(shape, "sockpair-live")) {
        /* No queued data: the socketpair is merely OPEN across the capture and
           is used AFTER the restore.  Separates "the queue was dropped" from
           "the pair itself did not survive". */
        int pair[2];
        if (socketpair(AF_UNIX, SOCK_STREAM, 0, pair) != 0) return 64;
        say("READY sockpair-live\n");
        park(release);
        ssize_t put = write(pair[1], "IJKLMNOP", 8);
        char buffer[16];
        memset(buffer, 0, sizeof buffer);
        ssize_t got = put == 8 ? read(pair[0], buffer, 8) : -1;
        snprintf(g_line, sizeof g_line,
                 "RESULT sockpair-live put=%zd got=%zd data=%s expected_got=8 expected_data=IJKLMNOP\n",
                 put, got, got > 0 ? buffer : "-");
        emit();
        return 0;
    }

    if (!strcmp(shape, "sockpair-dgram")) {
        int pair[2];
        if (socketpair(AF_UNIX, SOCK_DGRAM, 0, pair) != 0) return 65;
        if (!g_poison && (write(pair[1], "AAA", 3) != 3 || write(pair[1], "BBBB", 4) != 4)) return 66;
        say("READY sockpair-dgram\n");
        park(release);
        char first[16], second[16];
        memset(first, 0, sizeof first);
        memset(second, 0, sizeof second);
        struct pollfd ready = {pair[0], POLLIN, 0};
        int polled = poll(&ready, 1, 2000);
        ssize_t a = polled > 0 ? read(pair[0], first, sizeof first) : -1;
        ssize_t b = a > 0 ? read(pair[0], second, sizeof second) : -1;
        snprintf(g_line, sizeof g_line,
                 "RESULT sockpair-dgram a=%zd b=%zd first=%s second=%s expected_a=3 expected_b=4\n",
                 a, b, a > 0 ? first : "-", b > 0 ? second : "-");
        emit();
        return 0;
    }

    if (!strcmp(shape, "epoll-ready")) {
        int pipes[2];
        if (pipe(pipes) != 0) return 67;
        int poller = epoll_create1(EPOLL_CLOEXEC);
        struct epoll_event interest;
        memset(&interest, 0, sizeof interest);
        interest.events = EPOLLIN;
        interest.data.u32 = 0xbeef;
        if (poller < 0 || epoll_ctl(poller, EPOLL_CTL_ADD, pipes[0], &interest) != 0) return 68;
        /* readiness exists BEFORE the capture and is never consumed */
        if (!g_poison && write(pipes[1], "z", 1) != 1) return 69;
        struct epoll_event pre[4];
        memset(pre, 0, sizeof pre);
        int before = epoll_wait(poller, pre, 4, 0);
        say("READY epoll-ready\n");
        park(release);
        struct epoll_event seen[4];
        memset(seen, 0, sizeof seen);
        int count = epoll_wait(poller, seen, 4, 2000);
        snprintf(g_line, sizeof g_line,
                 "RESULT epoll-ready before=%d count=%d token=%#x expected_before=1 expected_count=1 expected_token=0xbeef\n",
                 before, count, count > 0 ? seen[0].data.u32 : 0);
        emit();
        return 0;
    }

    if (!strcmp(shape, "inotify-queued")) {
        int instance = inotify_init1(IN_CLOEXEC | IN_NONBLOCK);
        int watch = instance < 0 ? -1 : inotify_add_watch(instance, scratch, IN_CREATE);
        if (watch < 0) return 55;
        snprintf(path, sizeof path, "%s/queued-probe", scratch);
        if (!g_poison) {
            int made = open(path, O_CREAT | O_WRONLY, 0600);
            if (made < 0) return 56;
            close(made);
        }
        usleep(50000); /* let the event reach the queue before the capture */
        say("READY inotify-queued\n");
        park(release);
        char buffer[4096];
        ssize_t got = -1;
        for (int attempt = 0; attempt < 250 && got < 0; attempt++) {
            got = read(instance, buffer, sizeof buffer);
            if (got < 0) usleep(2000);
        }
        int matched = 0;
        if (got > 0) {
            struct inotify_event *event = (struct inotify_event *)buffer;
            matched = event->wd == watch && (event->mask & IN_CREATE) != 0;
        }
        snprintf(g_line, sizeof g_line, "RESULT inotify-queued read=%zd matched=%d expected_matched=1\n", got, matched);
        emit();
        return 0;
    }

    if (!strcmp(shape, "timerfd-expired")) {
        int fd = timerfd_create(CLOCK_MONOTONIC, TFD_CLOEXEC | TFD_NONBLOCK);
        struct itimerspec arm;
        memset(&arm, 0, sizeof arm);
        arm.it_value.tv_nsec = 2000000; /* 2 ms: expires long before the capture */
        if (fd < 0) return 57;
        if (!g_poison && timerfd_settime(fd, 0, &arm, NULL) != 0) return 57;
        usleep(200000);
        say("READY timerfd-expired\n");
        park(release);
        uint64_t ticks = 0;
        struct pollfd ready = {fd, POLLIN, 0};
        int polled = poll(&ready, 1, 2000);
        ssize_t got = polled > 0 ? read(fd, &ticks, sizeof ticks) : -1;
        snprintf(g_line, sizeof g_line,
                 "RESULT timerfd-expired polled=%d got=%zd ticks=%llu expected_ticks=1\n",
                 polled, got, (unsigned long long)ticks);
        emit();
        return 0;
    }

    if (!strcmp(shape, "timerfd-remaining")) {
        /* The round-1 timerfd shape accepted ANY non-zero remaining value, so a
           restore that re-armed the timer from scratch would have passed.  This
           one requires the remaining value to be in the window a surviving
           timer must be in and outside the one a re-armed timer lands in. */
        int fd = timerfd_create(CLOCK_MONOTONIC, TFD_CLOEXEC | TFD_NONBLOCK);
        struct itimerspec arm;
        memset(&arm, 0, sizeof arm);
        arm.it_value.tv_sec = 100;
        if (fd < 0) return 58;
        if (!g_poison && timerfd_settime(fd, 0, &arm, NULL) != 0) return 58;
        usleep(400000);
        say("READY timerfd-remaining\n");
        park(release);
        struct itimerspec remaining;
        memset(&remaining, 0, sizeof remaining);
        int result = timerfd_gettime(fd, &remaining);
        long long left = (long long)remaining.it_value.tv_sec;
        /* a surviving timer has burned some of its 100 s; a re-armed one reads
           exactly 99 or 100 with nsec near the full second */
        long long total_ns = left * 1000000000LL + (long long)remaining.it_value.tv_nsec;
        /* a re-armed 100 s timer reads ~100e9; a surviving one has burned the
           park interval and reads under 99.9e9 */
        int sane = result == 0 && total_ns > 0 && total_ns <= 99900000000LL;
        snprintf(g_line, sizeof g_line,
                 "RESULT timerfd-remaining rc=%d left_s=%lld left_ns=%ld sane=%d expected_sane=1\n",
                 result, left, (long)remaining.it_value.tv_nsec, sane);
        emit();
        return 0;
    }

    if (!strcmp(shape, "signalfd-queued")) {
        sigset_t block;
        sigemptyset(&block);
        sigaddset(&block, SIGUSR2);
        if (sigprocmask(SIG_BLOCK, &block, NULL) != 0) return 51;
        int fd = signalfd(-1, &block, SFD_CLOEXEC | SFD_NONBLOCK);
        if (fd < 0) return 52;
        if (!g_poison && raise(SIGUSR2) != 0) return 53;
        int flags_before = fcntl(fd, F_GETFL);
        say("READY signalfd-queued\n");
        park(release);
        struct signalfd_siginfo info;
        memset(&info, 0, sizeof info);
        struct pollfd ready = {fd, POLLIN, 0};
        int polled = poll(&ready, 1, 2000);
        ssize_t got = polled > 0 ? read(fd, &info, sizeof info) : -1;
        int flags_after = fcntl(fd, F_GETFL);
        snprintf(g_line, sizeof g_line,
                 "RESULT signalfd-queued polled=%d got=%zd signo=%d nonblock_before=%d nonblock_after=%d "
                 "expected_signo=%d expected_nonblock=1\n",
                 polled, got, got > 0 ? (int)info.ssi_signo : -1,
                 flags_before >= 0 && (flags_before & O_NONBLOCK) ? 1 : 0,
                 flags_after >= 0 && (flags_after & O_NONBLOCK) ? 1 : 0, SIGUSR2);
        emit();
        return 0;
    }

    if (!strcmp(shape, "signalfd-blocking")) {
        /* The D4.2 defect in the guest's own terms: a signalfd the guest left
           BLOCKING must still be blocking after a capture drained it. */
        sigset_t block;
        sigemptyset(&block);
        sigaddset(&block, SIGUSR2);
        if (sigprocmask(SIG_BLOCK, &block, NULL) != 0) return 54;
        int fd = signalfd(-1, &block, SFD_CLOEXEC);
        if (fd < 0) return 59;
        if (raise(SIGUSR2) != 0) return 50;
        say("READY signalfd-blocking\n");
        park(release);
        int flags = fcntl(fd, F_GETFL);
        snprintf(g_line, sizeof g_line,
                 "RESULT signalfd-blocking flags_rc=%d nonblock=%d expected_nonblock=0\n",
                 flags, flags >= 0 && (flags & O_NONBLOCK) ? 1 : 0);
        emit();
        return 0;
    }


    /* ---- Round-3 batch 2: fidelity a "the object came back" check cannot see. */

    if (!strcmp(shape, "cloexec")) {
        /* FD_CLOEXEC is per-descriptor, not per-description, and it decides
           whether a descriptor leaks through the guest's next exec. */
        int efd = eventfd(0, EFD_CLOEXEC);
        int tfd = timerfd_create(CLOCK_MONOTONIC, TFD_CLOEXEC);
        int ifd = inotify_init1(IN_CLOEXEC);
        int pfd = epoll_create1(EPOLL_CLOEXEC);
        int pipes[2];
        int pair[2];
        if (efd < 0 || tfd < 0 || ifd < 0 || pfd < 0) return 40;
        if (pipe2(pipes, O_CLOEXEC) != 0 || socketpair(AF_UNIX, SOCK_STREAM, 0, pair) != 0) return 41;
        if (fcntl(pair[0], F_SETFD, FD_CLOEXEC) != 0) return 42;
        if (g_poison) {
            /* clear them all: this is what "the flag was dropped" reports */
            (void)fcntl(efd, F_SETFD, 0);
            (void)fcntl(tfd, F_SETFD, 0);
            (void)fcntl(ifd, F_SETFD, 0);
            (void)fcntl(pfd, F_SETFD, 0);
            (void)fcntl(pipes[0], F_SETFD, 0);
            (void)fcntl(pair[0], F_SETFD, 0);
        }
        say("READY cloexec\n");
        park(release);
        int e = fcntl(efd, F_GETFD), t = fcntl(tfd, F_GETFD), i = fcntl(ifd, F_GETFD);
        int p = fcntl(pfd, F_GETFD), q = fcntl(pipes[0], F_GETFD), u = fcntl(pair[0], F_GETFD);
        snprintf(g_line, sizeof g_line,
                 "RESULT cloexec eventfd=%d timerfd=%d inotify=%d epoll=%d pipe=%d sockpair=%d "
                 "expected_eventfd=1 expected_timerfd=1 expected_inotify=1 expected_epoll=1 "
                 "expected_pipe=1 expected_sockpair=1\n",
                 e >= 0 && (e & FD_CLOEXEC) ? 1 : 0, t >= 0 && (t & FD_CLOEXEC) ? 1 : 0,
                 i >= 0 && (i & FD_CLOEXEC) ? 1 : 0, p >= 0 && (p & FD_CLOEXEC) ? 1 : 0,
                 q >= 0 && (q & FD_CLOEXEC) ? 1 : 0, u >= 0 && (u & FD_CLOEXEC) ? 1 : 0);
        emit();
        return 0;
    }

    if (!strcmp(shape, "timerfd-interval")) {
        int fd = timerfd_create(CLOCK_MONOTONIC, TFD_CLOEXEC | TFD_NONBLOCK);
        struct itimerspec arm;
        memset(&arm, 0, sizeof arm);
        arm.it_value.tv_sec = 50;
        arm.it_interval.tv_sec = 7;
        if (fd < 0) return 43;
        if (!g_poison && timerfd_settime(fd, 0, &arm, NULL) != 0) return 43;
        say("READY timerfd-interval\n");
        park(release);
        struct itimerspec observed;
        memset(&observed, 0, sizeof observed);
        int result = timerfd_gettime(fd, &observed);
        snprintf(g_line, sizeof g_line,
                 "RESULT timerfd-interval rc=%d interval_s=%lld armed=%d expected_interval_s=7 expected_armed=1\n",
                 result, (long long)observed.it_interval.tv_sec,
                 observed.it_value.tv_sec != 0 || observed.it_value.tv_nsec != 0);
        emit();
        return 0;
    }

    if (!strcmp(shape, "eventfd-sema")) {
        /* EFD_SEMAPHORE changes what read() returns for the SAME counter, so a
           restore that keeps the count but loses the flag is silently wrong. */
        int fd = g_poison ? eventfd(0, EFD_CLOEXEC | EFD_NONBLOCK)
                          : eventfd(0, EFD_CLOEXEC | EFD_NONBLOCK | EFD_SEMAPHORE);
        uint64_t seed = 3;
        if (fd < 0 || write(fd, &seed, sizeof seed) != (ssize_t)sizeof seed) return 44;
        say("READY eventfd-sema\n");
        park(release);
        uint64_t first = 0, second = 0;
        ssize_t a = read(fd, &first, sizeof first);
        ssize_t b = read(fd, &second, sizeof second);
        snprintf(g_line, sizeof g_line,
                 "RESULT eventfd-sema a=%zd first=%llu b=%zd second=%llu expected_first=1 expected_second=1\n",
                 a, (unsigned long long)first, b, (unsigned long long)second);
        emit();
        return 0;
    }

    if (!strcmp(shape, "epoll-oneshot")) {
        /* EPOLLONESHOT disarms the interest once reported.  The data stays
           readable, so a restore that rebuilt the interest list from the
           descriptor set rather than from its captured ARMED state will report
           the event a second time. */
        int pipes[2];
        if (pipe(pipes) != 0) return 45;
        int poller = epoll_create1(EPOLL_CLOEXEC);
        struct epoll_event interest;
        memset(&interest, 0, sizeof interest);
        interest.events = EPOLLIN | EPOLLONESHOT;
        interest.data.u32 = 0xcafe;
        if (poller < 0 || epoll_ctl(poller, EPOLL_CTL_ADD, pipes[0], &interest) != 0) return 46;
        if (write(pipes[1], "y", 1) != 1) return 47;
        struct epoll_event pre[4];
        memset(pre, 0, sizeof pre);
        int before = epoll_wait(poller, pre, 4, 1000); /* consumes the one shot */
        if (g_poison) {
            /* re-arm: this is exactly what "the one-shot disarm was lost" looks like */
            (void)epoll_ctl(poller, EPOLL_CTL_MOD, pipes[0], &interest);
        }
        say("READY epoll-oneshot\n");
        park(release);
        struct epoll_event seen[4];
        memset(seen, 0, sizeof seen);
        int after = epoll_wait(poller, seen, 4, 200);
        snprintf(g_line, sizeof g_line,
                 "RESULT epoll-oneshot before=%d after=%d expected_before=1 expected_after=0\n", before, after);
        emit();
        return 0;
    }

    if (!strcmp(shape, "sockpair-shutdown")) {
        int pair[2];
        if (socketpair(AF_UNIX, SOCK_STREAM, 0, pair) != 0) return 48;
        if (!g_poison && shutdown(pair[1], SHUT_WR) != 0) return 49;
        say("READY sockpair-shutdown\n");
        park(release);
        char buffer[8];
        struct pollfd ready = {pair[0], POLLIN, 0};
        int polled = poll(&ready, 1, 2000);
        ssize_t got = polled > 0 ? read(pair[0], buffer, sizeof buffer) : -2;
        snprintf(g_line, sizeof g_line,
                 "RESULT sockpair-shutdown polled=%d eof=%d expected_polled=1 expected_eof=1\n",
                 polled, got == 0 ? 1 : 0);
        emit();
        return 0;
    }

    if (!strcmp(shape, "pipe-nonblock")) {
        int pipes[2];
        if (pipe(pipes) != 0) return 38;
        if (!g_poison && fcntl(pipes[0], F_SETFL, O_NONBLOCK) != 0) return 39;
        say("READY pipe-nonblock\n");
        park(release);
        char byte = 0;
        /* A pipe that came back BLOCKING would hang here forever, which reads
           as a harness timeout rather than as a verdict; the alarm turns it
           into a reportable EINTR instead. */
        struct sigaction wake;
        memset(&wake, 0, sizeof wake);
        wake.sa_handler = pipe_nonblock_wake;
        (void)sigaction(SIGALRM, &wake, NULL);
        alarm(3);
        ssize_t got = read(pipes[0], &byte, 1); /* must NOT block: the pipe is empty */
        alarm(0);
        int flags = fcntl(pipes[0], F_GETFL);
        snprintf(g_line, sizeof g_line,
                 "RESULT pipe-nonblock got=%zd err=%d nonblock=%d expected_got=-1 expected_nonblock=1\n",
                 got, got < 0 ? errno : 0, flags >= 0 && (flags & O_NONBLOCK) ? 1 : 0);
        emit();
        return 0;
    }

    if (!strcmp(shape, "inotify-multi")) {
        /* Watch-descriptor identity across three watches: the guest indexes its
           own bookkeeping by wd, so a restore that renumbers them is silently
           wrong even when every event still arrives. */
        char a[512], b[512], c[512];
        snprintf(a, sizeof a, "%s/wa", scratch);
        snprintf(b, sizeof b, "%s/wb", scratch);
        snprintf(c, sizeof c, "%s/wc", scratch);
        if (mkdir(a, 0700) != 0 || mkdir(b, 0700) != 0 || mkdir(c, 0700) != 0) return 36;
        int instance = inotify_init1(IN_CLOEXEC | IN_NONBLOCK);
        if (instance < 0) return 37;
        int wa = inotify_add_watch(instance, a, IN_CREATE);
        int wb = inotify_add_watch(instance, b, IN_CREATE | IN_DELETE);
        int wc = inotify_add_watch(instance, c, IN_ATTRIB);
        if (wa < 0 || wb < 0 || wc < 0) return 35;
        say("READY inotify-multi\n");
        park(release);
        snprintf(path, sizeof path, "%s/hit", g_poison ? a : b);
        int made = open(path, O_CREAT | O_WRONLY, 0600);
        if (made >= 0) close(made);
        char buffer[4096];
        ssize_t got = -1;
        for (int attempt = 0; attempt < 250 && got < 0; attempt++) {
            got = read(instance, buffer, sizeof buffer);
            if (got < 0) usleep(2000);
        }
        int wd = got > 0 ? ((struct inotify_event *)buffer)->wd : -1;
        snprintf(g_line, sizeof g_line,
                 "RESULT inotify-multi read=%zd wd=%d wb=%d match=%d expected_match=1\n",
                 got, wd, wb, wd == wb ? 1 : 0);
        emit();
        return 0;
    }

    if (!strcmp(shape, "epoll-multi")) {
        int first[2], second[2];
        if (pipe(first) != 0 || pipe(second) != 0) return 34;
        int poller = epoll_create1(EPOLL_CLOEXEC);
        struct epoll_event one, two;
        memset(&one, 0, sizeof one);
        memset(&two, 0, sizeof two);
        one.events = EPOLLIN;
        one.data.u32 = 0x1111;
        two.events = EPOLLIN | EPOLLET;
        two.data.u32 = 0x2222;
        if (poller < 0 || epoll_ctl(poller, EPOLL_CTL_ADD, first[0], &one) != 0) return 33;
        if (!g_poison && epoll_ctl(poller, EPOLL_CTL_ADD, second[0], &two) != 0) return 32;
        say("READY epoll-multi\n");
        park(release);
        if (write(first[1], "a", 1) != 1 || write(second[1], "b", 1) != 1) return 31;
        struct epoll_event seen[8];
        memset(seen, 0, sizeof seen);
        int count = epoll_wait(poller, seen, 8, 2000);
        unsigned tokens = 0;
        for (int index = 0; index < count && index < 8; index++) tokens |= seen[index].data.u32;
        snprintf(g_line, sizeof g_line,
                 "RESULT epoll-multi count=%d tokens=%#x expected_count=2 expected_tokens=0x3333\n", count, tokens);
        emit();
        return 0;
    }


    if (!strcmp(shape, "flock-child")) {
        /* The SAME refusal, raised by a PEER member instead of by the container
           init.  The engine's own contract (checkpoint_linux.rs,
           a_pre_self_dump_refusal_resumes_the_original_tree_...) is that a
           pre-self-dump refusal resumes the original tree; this separates
           "a lock refusal terminalizes the tree" from "a refusal BY THE
           COORDINATOR terminalizes the tree". */
        snprintf(path, sizeof path, "%s/lockfile", scratch);
        int ready[2];
        if (pipe(ready) != 0) return 30;
        pid_t child = fork();
        if (child < 0) return 29;
        if (child == 0) {
            close(ready[0]);
            int fd = open(path, O_RDWR | O_CREAT, 0600);
            if (fd < 0 || (!g_poison && flock(fd, LOCK_EX | LOCK_NB) != 0)) _exit(28);
            (void)write(ready[1], "r", 1);
            close(ready[1]);
            park(release);
            _exit(0);
        }
        close(ready[1]);
        char token;
        if (read(ready[0], &token, 1) != 1) return 27;
        close(ready[0]);
        say("READY flock-child\n");
        park(release);
        int status = 0;
        pid_t reaped = waitpid(child, &status, 0);
        snprintf(g_line, sizeof g_line,
                 "RESULT flock-child reaped=%d code=%d expected_code=0\n", reaped == child,
                 WIFEXITED(status) ? WEXITSTATUS(status) : -1);
        emit();
        return 0;
    }

    /* ================= ROUND 5: memfd / FIFO / SysV IPC / POSIX mqueue =================
       Four kernel-object families with neither a checkpoint_linux.rs test nor a
       matrix shape.  Each holds real kernel state BEFORE the capture and
       consumes it AFTER the restore, and each bounds every call that could
       block so a hang cannot be mistaken for a refusal. */

    if (!strcmp(shape, "memfd")) {
        /* Contents of an anonymous memfd.  Content-addressed so an ablation
           aimed at the blob cannot silently miss. */
        static const char payload[] = "MEMFD-PAYLOAD-4c1d";
        int fd = (int)syscall(SYS_memfd_create, "matrix-memfd", MFD_CLOEXEC | MFD_ALLOW_SEALING);
        if (fd < 0) {
            snprintf(g_line, sizeof g_line, "RESULT memfd unsupported errno=%d\n", errno);
            emit();
            return 0;
        }
        if (!g_poison) {
            if (ftruncate(fd, 4096) != 0) return 121;
            if (pwrite(fd, payload, sizeof payload - 1, 0) != (ssize_t)(sizeof payload - 1)) return 122;
        }
        say("READY memfd\n");
        park(release);
        char raw[64];
        memset(raw, 0, sizeof raw);
        ssize_t got = pread(fd, raw, sizeof payload - 1, 0);
        char seen[128];
        token(seen, sizeof seen, raw, got > 0 ? (size_t)got : 0);
        long long size = (long long)lseek(fd, 0, SEEK_END);
        snprintf(g_line, sizeof g_line,
                 "RESULT memfd got=%zd data=%s size=%lld expected_got=18 expected_data=MEMFD-PAYLOAD-4c1d "
                 "expected_size=4096\n",
                 got, seen, size);
        emit();
        return 0;
    }

    if (!strcmp(shape, "memfd-seal")) {
        /* A dropped seal is a silent, security-relevant regression: the seal is
           reported by F_GET_SEALS AND enforced by the kernel, so both halves
           are measured -- a restore could plausibly carry the number without
           the enforcement, or the enforcement without the number. */
        static const char payload[] = "SEALED-MEMFD-9e2b";
        int fd = (int)syscall(SYS_memfd_create, "matrix-seal", MFD_CLOEXEC | MFD_ALLOW_SEALING);
        if (fd < 0) {
            snprintf(g_line, sizeof g_line, "RESULT memfd-seal unsupported errno=%d\n", errno);
            emit();
            return 0;
        }
        if (ftruncate(fd, 4096) != 0) return 123;
        if (pwrite(fd, payload, sizeof payload - 1, 0) != (ssize_t)(sizeof payload - 1)) return 124;
        if (!g_poison && fcntl(fd, F_ADD_SEALS, F_SEAL_WRITE | F_SEAL_SHRINK | F_SEAL_GROW) != 0) {
            snprintf(g_line, sizeof g_line, "RESULT memfd-seal seal_failed errno=%d\n", errno);
            emit();
            return 0;
        }
        say("READY memfd-seal\n");
        park(release);
        int seals = fcntl(fd, F_GET_SEALS);
        ssize_t denied = pwrite(fd, "X", 1, 0);
        int write_errno = denied < 0 ? errno : 0;
        int shrink = ftruncate(fd, 128);
        int shrink_errno = shrink != 0 ? errno : 0;
        char raw[64];
        memset(raw, 0, sizeof raw);
        ssize_t got = pread(fd, raw, sizeof payload - 1, 0);
        char seen[128];
        token(seen, sizeof seen, raw, got > 0 ? (size_t)got : 0);
        snprintf(g_line, sizeof g_line,
                 "RESULT memfd-seal seals=%#x write=%zd werr=%d shrink=%d serr=%d data=%s "
                 "expected_seals=0xe expected_write=-1 expected_shrink=-1 expected_data=SEALED-MEMFD-9e2b\n",
                 seals, denied, write_errno, shrink, shrink_errno, seen);
        emit();
        return 0;
    }

    if (!strcmp(shape, "fifo-buffered")) {
        /* Bytes resident in a FIFO's kernel buffer at capture time. */
        snprintf(path, sizeof path, "%s/fifo-buffered", scratch);
        (void)unlink(path);
        if (mkfifo(path, 0600) != 0) {
            snprintf(g_line, sizeof g_line, "RESULT fifo-buffered mkfifo_failed errno=%d\n", errno);
            emit();
            return 0;
        }
        int reader = open(path, O_RDONLY | O_NONBLOCK);
        int writer = open(path, O_WRONLY);
        if (reader < 0 || writer < 0) {
            snprintf(g_line, sizeof g_line, "RESULT fifo-buffered open_failed reader=%d writer=%d errno=%d\n", reader,
                     writer, errno);
            emit();
            return 0;
        }
        if (!g_poison && write(writer, "FIFO8BYT", 8) != 8) return 125;
        say("READY fifo-buffered\n");
        park(release);
        char raw[16];
        memset(raw, 0, sizeof raw);
        bound(3);
        ssize_t got = read(reader, raw, 8);
        int read_errno = got < 0 ? errno : 0;
        alarm(0);
        char seen[64];
        token(seen, sizeof seen, raw, got > 0 ? (size_t)got : 0);
        snprintf(g_line, sizeof g_line,
                 "RESULT fifo-buffered got=%zd err=%d data=%s expected_got=8 expected_data=FIFO8BYT\n", got,
                 read_errno, seen);
        emit();
        return 0;
    }

    if (!strcmp(shape, "fifo-writer")) {
        /* The reader/writer open state that decides EOF semantics.  ARMED: a
           writer is still open, so a read of the empty FIFO must report EAGAIN.
           POISONED: the writer was closed, so the same read reports EOF (0).
           A restore that drops the writer end turns every subsequent read into
           a spurious end-of-stream -- silent, and fatal to any protocol. */
        snprintf(path, sizeof path, "%s/fifo-writer", scratch);
        (void)unlink(path);
        if (mkfifo(path, 0600) != 0) {
            snprintf(g_line, sizeof g_line, "RESULT fifo-writer mkfifo_failed errno=%d\n", errno);
            emit();
            return 0;
        }
        int reader = open(path, O_RDONLY | O_NONBLOCK);
        int writer = open(path, O_WRONLY);
        if (reader < 0 || writer < 0) {
            snprintf(g_line, sizeof g_line, "RESULT fifo-writer open_failed reader=%d writer=%d errno=%d\n", reader,
                     writer, errno);
            emit();
            return 0;
        }
        if (g_poison) close(writer);
        say("READY fifo-writer\n");
        park(release);
        char byte = 0;
        bound(3);
        ssize_t got = read(reader, &byte, 1);
        int read_errno = got < 0 ? errno : 0;
        alarm(0);
        snprintf(g_line, sizeof g_line,
                 "RESULT fifo-writer got=%zd err=%d expected_got=-1 expected_err=11\n", got, read_errno);
        emit();
        return 0;
    }

    if (!strcmp(shape, "sysv-shm")) {
        /* An attached SysV segment: its contents, the identity of the shmid
           against a freshly created one, and whether the attachment is still a
           live shared mapping at the address the guest holds a pointer to. */
        static const char payload[] = "SYSV-SHM-PAYLOAD-7f3a";
        int id = shmget(IPC_PRIVATE, 8192, IPC_CREAT | 0600);
        if (id < 0) {
            snprintf(g_line, sizeof g_line, "RESULT sysv-shm shmget_failed errno=%d\n", errno);
            emit();
            return 0;
        }
        char *attached = (char *)shmat(id, NULL, 0);
        if (attached == (char *)-1) {
            snprintf(g_line, sizeof g_line, "RESULT sysv-shm shmat_failed errno=%d\n", errno);
            emit();
            return 0;
        }
        if (!g_poison) memcpy(attached, payload, sizeof payload - 1);
        say("READY sysv-shm\n");
        park(release);
        char seen[128];
        token(seen, sizeof seen, attached, sizeof payload - 1);
        struct shmid_ds info;
        memset(&info, 0, sizeof info);
        int stat_rc = shmctl(id, IPC_STAT, &info);
        int fresh = shmget(IPC_PRIVATE, 8192, IPC_CREAT | 0600);
        int distinct = fresh >= 0 && fresh != id;
        /* Liveness of the attachment itself: a second attach of the same id must
           observe a write made through the pointer the guest already holds. */
        char *second = (char *)shmat(id, NULL, 0);
        memcpy(attached + 64, "LIVE", 4);
        int shared = second != (char *)-1 && memcmp(second + 64, "LIVE", 4) == 0;
        if (second != (char *)-1) (void)shmdt(second);
        if (fresh >= 0) (void)shmctl(fresh, IPC_RMID, NULL);
        snprintf(g_line, sizeof g_line,
                 "RESULT sysv-shm data=%s stat=%d segsz=%llu distinct=%d shared=%d "
                 "expected_data=SYSV-SHM-PAYLOAD-7f3a expected_stat=0 expected_segsz=8192 expected_distinct=1 "
                 "expected_shared=1\n",
                 seen, stat_rc, (unsigned long long)info.shm_segsz, distinct, shared);
        emit();
        (void)shmdt(attached);
        (void)shmctl(id, IPC_RMID, NULL);
        return 0;
    }

    if (!strcmp(shape, "sysv-shm-rmid")) {
        /* IPC_RMID-pending: the segment is marked destroyed but stays usable
           while an attachment survives, and its id stops resolving.  An image
           that re-creates the segment instead of carrying it would report a
           LIVE id here. */
        static const char payload[] = "RMID-PENDING-b2c4";
        int id = shmget(IPC_PRIVATE, 4096, IPC_CREAT | 0600);
        if (id < 0) {
            snprintf(g_line, sizeof g_line, "RESULT sysv-shm-rmid shmget_failed errno=%d\n", errno);
            emit();
            return 0;
        }
        char *attached = (char *)shmat(id, NULL, 0);
        if (attached == (char *)-1) {
            snprintf(g_line, sizeof g_line, "RESULT sysv-shm-rmid shmat_failed errno=%d\n", errno);
            emit();
            return 0;
        }
        memcpy(attached, payload, sizeof payload - 1);
        if (!g_poison && shmctl(id, IPC_RMID, NULL) != 0) return 126;
        say("READY sysv-shm-rmid\n");
        park(release);
        char seen[128];
        token(seen, sizeof seen, attached, sizeof payload - 1);
        struct shmid_ds info;
        memset(&info, 0, sizeof info);
        int stat_rc = shmctl(id, IPC_STAT, &info);
        int stat_errno = stat_rc != 0 ? errno : 0;
        /* A segment removed while still attached stays usable and keeps its id
           resolvable; what changes is the SHM_DEST marker in its mode.  That
           bit is the whole cell: an image that re-creates the segment instead
           of carrying its control state reports a segment that is NOT pending
           destruction, and the guest's last shmdt then leaks it forever
           instead of freeing it. */
        int destroying = stat_rc == 0 && (info.shm_perm.mode & SHM_DEST) != 0;
        snprintf(g_line, sizeof g_line,
                 "RESULT sysv-shm-rmid data=%s stat=%d err=%d dest=%d expected_data=RMID-PENDING-b2c4 "
                 "expected_stat=0 expected_dest=1\n",
                 seen, stat_rc, stat_errno, destroying);
        emit();
        (void)shmdt(attached);
        (void)shmctl(id, IPC_RMID, NULL);
        return 0;
    }

    if (!strcmp(shape, "sysv-sem")) {
        union matrix_semun argument;
        int id = semget(IPC_PRIVATE, 2, IPC_CREAT | 0600);
        if (id < 0) {
            snprintf(g_line, sizeof g_line, "RESULT sysv-sem semget_failed errno=%d\n", errno);
            emit();
            return 0;
        }
        if (!g_poison) {
            argument.val = 7;
            if (semctl(id, 0, SETVAL, argument) != 0) return 127;
            argument.val = 3;
            if (semctl(id, 1, SETVAL, argument) != 0) return 128;
        }
        say("READY sysv-sem\n");
        park(release);
        int first = semctl(id, 0, GETVAL);
        int second = semctl(id, 1, GETVAL);
        struct semid_ds info;
        memset(&info, 0, sizeof info);
        argument.buf = &info;
        int stat_rc = semctl(id, 0, IPC_STAT, argument);
        snprintf(g_line, sizeof g_line,
                 "RESULT sysv-sem v0=%d v1=%d stat=%d nsems=%llu expected_v0=7 expected_v1=3 expected_stat=0 "
                 "expected_nsems=2\n",
                 first, second, stat_rc, (unsigned long long)info.sem_nsems);
        emit();
        (void)semctl(id, 0, IPC_RMID);
        return 0;
    }

    if (!strcmp(shape, "sysv-semadj")) {
        /* semadj -- the per-process SEM_UNDO structure, which is exactly the
           kind of kernel-side state an image either represents or silently
           drops, and which no getter exposes.  It is observed the only way it
           can be: a CHILD holds the adjustment across the capture, exits after
           the restore, and the parent reads the semaphore the kernel just
           unwound.  ARMED (SEM_UNDO): 5 -> 0.  POISONED (no SEM_UNDO): 5 -> 5. */
        union matrix_semun argument;
        int id = semget(IPC_PRIVATE, 1, IPC_CREAT | 0600);
        if (id < 0) {
            snprintf(g_line, sizeof g_line, "RESULT sysv-semadj semget_failed errno=%d\n", errno);
            emit();
            return 0;
        }
        argument.val = 0;
        if (semctl(id, 0, SETVAL, argument) != 0) return 129;
        int ready[2];
        if (pipe(ready) != 0) return 130;
        pid_t child = fork();
        if (child < 0) return 131;
        if (child == 0) {
            close(ready[0]);
            struct sembuf operation;
            memset(&operation, 0, sizeof operation);
            operation.sem_num = 0;
            operation.sem_op = 5;
            operation.sem_flg = (short)(g_poison ? 0 : SEM_UNDO);
            if (semop(id, &operation, 1) != 0) _exit(9);
            (void)write(ready[1], "r", 1);
            close(ready[1]);
            park(release);
            _exit(0);
        }
        close(ready[1]);
        char signal_byte;
        if (read(ready[0], &signal_byte, 1) != 1) return 132;
        close(ready[0]);
        int before = semctl(id, 0, GETVAL);
        say("READY sysv-semadj\n");
        park(release);
        int status = 0;
        pid_t reaped = waitpid(child, &status, 0);
        /* The unwind happens in the child's exit path.  Bounded poll rather
           than a bare read, so a slow unwind is not scored as a dropped one --
           and a genuinely dropped adjustment still reports 5 when it expires. */
        int after = semctl(id, 0, GETVAL);
        for (int attempt = 0; attempt < 200 && after == before; attempt++) {
            usleep(5000);
            after = semctl(id, 0, GETVAL);
        }
        snprintf(g_line, sizeof g_line,
                 "RESULT sysv-semadj reaped=%d code=%d before=%d after=%d expected_before=5 expected_after=0\n",
                 reaped == child, WIFEXITED(status) ? WEXITSTATUS(status) : -1, before, after);
        emit();
        (void)semctl(id, 0, IPC_RMID);
        return 0;
    }

    if (!strcmp(shape, "sysv-msg")) {
        /* Three queued messages with distinct types and payloads, so a loss of
           multiplicity, of type selection, or of FIFO order within the queue is
           each visible as a different wrong value. */
        struct {
            long type;
            char text[16];
        } slot;
        int id = msgget(IPC_PRIVATE, IPC_CREAT | 0600);
        if (id < 0) {
            snprintf(g_line, sizeof g_line, "RESULT sysv-msg msgget_failed errno=%d\n", errno);
            emit();
            return 0;
        }
        if (!g_poison) {
            const char *bodies[3] = {"MSG-ONE-a1", "MSG-TWO-b2", "MSG-THR-c3"};
            for (long index = 0; index < 3; index++) {
                memset(&slot, 0, sizeof slot);
                slot.type = index + 1;
                memcpy(slot.text, bodies[index], strlen(bodies[index]));
                if (msgsnd(id, &slot, sizeof slot.text, 0) != 0) return 133;
            }
        }
        say("READY sysv-msg\n");
        park(release);
        struct msqid_ds info;
        memset(&info, 0, sizeof info);
        int stat_rc = msgctl(id, IPC_STAT, &info);
        char typed[64], first[64], second[64];
        memset(&slot, 0, sizeof slot);
        ssize_t got = msgrcv(id, &slot, sizeof slot.text, 2, IPC_NOWAIT);
        token(typed, sizeof typed, slot.text, got > 0 ? strnlen(slot.text, sizeof slot.text) : 0);
        memset(&slot, 0, sizeof slot);
        ssize_t got_first = msgrcv(id, &slot, sizeof slot.text, 0, IPC_NOWAIT);
        token(first, sizeof first, slot.text, got_first > 0 ? strnlen(slot.text, sizeof slot.text) : 0);
        memset(&slot, 0, sizeof slot);
        ssize_t got_second = msgrcv(id, &slot, sizeof slot.text, 0, IPC_NOWAIT);
        token(second, sizeof second, slot.text, got_second > 0 ? strnlen(slot.text, sizeof slot.text) : 0);
        snprintf(g_line, sizeof g_line,
                 "RESULT sysv-msg stat=%d qnum=%llu typed=%s first=%s second=%s expected_qnum=3 "
                 "expected_typed=MSG-TWO-b2 expected_first=MSG-ONE-a1 expected_second=MSG-THR-c3\n",
                 stat_rc, (unsigned long long)info.msg_qnum, typed, first, second);
        emit();
        (void)msgctl(id, IPC_RMID, NULL);
        return 0;
    }

    if (!strcmp(shape, "mq-queued")) {
        /* POSIX mqueue: three messages at distinct priorities, which must come
           back highest-priority-first.  O_NONBLOCK so no receive can hang. */
        static char name[128];
        snprintf(name, sizeof name, "/hl-matrix-q-%d", (int)getpid());
        struct mq_attr wanted;
        memset(&wanted, 0, sizeof wanted);
        wanted.mq_maxmsg = 8;
        wanted.mq_msgsize = 32;
        (void)mq_unlink(name);
        mqd_t queue = mq_open(name, O_CREAT | O_RDWR | O_NONBLOCK, 0600, &wanted);
        if (queue == (mqd_t)-1) {
            snprintf(g_line, sizeof g_line, "RESULT mq-queued unsupported errno=%d\n", errno);
            emit();
            return 0;
        }
        if (!g_poison) {
            if (mq_send(queue, "MQ-LOW-1", 8, 1) != 0 || mq_send(queue, "MQ-HIGH9", 8, 9) != 0 ||
                mq_send(queue, "MQ-MID-5", 8, 5) != 0) {
                snprintf(g_line, sizeof g_line, "RESULT mq-queued send_failed errno=%d\n", errno);
                emit();
                (void)mq_unlink(name);
                return 0;
            }
        }
        say("READY mq-queued\n");
        park(release);
        struct mq_attr observed;
        memset(&observed, 0, sizeof observed);
        int attr_rc = mq_getattr(queue, &observed);
        char raw[64], seen[3][64];
        unsigned priority[3] = {0, 0, 0};
        ssize_t got[3];
        for (int index = 0; index < 3; index++) {
            memset(raw, 0, sizeof raw);
            bound(3);
            got[index] = mq_receive(queue, raw, 32, &priority[index]);
            alarm(0);
            token(seen[index], sizeof seen[index], raw, got[index] > 0 ? (size_t)got[index] : 0);
        }
        (void)mq_unlink(name);
        snprintf(g_line, sizeof g_line,
                 "RESULT mq-queued attr=%d curmsgs=%lld p1=%u m1=%s p2=%u m2=%s p3=%u m3=%s expected_curmsgs=3 "
                 "expected_p1=9 expected_m1=MQ-HIGH9 expected_p2=5 expected_m2=MQ-MID-5 expected_p3=1 "
                 "expected_m3=MQ-LOW-1\n",
                 attr_rc, (long long)observed.mq_curmsgs, priority[0], seen[0], priority[1], seen[1], priority[2],
                 seen[2]);
        emit();
        return 0;
    }

    if (!strcmp(shape, "mq-attr")) {
        /* mq_attr flags and geometry: O_NONBLOCK on the description plus the
           mq_maxmsg / mq_msgsize the queue was created with. */
        static char name[128];
        snprintf(name, sizeof name, "/hl-matrix-a-%d", (int)getpid());
        struct mq_attr wanted;
        memset(&wanted, 0, sizeof wanted);
        wanted.mq_maxmsg = 4;
        wanted.mq_msgsize = 16;
        (void)mq_unlink(name);
        mqd_t queue = mq_open(name, O_CREAT | O_RDWR | (g_poison ? 0 : O_NONBLOCK), 0600, &wanted);
        if (queue == (mqd_t)-1) {
            snprintf(g_line, sizeof g_line, "RESULT mq-attr unsupported errno=%d\n", errno);
            emit();
            return 0;
        }
        say("READY mq-attr\n");
        park(release);
        struct mq_attr observed;
        memset(&observed, 0, sizeof observed);
        int attr_rc = mq_getattr(queue, &observed);
        (void)mq_unlink(name);
        snprintf(g_line, sizeof g_line,
                 "RESULT mq-attr rc=%d flags=%lld maxmsg=%lld msgsize=%lld expected_rc=0 expected_flags=2048 "
                 "expected_maxmsg=4 expected_msgsize=16\n",
                 attr_rc, (long long)observed.mq_flags, (long long)observed.mq_maxmsg,
                 (long long)observed.mq_msgsize);
        emit();
        return 0;
    }

    return 79;
}
