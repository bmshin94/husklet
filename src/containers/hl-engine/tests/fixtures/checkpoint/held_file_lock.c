/* A guest that takes a REAL file lock and parks while still holding it.
 *
 * argv[1] = ready path, argv[2] = mode, argv[3] = lock file path.
 *
 * Modes:
 *   none     -- the lock file is open but no lock is taken
 *   released -- an exclusive flock(2) is taken and then released with LOCK_UN
 *   flock    -- an exclusive flock(2) is taken and still held while parked
 *   dup      -- an exclusive flock(2) is taken, the descriptor is dup'd, and the
 *               ORIGINAL is closed; the lock belongs to the open file description,
 *               so it is still held through the surviving alias
 *   fcntl    -- an exclusive fcntl(F_SETLK) record lock is still held while parked
 *
 * Before publishing readiness the fixture MEASURES whether the lock is actually
 * held, by forking a child that tries to take the same lock and reporting the
 * outcome in the ready file as `held=0` / `held=1`. Without that the "flock"
 * arm would be indistinguishable from a guest whose flock(2) silently did
 * nothing, and a refusal test built on it would prove nothing. */
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

/* 1 when a freshly forked child CANNOT take the lock, i.e. this process still
 * holds it; 0 when the child took it; -1 when the probe itself failed. */
static int lock_is_held(const char *path, int posix_style) {
    pid_t child = fork();
    if (child < 0) return -1;
    if (child == 0) {
        int descriptor = open(path, O_RDWR);
        if (descriptor < 0) _exit(2);
        int taken;
        if (posix_style) {
            struct flock probe;
            memset(&probe, 0, sizeof probe);
            probe.l_type = F_WRLCK;
            probe.l_whence = SEEK_SET;
            taken = fcntl(descriptor, F_SETLK, &probe) == 0;
        } else {
            taken = flock(descriptor, LOCK_EX | LOCK_NB) == 0;
        }
        _exit(taken ? 1 : 0);
    }
    int status = 0;
    if (waitpid(child, &status, 0) != child || !WIFEXITED(status)) return -1;
    if (WEXITSTATUS(status) == 2) return -1;
    return WEXITSTATUS(status) == 1 ? 0 : 1;
}

static int publish(const char *path, const char *mode, int held) {
    int descriptor = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    char message[96];
    int length = snprintf(message, sizeof message, "READY %s held=%d\n", mode, held);
    int failed = descriptor < 0 || length <= 0 || length >= (int)sizeof message ||
                 write(descriptor, message, (size_t)length) != length;
    if (descriptor >= 0 && close(descriptor) != 0) failed = 1;
    return failed ? -1 : 0;
}

int main(int argc, char **argv) {
    if (argc != 4) return 2;
    const char *mode = argv[2], *path = argv[3];
    int posix_style = strcmp(mode, "fcntl") == 0;
    int descriptor = open(path, O_RDWR | O_CREAT, 0600);
    if (descriptor < 0) return 3;

    if (posix_style) {
        struct flock held;
        memset(&held, 0, sizeof held);
        held.l_type = F_WRLCK;
        held.l_whence = SEEK_SET;
        if (fcntl(descriptor, F_SETLK, &held) != 0) return 4;
    } else if (strcmp(mode, "flock") == 0) {
        if (flock(descriptor, LOCK_EX | LOCK_NB) != 0) return 5;
    } else if (strcmp(mode, "dup") == 0) {
        if (flock(descriptor, LOCK_EX | LOCK_NB) != 0) return 12;
        int alias = dup(descriptor);
        if (alias < 0) return 13;
        if (close(descriptor) != 0) return 14;
        descriptor = alias;
    } else if (strcmp(mode, "released") == 0) {
        if (flock(descriptor, LOCK_EX | LOCK_NB) != 0) return 6;
        if (flock(descriptor, LOCK_UN) != 0) return 7;
    } else if (strcmp(mode, "none") != 0) {
        return 8;
    }

    int held = lock_is_held(path, posix_style);
    if (held < 0) return 9;
    if (publish(argv[1], mode, held) != 0) return 10;
    struct timespec pause = {.tv_sec = 1};
    for (;;) {
        if (nanosleep(&pause, NULL) != 0 && errno != EINTR) return 11;
    }
}
