// Reads the guest clocks on BOTH sides of a checkpoint and reports the VALUES.
//
// The point is the value, not the return code: an engine that answers
// clock_gettime with "success" and a zero timespec is indistinguishable from a
// working clock if the fixture only checks rc. So every reading is written out
// and the harness asserts on the numbers.
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

static int exists(const char *path) {
    return access(path, F_OK) == 0;
}

int main(int argc, char **argv) {
    if (argc != 4) return 2;
    const char *ready = argv[1], *release = argv[2], *result = argv[3];
    struct timespec pre_real, pre_mono, post_real, post_mono;
    struct timeval post_gtod;
    memset(&pre_real, 0, sizeof pre_real);
    memset(&pre_mono, 0, sizeof pre_mono);
    // Pre-checkpoint readings: the same call sites, in the same process, before any capture.
    int pre_real_rc = clock_gettime(CLOCK_REALTIME, &pre_real);
    int pre_mono_rc = clock_gettime(CLOCK_MONOTONIC, &pre_mono);

    int marker = open(ready, O_WRONLY | O_CREAT | O_EXCL, 0600);
    if (marker < 0 || write(marker, "R", 1) != 1 || close(marker) != 0) return 5;
    while (!exists(release)) {
        if (errno != ENOENT) return 6;
        usleep(1000);
    }

    // Post-restore readings. Poison the buffers first so "the engine never wrote
    // anything" and "the engine wrote zeros" stay distinguishable from each other.
    memset(&post_real, 0x5a, sizeof post_real);
    memset(&post_mono, 0x5a, sizeof post_mono);
    memset(&post_gtod, 0x5a, sizeof post_gtod);
    int post_real_rc = clock_gettime(CLOCK_REALTIME, &post_real);
    int post_mono_rc = clock_gettime(CLOCK_MONOTONIC, &post_mono);
    int post_gtod_rc = gettimeofday(&post_gtod, NULL);

    FILE *output = fopen(result, "w");
    if (!output) return 8;
    fprintf(output,
            "pre_real=%d,%lld.%09ld pre_mono=%d,%lld.%09ld "
            "post_real=%d,%lld.%09ld post_mono=%d,%lld.%09ld post_gtod=%d,%lld.%06ld\n",
            pre_real_rc, (long long)pre_real.tv_sec, (long)pre_real.tv_nsec, pre_mono_rc,
            (long long)pre_mono.tv_sec, (long)pre_mono.tv_nsec, post_real_rc, (long long)post_real.tv_sec,
            (long)post_real.tv_nsec, post_mono_rc, (long long)post_mono.tv_sec, (long)post_mono.tv_nsec,
            post_gtod_rc, (long long)post_gtod.tv_sec, (long)post_gtod.tv_usec);
    if (fclose(output) != 0) return 9;
    return 0;
}
