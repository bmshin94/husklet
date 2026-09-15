/* Per-process kernel/engine state a checkpoint image does not obviously carry.
 *
 * argv[1] = report path, argv[2] = finish path.
 *
 * The guest arms three things that live outside its address space and outside its descriptor table --
 * the file-creation mask, an emulated resource limit, and an interval timer -- measures each one back
 * through the syscall that reads it, publishes them, and parks. After the checkpoint round trip it
 * re-reads all three from the same syscalls. A restored process that reports different values changed
 * state its guest never asked to change, while reporting success.
 *
 * Every value is read back rather than assumed: umask(2) has no getter, so the mask is read by setting
 * it to 0 and immediately putting it back; the limit and the timer are read with getrlimit/getitimer.
 */
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#define ARMED_UMASK 0077
#define ARMED_NOFILE 64u

static mode_t read_umask(void) {
    mode_t current = umask(0);
    umask(current);
    return current;
}

static int publish(const char *path, const char *text) {
    int descriptor = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    size_t length = strlen(text);
    int failed = descriptor < 0 || write(descriptor, text, length) != (ssize_t)length;
    if (descriptor >= 0 && close(descriptor) != 0) failed = 1;
    return failed ? -1 : 0;
}

static int report(const char *path, const char *tag) {
    struct rlimit limit;
    struct itimerval timer;
    if (getrlimit(RLIMIT_NOFILE, &limit) != 0) return -1;
    if (getitimer(ITIMER_VIRTUAL, &timer) != 0) return -1;
    int armed = timer.it_value.tv_sec > 0 || timer.it_value.tv_usec > 0;
    char line[256];
    if (snprintf(line, sizeof line, "%s umask=%04o nofile=%llu vtimer=%d\n", tag, (unsigned)read_umask(),
                 (unsigned long long)limit.rlim_cur, armed) <= 0)
        return -1;
    return publish(path, line);
}

int main(int argc, char **argv) {
    if (argc != 3) return 2;
    const char *path = argv[1], *finish = argv[2];

    if (umask(ARMED_UMASK) == ARMED_UMASK) return 3; // a fixture that armed nothing proves nothing
    if (read_umask() != ARMED_UMASK) return 4;

    struct rlimit limit;
    if (getrlimit(RLIMIT_NOFILE, &limit) != 0) return 5;
    if (limit.rlim_cur == ARMED_NOFILE) return 6;
    struct rlimit narrowed = {ARMED_NOFILE, limit.rlim_max};
    if (setrlimit(RLIMIT_NOFILE, &narrowed) != 0) return 7;
    if (getrlimit(RLIMIT_NOFILE, &limit) != 0 || limit.rlim_cur != ARMED_NOFILE) return 8;

    struct itimerval armed;
    memset(&armed, 0, sizeof armed);
    armed.it_value.tv_sec = 3600;
    if (setitimer(ITIMER_VIRTUAL, &armed, NULL) != 0) return 9;
    struct itimerval observed;
    if (getitimer(ITIMER_VIRTUAL, &observed) != 0) return 10;
    if (observed.it_value.tv_sec <= 0 && observed.it_value.tv_usec <= 0) return 11;

    if (report(path, "READY") != 0) return 12;

    for (;;) {
        if (access(finish, F_OK) == 0) break;
        struct timespec span = {0, 5000000};
        if (nanosleep(&span, NULL) != 0 && errno != EINTR) return 90;
    }

    if (report(path, "RESULT") != 0) return 13;
    return 0;
}
