/* Native-supervised checkpoint probe for the two kernel-state cells that have no
   external view at all -- `sigaltstack` and the interval timers -- plus the two
   adjacent timer flavours (POSIX timers, timerfd) whose observability is the
   open question.

   argv[1] is a fixed-width identity written into guest memory, so a report that
   carries the *captured* digits proves the memory image landed.
   argv[2] is a four-byte variant token; every token is the same byte length so
   each exec lays out an identical address space, which is exactly what the
   native restore's mapping-equality admission demands.

   The park is a bare `pause(2)` woken by a signal the HARNESS sends, not by an
   interval timer.  A fixture that parks with `alarm()` + `pause()` is woken by
   the *fresh* process's own timer and handler, so it proves nothing about what
   the image carried -- and it is itself an armed interval timer, which is the
   state under measurement.  A group-stop park (`tgkill(SIGSTOP)`) does not work
   either, and measurably so: the capture's own freeze sends SIGSTOP to a task
   that is already stopped, the signal is never dequeued, and the pending-signal
   gate then refuses the capture with verdict -6.  `syscall(SYS_pause)` rather
   than libc's `pause()` so that `/proc/<pid>/syscall` names syscall 34 exactly,
   which is how the harness proves the park is real before it captures. */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <setjmp.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/syscall.h>
#include <sys/time.h>
#include <sys/timerfd.h>
#include <time.h>
#include <unistd.h>

static char g_identity[32];
static char g_report[512];
static char g_altstack[65536];
/* Counts entries into `main`, in BSS, so it travels in the memory image.
 *
 * This is the discriminator between "the image carried the state" and "the fresh
 * exec of the same binary re-armed it on its own".  A restored process resumes at
 * the CAPTURED registers, which point inside `pause` -- past every line that arms
 * anything -- so it must report exactly the count the image carried.  If it ever
 * re-ran `main` it would increment the restored 1 to 2 and say so, and the arming
 * in its report would be its own rather than the image's. */
static volatile unsigned g_main_entries;
static void wake_noop(int signal) { (void)signal; }

/* The stack-overflow instrument.
 *
 * "The restored process has an alternate stack" is a weak claim; this is the strong one.  The guest
 * runs its own stack into the guard page and the kernel has to deliver SIGSEGV -- which it can only
 * do on an alternate stack, because there is no room left on the overflowing one.  A handler that
 * runs at all therefore proves the alternate stack is live, of a size the kernel accepted, and at an
 * address that is really mapped.  Without it the process dies on SIGSEGV instead of reporting.
 *
 * This is exactly the loss the refusal was put there to prevent: a Rust guest whose restore dropped
 * its alternate stack would run its stack-overflow handler on the overflowing stack. */
static sigjmp_buf g_overflow_return;
static volatile unsigned g_overflow_handled;
static volatile unsigned long g_overflow_depth;

static void overflow_handler(int signal) {
    (void)signal;
    ++g_overflow_handled;
    siglongjmp(g_overflow_return, 1);
}

/* Each call must really CONSUME STACK, which is a stronger requirement than "is recursive", and the
   weaker shape was measured failing here rather than reasoned about.  Written as
   `return pad[0] + recurse(depth + 1);` -- not a tail call, with the frame's address escaping
   through a volatile pointer -- gcc -O2 still applied its accumulator transform and flattened the
   whole thing into ONE frame: the guest spun at 100% CPU with a `[stack]` mapping that stayed at
   132 KiB and never overflowed, and the probe hung instead of measuring.

   What defeats the transform is a local that is live ACROSS the recursive call, so each level needs
   its own frame that outlives the call it makes.  The asm barrier holds `pad` after the return. */
static volatile char *g_overflow_frame;

static unsigned long recurse(unsigned long depth) {
    volatile char pad[4096];
    pad[0] = (char)depth;
    pad[sizeof pad - 1] = (char)depth;
    g_overflow_frame = pad;
    g_overflow_depth = depth;
    unsigned long deeper = recurse(depth + 1);
    __asm__ __volatile__("" : : "r"(&pad[0]) : "memory");
    return (unsigned long)pad[0] + deeper;
}

/* Counts the entries the kernel publishes in /proc/self/timers, which is the
   POSIX-timer view another process can also read.  Opened only after the park,
   so it is never a descriptor the capture has to admit. */
static int posix_timer_entries(void) {
    int fd = open("/proc/self/timers", O_RDONLY | O_CLOEXEC);
    if (fd < 0) return -1;
    char bytes[4096];
    ssize_t count = read(fd, bytes, sizeof bytes);
    close(fd);
    if (count < 0) return -1;
    int entries = 0;
    for (ssize_t index = 0; index + 4 <= count; ++index)
        if (memcmp(bytes + index, "ID: ", 4) == 0 && (index == 0 || bytes[index - 1] == '\n')) ++entries;
    return entries;
}

int main(int argc, char **argv) {
    ++g_main_entries;
    if (argc < 3) return 80;
    strncpy(g_identity, argv[1], sizeof(g_identity) - 1);
    if (strlen(argv[2]) != 4) return 81;
    const char *variant = argv[2];

    /* The park wake.  Installed identically in every variant, so the signal
       disposition bitmasks the restore compares are the same on both sides, and
       with sa_flags 0 so `pause` returns EINTR instead of being restarted. */
    struct sigaction wake_action;
    memset(&wake_action, 0, sizeof wake_action);
    wake_action.sa_handler = wake_noop;
    if (sigaction(SIGUSR1, &wake_action, NULL) != 0) return 92;

    /* Installed in EVERY variant, like the wake handler and for the same reason: the signal
       disposition bitmasks are part of the process-state record and the restore refuses a target
       whose masks differ, so a handler present in one variant and absent in another would make the
       capture and the restore target incomparable rather than testing anything.  SA_ONSTACK with no
       alternate stack armed is simply ignored by the kernel, so the free variant is unaffected. */
    struct sigaction overflow_action;
    memset(&overflow_action, 0, sizeof overflow_action);
    overflow_action.sa_handler = overflow_handler;
    overflow_action.sa_flags = SA_ONSTACK;
    if (sigaction(SIGSEGV, &overflow_action, NULL) != 0) return 97;

    int timer_fd = -1;
    if (strcmp(variant, "alts") == 0) {
        /* Rust's std shape, and the whole of it: an alternate signal stack and nothing else.  Traced
           on this host, a Rust-std process issues `sigaltstack(NULL, &old)` then
           `sigaltstack({ss_sp=..., ss_flags=0}, NULL)` at startup and no setitimer, alarm or
           timer_create at all, so this variant is what the narrowing actually refused. */
        stack_t alternate;
        memset(&alternate, 0, sizeof alternate);
        alternate.ss_sp = g_altstack;
        alternate.ss_size = sizeof g_altstack;
        if (sigaltstack(&alternate, NULL) != 0) return 82;
    } else if (strcmp(variant, "armd") == 0) {
        stack_t alternate;
        memset(&alternate, 0, sizeof alternate);
        alternate.ss_sp = g_altstack;
        alternate.ss_size = sizeof g_altstack;
        if (sigaltstack(&alternate, NULL) != 0) return 82;
        struct itimerval interval;
        memset(&interval, 0, sizeof interval);
        interval.it_value.tv_sec = 7200;
        if (setitimer(ITIMER_REAL, &interval, NULL) != 0) return 83;
    } else if (strcmp(variant, "posx") == 0) {
        struct sigevent event;
        memset(&event, 0, sizeof event);
        event.sigev_notify = SIGEV_SIGNAL;
        event.sigev_signo = SIGUSR2;
        timer_t timer = 0;
        if (timer_create(CLOCK_MONOTONIC, &event, &timer) != 0) return 84;
        struct itimerspec spec;
        memset(&spec, 0, sizeof spec);
        spec.it_value.tv_sec = 7200;
        if (timer_settime(timer, 0, &spec, NULL) != 0) return 85;
    } else if (strcmp(variant, "tfdt") == 0) {
        timer_fd = timerfd_create(CLOCK_MONOTONIC, TFD_CLOEXEC);
        if (timer_fd < 0) return 86;
        struct itimerspec spec;
        memset(&spec, 0, sizeof spec);
        spec.it_value.tv_sec = 7200;
        if (timerfd_settime(timer_fd, 0, &spec, NULL) != 0) return 87;
    } else if (strcmp(variant, "free") != 0) {
        return 88;
    }

    if (write(STDOUT_FILENO, "timerstate-ready\n", 17) != 17) return 89;
    if (syscall(SYS_pause) != -1) return 90;

    /* Resumed.  Everything below reads the LIVE task's kernel state; only
       `identity` comes from guest memory. */
    stack_t alternate;
    memset(&alternate, 0, sizeof alternate);
    (void)sigaltstack(NULL, &alternate);
    struct itimerval real_timer;
    memset(&real_timer, 0, sizeof real_timer);
    (void)getitimer(ITIMER_REAL, &real_timer);
    struct itimerspec fd_timer;
    memset(&fd_timer, 0, sizeof fd_timer);
    if (timer_fd >= 0) (void)timerfd_gettime(timer_fd, &fd_timer);

    int length = snprintf(g_report, sizeof g_report,
                          "timerstate identity=%s mains=%u altstack=%d realtimer=%d posix=%d timerfd=%d\n",
                          g_identity, g_main_entries,
                          (alternate.ss_flags & SS_DISABLE) == 0 && alternate.ss_sp != NULL,
                          real_timer.it_value.tv_sec != 0 || real_timer.it_value.tv_usec != 0,
                          posix_timer_entries(),
                          fd_timer.it_value.tv_sec != 0 || fd_timer.it_value.tv_nsec != 0);
    if (length <= 0 || write(STDOUT_FILENO, g_report, (size_t)length) != length) return 91;

    /* Only when the LIVE task really holds one -- a guest without an alternate stack that overflowed
       its own would simply die, which measures nothing.  Keyed on what the kernel just reported
       rather than on the variant, so a restored process runs it exactly when the image gave it a
       stack to run it on. */
    if ((alternate.ss_flags & SS_DISABLE) == 0 && alternate.ss_sp != NULL) {
        if (sigsetjmp(g_overflow_return, 1) == 0) (void)recurse(0);
        length = snprintf(g_report, sizeof g_report,
                          "timerstate-overflow handled=%u depth=%lu sp_is_image=%d size=%zu\n",
                          g_overflow_handled, g_overflow_depth, alternate.ss_sp == g_altstack,
                          alternate.ss_size);
        if (length <= 0 || write(STDOUT_FILENO, g_report, (size_t)length) != length) return 98;
    }

    /* Deliberately after the park.  On the restore arm this runs under the
       supervisor's RESTORE filter, and on a control run under the ordinary one,
       so the second line below is an executed statement that every syscall newly
       added to the notification set is still answered CONTINUE and still does
       exactly what the guest asked -- under each filter the supervisor builds. */
    stack_t late_stack;
    memset(&late_stack, 0, sizeof late_stack);
    late_stack.ss_sp = g_altstack;
    late_stack.ss_size = sizeof g_altstack;
    if (sigaltstack(&late_stack, NULL) != 0) return 93;
    struct itimerval late_interval;
    memset(&late_interval, 0, sizeof late_interval);
    late_interval.it_value.tv_sec = 1234;
    if (setitimer(ITIMER_REAL, &late_interval, NULL) != 0) return 94;
    /* Non-zero because the `setitimer` above really armed ITIMER_REAL: `alarm`
       returns the seconds left on the timer it replaces. */
    if (alarm(4321) == 0) return 95;
    stack_t late_seen;
    memset(&late_seen, 0, sizeof late_seen);
    (void)sigaltstack(NULL, &late_seen);
    struct itimerval late_seen_timer;
    memset(&late_seen_timer, 0, sizeof late_seen_timer);
    (void)getitimer(ITIMER_REAL, &late_seen_timer);
    /* Rounded up, as `alarm` itself reports remaining time: a timer armed for N
       seconds reads back as N-1 seconds plus a fraction the instant after. */
    length = snprintf(g_report, sizeof g_report, "timerstate-late altstack=%d realtimer=%ld\n",
                      (late_seen.ss_flags & SS_DISABLE) == 0 && late_seen.ss_sp == g_altstack,
                      (long)late_seen_timer.it_value.tv_sec + (late_seen_timer.it_value.tv_usec != 0));
    if (length <= 0 || write(STDOUT_FILENO, g_report, (size_t)length) != length) return 96;
    return 0;
}
