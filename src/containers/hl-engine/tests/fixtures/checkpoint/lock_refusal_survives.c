/* A guest that holds a REAL file lock across a checkpoint request and must still be ALIVE afterwards.
 *
 * argv[1] = report path, argv[2] = role, argv[3] = lock file path, argv[4] = release path
 *
 * Roles:
 *   init   -- the container init itself takes an exclusive flock(2) and holds it
 *   member -- the init forks a child, and the CHILD takes the lock; the init holds none.
 *             This is the arm a real workload hits: a `Persisted` exec pane is a tree MEMBER.
 *   none   -- the same two-process shape with no lock taken anywhere, so a capture must be ADMITTED.
 *             The control that stops this fixture from proving a refusal by refusing everything.
 *
 * WHY THIS IS NOT THE EXISTING LOCK FIXTURE. `held_file_lock.c` proves the lock is held and then parks
 * forever, which is everything a test of the DECISION needs. It cannot see the other half of what a
 * refusal owes -- that the container is left as the capture found it -- because a guest that is never
 * asked to do anything again looks identical whether it survived or was destroyed. This one is asked.
 * After the host has observed the refusal it creates the release path, and the guest must then:
 *
 *   - still be running at all (the whole point: the refusal used to exit the engine with code 3);
 *   - still hold its lock, measured the same way it was measured before -- a refusal that dropped the
 *     interlock on its way out would be a different corruption with the same green result;
 *   - do real work afterwards: WORK_ROUNDS rounds of write/fsync/read through a file it opens after
 *     the release, whose read-back bytes are summed into the result. A parked or dead guest cannot
 *     produce that sum, and neither can a guest that only reached the release and stopped.
 *
 * NOTHING HERE MAY BLOCK WITHOUT A BOUND. A shape that hangs is scored as a refusal by any runner that
 * treats a missing result as one, which is the SAFE verdict, silently and one-directionally. Every wait
 * is a bounded poll that reports `released=0` and exits non-zero rather than waiting forever, so "the
 * guest never came back" is a value in the report instead of an absence. */
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define RELEASE_POLL_MS 5
#define RELEASE_ROUNDS 4000 /* 20 s ceiling, reported rather than waited out */
#define WORK_ROUNDS 16
#define CHILD_WORK_CODE 37

/* 1 when a freshly forked child CANNOT take the lock, i.e. this process still holds it; 0 when the
 * child took it; -1 when the probe itself failed. The same measurement before and after the capture,
 * so "still held" is a comparison of like with like. */
static int lock_is_held(const char *path) {
    pid_t child = fork();
    if (child < 0) return -1;
    if (child == 0) {
        int descriptor = open(path, O_RDWR);
        if (descriptor < 0) _exit(2);
        int taken = flock(descriptor, LOCK_EX | LOCK_NB) == 0;
        _exit(taken ? 1 : 0);
    }
    int status = 0;
    if (waitpid(child, &status, 0) != child || !WIFEXITED(status)) return -1;
    if (WEXITSTATUS(status) == 2) return -1;
    return WEXITSTATUS(status) == 1 ? 0 : 1;
}

static int append(const char *path, const char *line) {
    int descriptor = open(path, O_WRONLY | O_CREAT | O_APPEND, 0600);
    size_t length = strlen(line);
    int failed = descriptor < 0 || write(descriptor, line, length) != (ssize_t)length;
    if (descriptor >= 0 && close(descriptor) != 0) failed = 1;
    return failed ? -1 : 0;
}

/* Bounded: returns 1 when the host released us, 0 when the ceiling passed. Never blocks forever. */
static int await_release(const char *release) {
    for (int round = 0; round < RELEASE_ROUNDS; round++) {
        if (access(release, F_OK) == 0) return 1;
        struct timespec pause = {.tv_sec = 0, .tv_nsec = RELEASE_POLL_MS * 1000000L};
        (void)nanosleep(&pause, NULL);
    }
    return 0;
}

/* Real post-refusal work: a file created AFTER the release, written, synced, and read back, with the
 * bytes summed. Returns the sum, or -1. A dead or parked guest reaches none of it. */
static long do_work(const char *release) {
    char path[512];
    long total = 0;
    if (snprintf(path, sizeof path, "%s.work.%d", release, (int)getpid()) >= (int)sizeof path) return -1;
    int descriptor = open(path, O_RDWR | O_CREAT | O_TRUNC, 0600);
    if (descriptor < 0) return -1;
    for (int round = 0; round < WORK_ROUNDS; round++) {
        unsigned char byte = (unsigned char)(round + 1);
        unsigned char echo = 0;
        if (pwrite(descriptor, &byte, 1, round) != 1) { total = -1; break; }
        if (fsync(descriptor) != 0) { total = -1; break; }
        if (pread(descriptor, &echo, 1, round) != 1 || echo != byte) { total = -1; break; }
        total += echo;
    }
    if (close(descriptor) != 0) return -1;
    (void)unlink(path);
    return total;
}

/* One process's whole post-readiness life: wait to be released, re-measure the lock, work, report. */
static int survive(const char *report, const char *who, const char *lock, const char *release, int expect_lock) {
    int released = await_release(release);
    int held_after = expect_lock ? lock_is_held(lock) : 0;
    long work = released ? do_work(release) : -1;
    char line[256];
    (void)snprintf(line, sizeof line, "RESULT %s released=%d held_after=%d work=%ld\n", who, released, held_after,
                   work);
    if (append(report, line) != 0) return 20;
    if (!released) return 21;
    if (expect_lock && held_after != 1) return 22;
    if (work != (long)(WORK_ROUNDS * (WORK_ROUNDS + 1) / 2)) return 23;
    return 0;
}

int main(int argc, char **argv) {
    if (argc != 5) return 2;
    const char *report = argv[1], *role = argv[2], *lock = argv[3], *release = argv[4];
    int member = strcmp(role, "member") == 0;
    int init = strcmp(role, "init") == 0;
    if (!member && !init && strcmp(role, "none") != 0) return 3;

    int pipes[2];
    if (pipe(pipes) != 0) return 4;

    pid_t child = fork();
    if (child < 0) return 5;
    if (child == 0) {
        (void)close(pipes[0]);
        int held = 0;
        if (member) {
            int descriptor = open(lock, O_RDWR | O_CREAT, 0600);
            if (descriptor < 0) _exit(6);
            if (flock(descriptor, LOCK_EX | LOCK_NB) != 0) _exit(7);
            held = lock_is_held(lock);
            if (held != 1) _exit(8);
        }
        if (write(pipes[1], "r", 1) != 1) _exit(9);
        (void)close(pipes[1]);
        char line[128];
        (void)snprintf(line, sizeof line, "CHILD %s held=%d\n", role, held);
        if (append(report, line) != 0) _exit(10);
        int code = survive(report, "child", lock, release, member);
        _exit(code == 0 ? CHILD_WORK_CODE : code);
    }
    (void)close(pipes[1]);
    char token = 0;
    if (read(pipes[0], &token, 1) != 1 || token != 'r') return 11;
    (void)close(pipes[0]);

    int held = 0;
    if (init) {
        int descriptor = open(lock, O_RDWR | O_CREAT, 0600);
        if (descriptor < 0) return 12;
        if (flock(descriptor, LOCK_EX | LOCK_NB) != 0) return 13;
        held = lock_is_held(lock);
        if (held != 1) return 14;
    }
    /* Readiness is published only once BOTH processes exist and whichever of them owns the lock is
     * already holding it, so a capture requested on this marker always meets the shape under test. */
    char line[128];
    (void)snprintf(line, sizeof line, "READY %s held=%d\n", role, held);
    if (append(report, line) != 0) return 15;

    int code = survive(report, "init", lock, release, init);
    if (code != 0) return code;

    int status = 0;
    if (waitpid(child, &status, 0) != child || !WIFEXITED(status)) return 16;
    char reaped[128];
    (void)snprintf(reaped, sizeof reaped, "REAPED %s code=%d\n", role, WEXITSTATUS(status));
    if (append(report, reaped) != 0) return 17;
    return WEXITSTATUS(status) == CHILD_WORK_CODE ? 0 : 18;
}
