/* A guest holding a SEEKABLE device at a non-zero file position across a checkpoint.
 *
 * argv[1] = report path, argv[2] = device path, argv[3] = finish path.
 *
 * Character devices mostly have no position at all, which is why the restore exempted the whole
 * CKF_DEVICE class from the seek that CKF_FILE gets. A block device does have one: /dev/loopN and
 * /dev/sdX are ordinary seekable objects, and a guest that has read its way to byte 8192 and resumes
 * at byte 0 reads the wrong blocks and reports no error while doing it.
 *
 * The fixture seeks to a known offset, reads a known 16 bytes from there (so the position it claims is
 * one the KERNEL agrees with rather than one the fixture merely remembers), publishes both, and parks.
 * After the checkpoint it re-reads the position and the next 16 bytes from wherever the descriptor now
 * sits, so a rewound descriptor is visible twice over: the offset it reports and the bytes it returns.
 */
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#define PROBE_OFFSET 8192
#define PROBE_BYTES 16

static int read_exactly(int fd, unsigned char *out, int size) {
    int at = 0;
    while (at < size) {
        ssize_t count = read(fd, out + at, (size_t)(size - at));
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return -1;
        at += (int)count;
    }
    return 0;
}

static void hex(const unsigned char *bytes, int size, char *out) {
    static const char digits[] = "0123456789abcdef";
    for (int index = 0; index < size; ++index) {
        out[index * 2] = digits[bytes[index] >> 4];
        out[index * 2 + 1] = digits[bytes[index] & 15];
    }
    out[size * 2] = 0;
}

static int publish(const char *path, const char *text) {
    int descriptor = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
    size_t length = strlen(text);
    int failed = descriptor < 0 || write(descriptor, text, length) != (ssize_t)length;
    if (descriptor >= 0 && close(descriptor) != 0) failed = 1;
    return failed ? -1 : 0;
}

int main(int argc, char **argv) {
    if (argc != 4) return 2;
    const char *report = argv[1], *device = argv[2], *finish = argv[3];

    int fd = open(device, O_RDONLY);
    if (fd < 0) return 3;
    if (lseek(fd, PROBE_OFFSET, SEEK_SET) != PROBE_OFFSET) return 4;
    unsigned char bytes[PROBE_BYTES];
    if (read_exactly(fd, bytes, PROBE_BYTES) != 0) return 5;
    off_t armed = lseek(fd, 0, SEEK_CUR);
    if (armed != PROBE_OFFSET + PROBE_BYTES) return 6;

    char encoded[PROBE_BYTES * 2 + 1];
    hex(bytes, PROBE_BYTES, encoded);
    char line[256];
    if (snprintf(line, sizeof line, "READY offset=%lld bytes=%s\n", (long long)armed, encoded) <= 0) return 7;
    if (publish(report, line) != 0) return 8;

    /* Park until the harness says the checkpoint round trip is over. A restored process resumes
     * here, so this loop runs in BOTH the captured process and the restored one. */
    for (;;) {
        if (access(finish, F_OK) == 0) break;
        struct timespec span = {0, 5000000};
        if (nanosleep(&span, NULL) != 0 && errno != EINTR) return 90;
    }

    off_t resumed = lseek(fd, 0, SEEK_CUR);
    unsigned char after[PROBE_BYTES];
    char encoded_after[PROBE_BYTES * 2 + 1];
    if (resumed < 0 || read_exactly(fd, after, PROBE_BYTES) != 0) {
        hex(bytes, 0, encoded_after);
        if (snprintf(line, sizeof line, "RESULT offset=%lld bytes=unreadable\n", (long long)resumed) <= 0) return 9;
    } else {
        hex(after, PROBE_BYTES, encoded_after);
        if (snprintf(line, sizeof line, "RESULT offset=%lld bytes=%s\n", (long long)resumed, encoded_after) <= 0)
            return 10;
    }
    if (publish(report, line) != 0) return 11;
    return 0;
}
