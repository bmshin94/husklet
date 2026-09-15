/* Pending-signal fidelity across checkpoint/restore, for the translated backend.
 *
 * Every arm blocks its signals, QUEUES them with distinct si_value payloads, and -- after the
 * restore -- reports what `sigpending()` still sees AND what the handler actually receives when the
 * signals are unblocked.  Reporting delivery, not just presence, is what makes multiplicity and
 * payload loss visible: a restore that rebuilt the pending set from a bitmask would report the
 * signal present but deliver si_code/si_value it invented.
 *
 * Three arms, chosen to bracket the defect:
 *   root        the guest's own init process, leader thread                (positive control)
 *   root-thread a peer thread of the init process                          (positive control)
 *   child       a re-forked tree member's leader thread                    (the measurement)
 *
 * Two directions in each arm:
 *   process-directed  sigqueue(getpid(), ...)     -- engine-side g_pending + g_sigq
 *   thread-directed   raise(...) == tgkill(self)  -- engine-side cpu->tpending
 *
 * argv: <release-path> <arm>
 * The report is appended to "<release-path>.output"; the harness waits for "READY <arm>" and
 * reads the "RESULT <arm> ..." line.
 */
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <signal.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

#define STD_SIG SIGUSR2          /* a standard signal: at most ONE instance may stay pending */
#define RT_SIG (SIGRTMIN + 3)    /* a real-time signal: instances queue, FIFO, payloads distinct */

#define STD_PROC_VALUE 0x5150
#define RT_PROC_VALUE_A 0xab01
#define RT_PROC_VALUE_B 0xab02
#define RT_PROC_VALUE_C 0xab03
#define THREAD_SIG SIGUSR1       /* thread-directed via raise() */

static int g_report_fd = -1;
static char g_line[512];

static void emit(void) {
    (void)write(g_report_fd, g_line, strlen(g_line));
}

/* Observed deliveries, in order. */
static volatile sig_atomic_t g_std_count;
static volatile sig_atomic_t g_std_value;
static volatile sig_atomic_t g_std_code;
static volatile sig_atomic_t g_rt_count;
static volatile sig_atomic_t g_rt_values[8];
static volatile sig_atomic_t g_rt_codes[8];
static volatile sig_atomic_t g_thread_count;
static volatile sig_atomic_t g_thread_code;

static void record(int signal, siginfo_t *info, void *unused) {
    (void)unused;
    if (signal == STD_SIG) {
        g_std_value = info ? info->si_value.sival_int : -1;
        g_std_code = info ? info->si_code : -999;
        g_std_count++;
    } else if (signal == RT_SIG) {
        int slot = g_rt_count;
        if (slot >= 0 && slot < 8) {
            g_rt_values[slot] = info ? info->si_value.sival_int : -1;
            g_rt_codes[slot] = info ? info->si_code : -999;
        }
        g_rt_count++;
    } else {
        g_thread_code = info ? info->si_code : -999;
        g_thread_count++;
    }
}

static int install(int signal) {
    struct sigaction action;
    memset(&action, 0, sizeof action);
    action.sa_sigaction = record;
    action.sa_flags = SA_SIGINFO;
    sigemptyset(&action.sa_mask);
    return sigaction(signal, &action, NULL);
}

/* Block the three signals and queue them with distinct payloads.  Returns 0 on success. */
static int arm_pending(void) {
    sigset_t block;
    union sigval value;
    if (install(STD_SIG) != 0 || install(RT_SIG) != 0 || install(THREAD_SIG) != 0) return 1;
    sigemptyset(&block);
    sigaddset(&block, STD_SIG);
    sigaddset(&block, RT_SIG);
    sigaddset(&block, THREAD_SIG);
    if (pthread_sigmask(SIG_BLOCK, &block, NULL) != 0) return 2;
    value.sival_int = STD_PROC_VALUE;
    if (sigqueue(getpid(), STD_SIG, value) != 0) return 3;
    value.sival_int = RT_PROC_VALUE_A;
    if (sigqueue(getpid(), RT_SIG, value) != 0) return 4;
    value.sival_int = RT_PROC_VALUE_B;
    if (sigqueue(getpid(), RT_SIG, value) != 0) return 5;
    value.sival_int = RT_PROC_VALUE_C;
    if (sigqueue(getpid(), RT_SIG, value) != 0) return 6;
    if (raise(THREAD_SIG) != 0) return 7; /* glibc raise() == tgkill(self): THREAD-directed */
    return 0;
}

struct observation {
    int pending_std;
    int pending_rt;
    int pending_thread;
    int std_count;
    int std_value;
    int rt_count;
    int rt_values[4];
    int thread_count;
};

/* Read sigpending(), then unblock and let every queued instance be delivered. */
static void observe(struct observation *out) {
    sigset_t queued, empty;
    memset(out, 0, sizeof *out);
    sigemptyset(&queued);
    if (sigpending(&queued) != 0) {
        out->pending_std = out->pending_rt = out->pending_thread = -1;
        return;
    }
    out->pending_std = sigismember(&queued, STD_SIG);
    out->pending_rt = sigismember(&queued, RT_SIG);
    out->pending_thread = sigismember(&queued, THREAD_SIG);
    sigemptyset(&empty);
    (void)pthread_sigmask(SIG_SETMASK, &empty, NULL);
    for (int spin = 0; spin < 400; ++spin) usleep(2000);
    out->std_count = g_std_count;
    out->std_value = g_std_count ? g_std_value : -1;
    out->rt_count = g_rt_count;
    for (int i = 0; i < 4; ++i) out->rt_values[i] = i < g_rt_count && i < 8 ? g_rt_values[i] : -1;
    out->thread_count = g_thread_count;
}

static void format(const char *arm, const struct observation *o) {
    snprintf(g_line, sizeof g_line,
             "RESULT %s pending_std=%d pending_rt=%d pending_thread=%d std_count=%d std_value=0x%x "
             "rt_count=%d rt_values=0x%x,0x%x,0x%x thread_count=%d "
             "expected pending_std=1 pending_rt=1 pending_thread=1 std_count=1 std_value=0x%x "
             "rt_count=3 rt_values=0x%x,0x%x,0x%x thread_count=1\n",
             arm, o->pending_std, o->pending_rt, o->pending_thread, o->std_count, o->std_value, o->rt_count,
             o->rt_values[0], o->rt_values[1], o->rt_values[2], o->thread_count, STD_PROC_VALUE, RT_PROC_VALUE_A,
             RT_PROC_VALUE_B, RT_PROC_VALUE_C);
}

static void park(const char *release) {
    while (access(release, F_OK) != 0) {
        if (errno != ENOENT) return;
        usleep(2000);
    }
}

static const char *g_release;
static _Atomic int g_peer_armed;
static _Atomic int g_peer_done;
static struct observation g_peer_observation;

static void *peer(void *unused) {
    (void)unused;
    if (arm_pending() != 0) {
        atomic_store_explicit(&g_peer_armed, -1, memory_order_release);
        return NULL;
    }
    atomic_store_explicit(&g_peer_armed, 1, memory_order_release);
    park(g_release);
    observe(&g_peer_observation);
    atomic_store_explicit(&g_peer_done, 1, memory_order_release);
    return NULL;
}

/* ---- thread-directed-only arms -------------------------------------------------------------
 * The shape the repo's own three-process tree fixture uses: the signal is blocked ONLY in the
 * measuring thread (the process's other threads never block it) and is sent thread-directed with
 * pthread_kill(self).  Kept separate from the arms above, whose process-directed instances require
 * a process-wide block to be deterministic.
 */
static _Atomic int g_open_armed;
static _Atomic int g_open_pending;
static _Atomic int g_open_count;

static void *open_peer(void *unused) {
    (void)unused;
    sigset_t block, queued;
    if (install(THREAD_SIG) != 0) {
        atomic_store_explicit(&g_open_armed, -1, memory_order_release);
        return NULL;
    }
    sigemptyset(&block);
    sigaddset(&block, THREAD_SIG);
    if (pthread_sigmask(SIG_BLOCK, &block, NULL) != 0 || pthread_kill(pthread_self(), THREAD_SIG) != 0) {
        atomic_store_explicit(&g_open_armed, -1, memory_order_release);
        return NULL;
    }
    atomic_store_explicit(&g_open_armed, 1, memory_order_release);
    park(g_release);
    sigemptyset(&queued);
    (void)sigpending(&queued);
    atomic_store_explicit(&g_open_pending, sigismember(&queued, THREAD_SIG), memory_order_release);
    sigset_t empty;
    sigemptyset(&empty);
    (void)pthread_sigmask(SIG_SETMASK, &empty, NULL);
    for (int spin = 0; spin < 400; ++spin) usleep(2000);
    atomic_store_explicit(&g_open_count, g_thread_count, memory_order_release);
    return NULL;
}

static int open_peer_start(pthread_t *thread) {
    if (pthread_create(thread, NULL, open_peer, NULL) != 0) return -1;
    while (atomic_load_explicit(&g_open_armed, memory_order_acquire) == 0) usleep(2000);
    return atomic_load_explicit(&g_open_armed, memory_order_acquire) < 0 ? -1 : 0;
}

static void open_peer_format(const char *arm, int pending, int count) {
    snprintf(g_line, sizeof g_line, "RESULT %s pending_thread=%d thread_count=%d expected pending_thread=1 thread_count=1\n",
             arm, pending, count);
}

int main(int argc, char **argv) {
    if (argc != 3) return 2;
    const char *release = argv[1];
    const char *arm = argv[2];
    char output[1024];
    if (snprintf(output, sizeof output, "%s.output", release) >= (int)sizeof output) return 2;
    g_report_fd = open(output, O_WRONLY | O_CREAT | O_APPEND, 0600);
    if (g_report_fd < 0) return 2;
    g_release = release;

    /* Block all three signals process-wide BEFORE any thread exists, so a process-directed
     * instance cannot be taken by whichever thread happens not to be the one under measurement.
     * A new thread inherits the creating thread's mask, so the measuring thread stays blocked and
     * the parked main thread can never consume the queue out from under it. */
    if (strstr(arm, "-open") == NULL) {
        sigset_t block;
        sigemptyset(&block);
        sigaddset(&block, STD_SIG);
        sigaddset(&block, RT_SIG);
        sigaddset(&block, THREAD_SIG);
        if (pthread_sigmask(SIG_BLOCK, &block, NULL) != 0) return 4;
    }

    if (!strcmp(arm, "root")) {
        int armed = arm_pending();
        if (armed != 0) return 10 + armed;
        snprintf(g_line, sizeof g_line, "READY root\n");
        emit();
        park(release);
        struct observation observation;
        observe(&observation);
        format("root", &observation);
        emit();
        return 0;
    }

    if (!strcmp(arm, "root-thread")) {
        pthread_t thread;
        if (pthread_create(&thread, NULL, peer, NULL) != 0) return 20;
        while (atomic_load_explicit(&g_peer_armed, memory_order_acquire) == 0) usleep(2000);
        if (atomic_load_explicit(&g_peer_armed, memory_order_acquire) < 0) return 21;
        snprintf(g_line, sizeof g_line, "READY root-thread\n");
        emit();
        park(release);
        if (pthread_join(thread, NULL) != 0) return 22;
        format("root-thread", &g_peer_observation);
        emit();
        return 0;
    }

    if (!strcmp(arm, "child")) {
        int ready[2];
        int report[2];
        if (pipe(ready) != 0 || pipe(report) != 0) return 30;
        pid_t child = fork();
        if (child < 0) return 31;
        if (child == 0) {
            close(ready[0]);
            close(report[0]);
            int armed = arm_pending();
            if (armed != 0) _exit(40 + armed);
            (void)write(ready[1], "r", 1);
            close(ready[1]);
            park(release);
            struct observation observation;
            observe(&observation);
            (void)write(report[1], &observation, sizeof observation);
            close(report[1]);
            _exit(0);
        }
        close(ready[1]);
        close(report[1]);
        char token;
        if (read(ready[0], &token, 1) != 1) return 32;
        close(ready[0]);
        snprintf(g_line, sizeof g_line, "READY child\n");
        emit();
        park(release);
        struct observation observation;
        ssize_t got = read(report[0], &observation, sizeof observation);
        int status = 0;
        pid_t reaped = waitpid(child, &status, 0);
        if (got != (ssize_t)sizeof observation) {
            snprintf(g_line, sizeof g_line, "RESULT child NO-REPORT got=%zd reaped=%d status=%d\n", got,
                     reaped == child, status);
            emit();
            return 0;
        }
        format("child", &observation);
        emit();
        return 0;
    }
    if (!strcmp(arm, "peer-open")) {
        pthread_t thread;
        if (open_peer_start(&thread) != 0) return 50;
        snprintf(g_line, sizeof g_line, "READY peer-open\n");
        emit();
        park(release);
        if (pthread_join(thread, NULL) != 0) return 51;
        open_peer_format("peer-open", atomic_load_explicit(&g_open_pending, memory_order_acquire),
                         atomic_load_explicit(&g_open_count, memory_order_acquire));
        emit();
        return 0;
    }

    if (!strcmp(arm, "child-peer-open")) {
        int ready[2], report[2];
        if (pipe(ready) != 0 || pipe(report) != 0) return 60;
        pid_t child = fork();
        if (child < 0) return 61;
        if (child == 0) {
            close(ready[0]);
            close(report[0]);
            pthread_t thread;
            if (open_peer_start(&thread) != 0) _exit(62);
            (void)write(ready[1], "r", 1);
            close(ready[1]);
            park(release);
            if (pthread_join(thread, NULL) != 0) _exit(63);
            int pair[2] = {atomic_load_explicit(&g_open_pending, memory_order_acquire),
                           atomic_load_explicit(&g_open_count, memory_order_acquire)};
            (void)write(report[1], pair, sizeof pair);
            close(report[1]);
            _exit(0);
        }
        close(ready[1]);
        close(report[1]);
        char token;
        if (read(ready[0], &token, 1) != 1) return 64;
        close(ready[0]);
        snprintf(g_line, sizeof g_line, "READY child-peer-open\n");
        emit();
        park(release);
        int pair[2] = {-1, -1};
        ssize_t got = read(report[0], pair, sizeof pair);
        int status = 0;
        pid_t reaped = waitpid(child, &status, 0);
        if (got != (ssize_t)sizeof pair) {
            snprintf(g_line, sizeof g_line, "RESULT child-peer-open NO-REPORT got=%zd reaped=%d status=%d\n", got,
                     reaped == child, status);
            emit();
            return 0;
        }
        open_peer_format("child-peer-open", pair[0], pair[1]);
        emit();
        return 0;
    }

    return 3;
}
