static int hl_native_supervised_selected(const hl_options *options) {
    const char *value = hl_options_get(options, "HL_NATIVE_SUPERVISED");
    return value != NULL && value[0] != 0 && strcmp(value, "0") != 0 && strcmp(value, "off") != 0;
}

#if defined(__linux__) && (defined(__x86_64__) || defined(__aarch64__))
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/futex.h>
#include <linux/seccomp.h>
#include <linux/capability.h>
#include <linux/sched.h>
#include <linux/openat2.h>
#include <linux/mount.h>
#include <sched.h>
#include <grp.h>
#include <poll.h>
#include <dirent.h>
#include <limits.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/ptrace.h>
#include <sys/personality.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <sys/statvfs.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <sys/uio.h>
#include <termios.h>
#include <net/if.h>

#define HL_NATIVE_TCGETS2 0x802c542aU
/* Numeric forms keep this header block self-contained: the guest ABI numbers are fixed by the
 * kernel UAPI and do not depend on which libc termios header happens to be reachable here. */
#define HL_NATIVE_TCSETS2 0x402c542bU
#define HL_NATIVE_TCSETSW2 0x402c542cU
#define HL_NATIVE_TCSETSF2 0x402c542dU
#define HL_NATIVE_FIONCLEX 0x5450U
#define HL_NATIVE_FIOCLEX 0x5451U
#define HL_NATIVE_FIOASYNC 0x5452U
#define HL_NATIVE_TCFLSH 0x540bU
#define HL_NATIVE_TIOCOUTQ 0x5411U
#define HL_NATIVE_TIOCMGET 0x5415U
#define HL_NATIVE_TIOCGSOFTCAR 0x5419U
#define HL_NATIVE_TIOCGETD 0x5424U
#define HL_NATIVE_TIOCGLCKTRMIOS 0x5456U
#define HL_NATIVE_TIOCSCTTY 0x540eU
#define HL_NATIVE_TIOCPKT 0x5420U
#define HL_NATIVE_TIOCGPTPEER 0x5441U

#if defined(__aarch64__)
#define HL_NATIVE_AUDIT_ARCH AUDIT_ARCH_AARCH64
#define HL_NATIVE_ISA_NAME "aarch64"
#else
#define HL_NATIVE_AUDIT_ARCH AUDIT_ARCH_X86_64
#define HL_NATIVE_ISA_NAME "x86_64"
#endif

static int hl_native_supervised_available(void) { return 1; }

uint64_t hl_linux_abi_constructed(void);
uint64_t hl_linux_abi_destroyed(void);

typedef struct {
    _Atomic int listener;
    _Atomic int target_pid;
    _Atomic int acknowledged;
    _Atomic int result_signal;
    _Atomic int projected_overlay;
    _Atomic int clone_stages;
#if defined(HL_NATIVE_TEST_HOOKS)
    _Atomic int listener_wakes;
#endif
    char projected_root[PATH_MAX];
} hl_native_supervised_bootstrap;

static int hl_native_supervised_listener_wait(hl_native_supervised_bootstrap *bootstrap, int leader_pidfd,
                                              const hl_options *options) {
    struct pollfd death = {leader_pidfd, POLLIN, 0};
#if defined(HL_NATIVE_TEST_HOOKS)
    const char *test = hl_options_get(options, "HL_NATIVE_SUPERVISED_REFUSE");
    if (test != NULL && strcmp(test, "994:38") == 0) usleep(10000);
#endif
    for (int attempt = 0; attempt < 5000; ++attempt) {
        int remote = atomic_load_explicit(&bootstrap->listener, memory_order_acquire);
        if (remote >= 0) {
#if defined(HL_NATIVE_TEST_HOOKS)
            if (test != NULL && (strcmp(test, "993:38") == 0 || strcmp(test, "994:38") == 0)) {
                int wake_receipt;
                for (int attempt = 0; attempt < 1000; ++attempt) {
                    wake_receipt = atomic_load_explicit(&bootstrap->listener_wakes, memory_order_acquire);
                    if (wake_receipt != 0) break;
                    sched_yield();
                }
                int expected = strcmp(test, "993:38") == 0 ? 2 : 1;
                if (wake_receipt != expected) return -1;
            }
#endif
            return (int)syscall(SYS_pidfd_getfd, leader_pidfd, remote, 0);
        }
        if (poll(&death, 1, 0) != 0) break;
        struct timespec timeout = {.tv_sec = 0, .tv_nsec = 1000000};
        int waited;
#if defined(HL_NATIVE_TEST_HOOKS)
        if (test != NULL && strcmp(test, "995:38") == 0 && attempt == 0) {
            errno = EINTR;
            waited = -1;
        } else
#endif
            waited = (int)syscall(SYS_futex, &bootstrap->listener, FUTEX_WAIT, -1, &timeout, NULL, 0);
        if (waited != 0 && errno != EAGAIN && errno != EINTR && errno != ETIMEDOUT) break;
    }
    return -1;
}

static void hl_native_supervised_projection_cleanup(hl_native_supervised_bootstrap *bootstrap) {
    if (bootstrap != NULL && atomic_load_explicit(&bootstrap->projected_overlay, memory_order_acquire)) {
        (void)rmdir(bootstrap->projected_root);
        char *separator = strrchr(bootstrap->projected_root, '/');
        if (separator != NULL) { *separator = 0; (void)rmdir(bootstrap->projected_root); }
    }
}

typedef struct {
    int source;
    int read_only;
    int directory;
    char guest[PATH_MAX];
} hl_native_supervised_volume;

typedef struct {
    hl_native_supervised_volume entries[32];
    size_t count;
} hl_native_supervised_volumes;

static int hl_native_supervised_write_text(const char *path, const char *text) {
    int fd = open(path, O_WRONLY | O_CLOEXEC);
    if (fd < 0) return -1;
    size_t length = strlen(text);
    int result = write(fd, text, length) == (ssize_t)length ? 0 : -1;
    close(fd);
    return result;
}

static int hl_native_supervised_write_process_text(pid_t process, const char *name, const char *text) {
    char path[64];
    if (snprintf(path, sizeof(path), "/proc/%d/%s", process, name) >= (int)sizeof(path)) return -1;
    return hl_native_supervised_write_text(path, text);
}

/* The descriptor every native-supervised guest is executed through, and therefore -- see the relocation
 * in `hl_native_supervised_run` -- the guest's task name.  Immediately above stdio: the exec'ing child
 * holds nothing else, and the descriptor is close-on-exec so the guest starts with 0..2 alone. */
#define HL_NATIVE_SUPERVISED_EXEC_DESCRIPTOR 3

static int hl_native_supervised_close_except(int keep) {
#ifdef SYS_close_range
    int first = keep > 3 ? (int)syscall(SYS_close_range, 3u, (unsigned int)keep - 1u, 0) : 0;
    int second = syscall(SYS_close_range, (unsigned int)keep + 1u, UINT_MAX, 0);
    if (first == 0 && second == 0) return 0;
    if (errno != ENOSYS && errno != EINVAL) return -1;
#endif
    DIR *directory = opendir("/proc/self/fd");
    if (directory == NULL) return -1;
    int scan = dirfd(directory);
    struct dirent *entry;
    while ((entry = readdir(directory)) != NULL) {
        char *end = NULL;
        long fd = strtol(entry->d_name, &end, 10);
        if (*entry->d_name == 0 || *end != 0 || fd < 3 || fd == keep || fd == scan) continue;
        close((int)fd);
    }
    return closedir(directory);
}

static int hl_native_supervised_guest_path_valid(const char *path) {
    if (path == NULL || path[0] != '/' || path[1] == 0) return 0;
    for (const char *part = path + 1; *part;) {
        const char *end = strchr(part, '/');
        size_t length = end == NULL ? strlen(part) : (size_t)(end - part);
        if (length == 0 || (length == 1 && part[0] == '.') ||
            (length == 2 && part[0] == '.' && part[1] == '.'))
            return 0;
        if (end == NULL) break;
        part = end + 1;
    }
    return 1;
}

static int hl_native_supervised_path_contains(const char *parent, const char *child) {
    size_t length = strlen(parent);
    return strncmp(parent, child, length) == 0 && (child[length] == 0 || child[length] == '/');
}

static int hl_native_supervised_volumes_open(const char *spec, hl_native_supervised_volumes *volumes) {
    memset(volumes, 0, sizeof(*volumes));
    if (spec == NULL) return 0;
    char *copy = strdup(spec);
    if (copy == NULL) return -1;
    char *save = NULL;
    for (char *record = strtok_r(copy, ",", &save); record != NULL; record = strtok_r(NULL, ",", &save)) {
        if (volumes->count == 32) goto failed;
        int read_only = 0;
        if (strncmp(record, "ro:", 3) == 0) { read_only = 1; record += 3; }
        else if (strncmp(record, "rw:", 3) == 0) record += 3;
        char *colon = strchr(record, ':');
        if (colon == NULL) goto failed;
        *colon++ = 0;
        if (!hl_native_supervised_guest_path_valid(record) || colon[0] != '/' || strchr(colon, ':') != NULL ||
            strlen(record) >= sizeof(volumes->entries[0].guest))
            goto failed;
        if (hl_native_supervised_path_contains("/proc", record)) goto failed;
        for (size_t index = 0; index < volumes->count; ++index)
            if (hl_native_supervised_path_contains(volumes->entries[index].guest, record) ||
                hl_native_supervised_path_contains(record, volumes->entries[index].guest))
                goto failed;
        int host_root = open("/", O_PATH | O_DIRECTORY | O_CLOEXEC);
        struct open_how source_how = {.flags = O_PATH | O_CLOEXEC,
                                      .resolve = RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_SYMLINKS};
        int source = host_root < 0 ? -1 : (int)syscall(SYS_openat2, host_root, colon + 1, &source_how, sizeof(source_how));
        if (host_root >= 0) close(host_root);
        if (source < 0) goto failed;
        struct stat source_status;
        if (fstat(source, &source_status) != 0 ||
            (!S_ISDIR(source_status.st_mode) && !S_ISREG(source_status.st_mode) &&
             !S_ISSOCK(source_status.st_mode))) {
            close(source);
            goto failed;
        }
        int mounted_source = source;
        if (S_ISDIR(source_status.st_mode)) {
            int tree = (int)syscall(SYS_open_tree, AT_FDCWD, colon,
                                    OPEN_TREE_CLONE | OPEN_TREE_CLOEXEC | AT_RECURSIVE);
            struct stat tree_status;
            if (tree < 0 || fstat(tree, &tree_status) != 0 ||
                source_status.st_dev != tree_status.st_dev || source_status.st_ino != tree_status.st_ino) {
                if (tree >= 0) close(tree);
                close(source);
                goto failed;
            }
            close(source);
            mounted_source = tree;
        }
        hl_native_supervised_volume *volume = &volumes->entries[volumes->count++];
        volume->source = mounted_source;
        volume->read_only = read_only;
        volume->directory = S_ISDIR(source_status.st_mode);
        strcpy(volume->guest, record);
    }
    free(copy);
    return 0;
failed:
    for (size_t index = 0; index < volumes->count; ++index) close(volumes->entries[index].source);
    free(copy);
    return -1;
}

static int hl_native_supervised_volumes_contains(const hl_native_supervised_volumes *volumes, const char *guest) {
    for (size_t index = 0; index < volumes->count; ++index)
        if (strcmp(volumes->entries[index].guest, guest) == 0) return 1;
    return 0;
}

/* Docker bind targets need not exist in an image. Create a mount point in the
 * private writable layer while walking beneath a pinned root descriptor; the
 * subsequent openat2 check still authenticates the exact target before mount. */
static int hl_native_supervised_volume_target_prepare(int root, const char *guest, int directory) {
    char *path = strdup(guest + 1);
    if (path == NULL) return -1;
    int parent = dup(root);
    if (parent < 0) { free(path); return -1; }
    char *part = path;
    for (;;) {
        char *slash = strchr(part, '/');
        if (slash != NULL) *slash = 0;
        int last = slash == NULL;
        int descriptor = -1;
        if (!last || directory) {
            descriptor = openat(parent, part, O_PATH | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
            if (descriptor < 0 && errno == ENOENT && mkdirat(parent, part, 0755) == 0)
                descriptor = openat(parent, part, O_PATH | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
        } else {
            descriptor = openat(parent, part, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0644);
            if (descriptor < 0 && errno == EEXIST)
                descriptor = openat(parent, part, O_PATH | O_CLOEXEC | O_NOFOLLOW);
        }
        if (descriptor < 0) { int saved = errno; close(parent); free(path); errno = saved; return -1; }
        close(parent);
        parent = descriptor;
        if (last) break;
        part = slash + 1;
    }
    close(parent);
    free(path);
    return 0;
}

static int hl_native_supervised_volumes_mount(const char *rootfs, const hl_native_supervised_volumes *volumes,
                                              const hl_options *options) {
    int root = open(rootfs, O_PATH | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (root < 0) return -1;
    for (size_t index = 0; index < volumes->count; ++index) {
        const hl_native_supervised_volume *volume = &volumes->entries[index];
        if (hl_native_supervised_volume_target_prepare(root, volume->guest, volume->directory) != 0) {
            close(root); return -1;
        }
        struct open_how how = {.flags = O_PATH | O_CLOEXEC | (volume->directory ? O_DIRECTORY : 0),
                               .resolve = RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_SYMLINKS};
        int target = (int)syscall(SYS_openat2, root, volume->guest + 1, &how, sizeof(how));
        if (target < 0) { close(root); return -1; }
        struct stat source_status, target_status;
        if (fstat(volume->source, &source_status) != 0 || fstat(target, &target_status) != 0 ||
            (volume->directory ? !S_ISDIR(target_status.st_mode) : !S_ISREG(target_status.st_mode))) {
            close(volume->source); close(target); close(root); errno = EINVAL; return -1;
        }
        int tree = volume->source;
        struct mount_attr attributes = {.attr_set = MOUNT_ATTR_NOSUID | MOUNT_ATTR_NODEV |
                                                     (volume->read_only ? MOUNT_ATTR_RDONLY : 0)};
        if (!volume->directory) {
            char source_path[64], target_path[PATH_MAX];
            struct statx source_key, target_key, path_key, mounted_key, tree_key;
            if (snprintf(source_path, sizeof source_path, "/proc/self/fd/%d", tree) >= (int)sizeof source_path ||
                snprintf(target_path, sizeof target_path, "%s%s", rootfs, volume->guest) >= (int)sizeof target_path ||
                syscall(SYS_statx, tree, "", AT_EMPTY_PATH, STATX_INO | STATX_MNT_ID, &source_key) != 0 ||
                syscall(SYS_statx, target, "", AT_EMPTY_PATH, STATX_INO | STATX_MNT_ID, &target_key) != 0) {
                close(tree); close(target); close(root); return -1;
            }
#if defined(HL_NATIVE_TEST_HOOKS)
            const char *test = hl_options_get(options, "HL_NATIVE_SUPERVISED_REFUSE");
            if (test != NULL && strcmp(test, "file-volume-target-swap") == 0) {
                char pinned_path[PATH_MAX], replacement_path[PATH_MAX];
                if (snprintf(pinned_path, sizeof pinned_path, "%s.pinned", target_path) >= (int)sizeof pinned_path ||
                    snprintf(replacement_path, sizeof replacement_path, "%s.swap", target_path) >=
                        (int)sizeof replacement_path ||
                    rename(target_path, pinned_path) != 0 || rename(replacement_path, target_path) != 0) {
                    close(tree); close(target); close(root); return -1;
                }
            }
#else
            (void)options;
#endif
            int path = open(target_path, O_PATH | O_CLOEXEC | O_NOFOLLOW);
            int stable = path >= 0 && syscall(SYS_statx, path, "", AT_EMPTY_PATH, STATX_INO | STATX_MNT_ID,
                                              &path_key) == 0 &&
                         path_key.stx_ino == target_key.stx_ino && path_key.stx_mnt_id == target_key.stx_mnt_id;
            if (path >= 0) close(path);
            if (!stable || mount(source_path, target_path, NULL, MS_BIND, NULL) != 0) {
                close(tree); close(target); close(root); errno = ESTALE; return -1;
            }
            int mounted = open(target_path, O_PATH | O_CLOEXEC | O_NOFOLLOW);
            int mounted_tree = (int)syscall(SYS_open_tree, AT_FDCWD, target_path, OPEN_TREE_CLOEXEC);
            struct stat mounted_status;
            int exact = mounted >= 0 && mounted_tree >= 0 && fstat(mounted, &mounted_status) == 0 &&
                        syscall(SYS_statx, mounted, "", AT_EMPTY_PATH, STATX_INO | STATX_MNT_ID, &mounted_key) == 0 &&
                        syscall(SYS_statx, mounted_tree, "", AT_EMPTY_PATH, STATX_INO | STATX_MNT_ID, &tree_key) == 0 &&
                        mounted_status.st_dev == source_status.st_dev && mounted_status.st_ino == source_status.st_ino &&
                        mounted_key.stx_ino == source_key.stx_ino && mounted_key.stx_mnt_id != target_key.stx_mnt_id &&
                        tree_key.stx_ino == mounted_key.stx_ino && tree_key.stx_mnt_id == mounted_key.stx_mnt_id &&
                        syscall(SYS_mount_setattr, mounted_tree, "", AT_EMPTY_PATH, &attributes, sizeof attributes) == 0;
            struct statvfs flags;
            if (exact && volume->read_only &&
                (statvfs(target_path, &flags) != 0 || (flags.f_flag & ST_RDONLY) == 0))
                exact = 0;
            if (mounted >= 0) close(mounted);
            if (mounted_tree >= 0) close(mounted_tree);
            close(tree); close(target);
            if (!exact) {
                int failure = errno != 0 ? errno : ESTALE;
                umount2(target_path, MNT_DETACH);
                close(root); errno = failure; return -1;
            }
            continue;
        }
        if (tree < 0 || syscall(SYS_mount_setattr, tree, "", AT_EMPTY_PATH | AT_RECURSIVE, &attributes, sizeof(attributes)) != 0 ||
            syscall(SYS_move_mount, tree, "", target, "", MOVE_MOUNT_F_EMPTY_PATH | MOVE_MOUNT_T_EMPTY_PATH) != 0) {
            if (tree >= 0) close(tree);
            close(target); close(root); return -1;
        }
        close(tree);
        close(target);
    }
    close(root);
    return 0;
}

/* Tri-state read. An option that is registered but explicitly set to "0" must read as OFF; spelling
 * this as `hl_options_get(...) != NULL` inverts the flag the moment it joins the tri-state table,
 * which is exactly how a prior integration shipped an always-on "default off" switch. */
static int hl_native_supervised_flag(const hl_options *options, const char *name) {
    const char *value = hl_options_get(options, name);
    return value != NULL && !(value[0] == '0' && value[1] == 0);
}

/* Project a private devpts so the guest can allocate its own ptys (tmux, script(1), openpty).
 * The prior study proved these failures are NOT an ioctl denial -- zero ioctl denials were recorded
 * and mounting a devpts on the host fixed the matched control -- but a missing filesystem: the bind
 * that projects the host terminal is non-recursive, so no devpts comes with it, and the guest cannot
 * mount one itself because SYS_mount is refused.  `newinstance` is what keeps this from widening
 * authority: the guest gets a private pty namespace whose indices and devices are its own and which
 * cannot name any pts belonging to the host or to another guest.  NOSUID|NOEXEC match the treatment
 * every other projected mount gets.  Gated on HL_NATIVE_SUPERVISED_PANE, default off. */
static int hl_native_supervised_devpts_mount(const char *rootfs) {
    char target[PATH_MAX], ptmx[PATH_MAX];
    if (snprintf(target, sizeof target, "%s/dev/pts", rootfs) >= (int)sizeof target ||
        snprintf(ptmx, sizeof ptmx, "%s/dev/ptmx", rootfs) >= (int)sizeof ptmx) return -1;
    if (mkdir(target, 0755) != 0 && errno != EEXIST) return -1;
    if (umount2(target, MNT_DETACH) != 0 && errno != EINVAL && errno != ENOENT) return -1;
    if (mount("devpts", target, "devpts", MS_NOSUID | MS_NOEXEC,
              "newinstance,ptmxmode=0666,mode=0620") != 0)
        return -1;
    /* /dev/ptmx must resolve into *this* instance; the symlink is how the multiplexer is bound to a
     * newinstance devpts (a stale /dev/ptmx chardev would reach the host's default instance). */
    struct stat status;
    if (lstat(ptmx, &status) == 0 && unlink(ptmx) != 0) return -1;
    if (symlink("pts/ptmx", ptmx) != 0) return -1;
    return 0;
}

static int hl_native_supervised_terminal_mount(const char *rootfs) {
    if (!isatty(STDIN_FILENO)) return 0;
    int root = open(rootfs, O_PATH | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    struct open_how how = {.flags = O_PATH | O_CLOEXEC,
                           .resolve = RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_SYMLINKS};
    int target = root < 0 ? -1 : (int)syscall(SYS_openat2, root, "dev/tty", &how, sizeof how);
    struct stat source_status, target_status, mounted_status;
    struct statx target_key, path_key, mounted_key;
    if (target < 0 || fstat(STDIN_FILENO, &source_status) != 0 || !S_ISCHR(source_status.st_mode) ||
        fstat(target, &target_status) != 0 || (!S_ISCHR(target_status.st_mode) && !S_ISREG(target_status.st_mode)) ||
        syscall(SYS_statx, target, "", AT_EMPTY_PATH, STATX_INO | STATX_MNT_ID, &target_key) != 0) {
        if (target >= 0) close(target);
        if (root >= 0) close(root);
        return -1;
    }
    if (S_ISCHR(target_status.st_mode)) {
        int canonical = target_status.st_rdev == makedev(5, 0);
        close(target); close(root);
        if (!canonical) errno = EPERM;
        return canonical ? 0 : -1;
    }
    char target_path[PATH_MAX];
    if (snprintf(target_path, sizeof target_path, "%s/dev/tty", rootfs) >= (int)sizeof target_path) {
        close(target); close(root); return -1;
    }
    int path = open(target_path, O_PATH | O_CLOEXEC | O_NOFOLLOW);
    int stable = path >= 0 && syscall(SYS_statx, path, "", AT_EMPTY_PATH, STATX_INO | STATX_MNT_ID, &path_key) == 0 &&
                 path_key.stx_ino == target_key.stx_ino && path_key.stx_mnt_id == target_key.stx_mnt_id;
    if (path >= 0) close(path);
    if (!stable) { close(target); close(root); errno = ESTALE; return -1; }
    int dev = (int)syscall(SYS_openat2, root, "dev", &how, sizeof how);
    struct stat before_replace;
    int replacement_ok = dev >= 0 && fstatat(dev, "tty", &before_replace, AT_SYMLINK_NOFOLLOW) == 0 &&
                         before_replace.st_dev == target_status.st_dev && before_replace.st_ino == target_status.st_ino &&
                         unlinkat(dev, "tty", 0) == 0 &&
                         mknodat(dev, "tty", S_IFCHR | 0600, makedev(5, 0)) == 0;
    if (dev >= 0) close(dev);
    if (!replacement_ok) { close(target); close(root); return -1; }
    int mounted = open(target_path, O_PATH | O_CLOEXEC | O_NOFOLLOW);
    int exact = mounted >= 0;
    if (exact && fstat(mounted, &mounted_status) != 0) exact = 0;
    if (exact && !S_ISCHR(mounted_status.st_mode)) { errno = ENODEV; exact = 0; }
    if (exact && mounted_status.st_rdev != makedev(5, 0)) {
        errno = EXDEV;
        exact = 0;
    }
    if (exact && (mounted_status.st_mode & 07777) != 0600) { errno = EPERM; exact = 0; }
    if (exact && syscall(SYS_statx, mounted, "", AT_EMPTY_PATH, STATX_INO | STATX_MNT_ID, &mounted_key) != 0) exact = 0;
    if (exact && mounted_key.stx_ino == target_key.stx_ino) { errno = ESTALE; exact = 0; }
    if (mounted >= 0) close(mounted);
    close(target); close(root);
    if (!exact) return -1;
    return 0;
}

static int hl_native_supervised_overlay_mount(const hl_engine_config *config, const hl_options *options,
                                              char target[PATH_MAX]) {
    const char *lower = config->box->lower_layers;
    const char *work = hl_options_get(options, "HL_OVERLAY_WORK");
    if (lower == NULL) {
        if (snprintf(target, PATH_MAX, "%s", config->rootfs) >= PATH_MAX) return -1;
        return 0;
    }
    if (work == NULL || strchr(lower, '\n') != NULL) return -1;
    if (snprintf(target, PATH_MAX, "/var/tmp/husklet-native-overlay.XXXXXX") >= PATH_MAX || mkdtemp(target) == NULL)
        return -1;
    size_t parent_length = strlen(target);
    if (parent_length + sizeof "/root" > PATH_MAX) { rmdir(target); return -1; }
    memcpy(target + parent_length, "/root", sizeof "/root");
    if (mkdir(target, 0700) != 0) { target[parent_length] = 0; rmdir(target); return -1; }
    int filesystem = (int)syscall(SYS_fsopen, "overlay", FSOPEN_CLOEXEC);
    int mounted = -1;
    if (filesystem >= 0 && syscall(SYS_fsconfig, filesystem, FSCONFIG_SET_STRING, "lowerdir", lower, 0) == 0 &&
        syscall(SYS_fsconfig, filesystem, FSCONFIG_SET_STRING, "upperdir", config->rootfs, 0) == 0 &&
        syscall(SYS_fsconfig, filesystem, FSCONFIG_SET_STRING, "workdir", work, 0) == 0 &&
        syscall(SYS_fsconfig, filesystem, FSCONFIG_SET_STRING, "index", "on", 0) == 0 &&
        syscall(SYS_fsconfig, filesystem, FSCONFIG_SET_STRING, "redirect_dir", "on", 0) == 0 &&
        syscall(SYS_fsconfig, filesystem, FSCONFIG_CMD_CREATE, NULL, NULL, 0) == 0) {
        int tree = (int)syscall(SYS_fsmount, filesystem, FSMOUNT_CLOEXEC, 0);
        int directory = open(target, O_PATH | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
        if (tree >= 0 && directory >= 0 &&
            syscall(SYS_move_mount, tree, "", directory, "", MOVE_MOUNT_F_EMPTY_PATH | MOVE_MOUNT_T_EMPTY_PATH) == 0)
            mounted = 0;
        if (directory >= 0) close(directory);
        if (tree >= 0) close(tree);
    }
    if (filesystem >= 0) close(filesystem);
    if (mounted != 0) {
        rmdir(target);
        target[parent_length] = 0;
        rmdir(target);
    }
    return mounted;
}

#include "native_overlay_projection.c"

#if defined(HL_NATIVE_TEST_HOOKS) && defined(HL_NATIVE_TEST_HOOK_EXPORT)
HL_API int hl_native_supervised_name_projection_test(uint32_t scenario) {
    if (scenario != 0) return 90;
    char root[] = "/var/tmp/husklet-name-projection.XXXXXX";
    if (mkdtemp(root) == NULL) return 91;
    char source_path[PATH_MAX], guest_path[PATH_MAX];
    int status = 0;
    if (snprintf(source_path, sizeof source_path, "%s/source", root) >= (int)sizeof source_path ||
        snprintf(guest_path, sizeof guest_path, "%s/guest", root) >= (int)sizeof guest_path)
        status = 92;
    int file = status == 0 ? open(source_path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600) : -1;
    if (status == 0 && file < 0) status = 93;
    if (file >= 0) close(file);
    /* Model the winner completing between the loser's source stat and destination check. */
    int root_fd = status == 0 ? open(root, O_PATH | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW) : -1;
    struct stat source_status, guest_status;
    if (status == 0 && (root_fd < 0 || fstatat(root_fd, "source", &source_status, AT_SYMLINK_NOFOLLOW) != 0)) status = 94;
    if (status == 0 && rename(source_path, guest_path) != 0) status = 95;
    if (status == 0 &&
        (fstatat(root_fd, "guest", &guest_status, AT_SYMLINK_NOFOLLOW) != 0 ||
         !hl_native_supervised_name_completed(root_fd, "source", &source_status, &guest_status)))
        status = 96;
    if (root_fd >= 0) close(root_fd);
    unlink(guest_path);
    rmdir(root);
    return status;
}
#endif

static int hl_native_supervised_id_compare(const void *left, const void *right) {
    uint32_t a = *(const uint32_t *)left, b = *(const uint32_t *)right;
    return a > b ? 1 : a < b ? -1 : 0;
}

static int hl_native_supervised_id_map(char *output, size_t capacity, uint32_t process_id, const char *records,
                                       int gid_column) {
    size_t count = 1, allocated = 16;
    uint32_t *ids = malloc(allocated * sizeof(*ids));
    char *copy = records == NULL ? NULL : strdup(records);
    if (ids == NULL || (records != NULL && copy == NULL)) { free(ids); free(copy); return -1; }
    ids[0] = process_id;
    char *save = NULL;
    for (char *record = copy == NULL ? NULL : strtok_r(copy, "\n", &save); record != NULL;
         record = strtok_r(NULL, "\n", &save)) {
        char *uid_text = strchr(record, '\t');
        char *gid_text = uid_text == NULL ? NULL : strchr(uid_text + 1, '\t');
        char *text = gid_column ? (gid_text == NULL ? NULL : gid_text + 1) : (uid_text == NULL ? NULL : uid_text + 1);
        char *end = NULL;
        unsigned long value = text == NULL ? ULONG_MAX : strtoul(text, &end, 10);
        if (!gid_column && gid_text != NULL) *gid_text = 0;
        if (text == NULL || *end != 0 || value > UINT_MAX) { free(ids); free(copy); return -1; }
        if (count == allocated) {
            allocated *= 2;
            uint32_t *grown = realloc(ids, allocated * sizeof(*ids));
            if (grown == NULL) { free(ids); free(copy); return -1; }
            ids = grown;
        }
        ids[count++] = (uint32_t)value;
    }
    qsort(ids, count, sizeof(*ids), hl_native_supervised_id_compare);
    size_t used = 0, extents = 0;
    for (size_t index = 0; index < count;) {
        uint32_t first = ids[index], last = first;
        while (++index < count && (ids[index] == last || (last != UINT_MAX && ids[index] == last + 1)))
            if (ids[index] != last) last = ids[index];
        int length = snprintf(output + used, capacity - used, "%u %u %llu\n", first, first,
                              (unsigned long long)last - first + 1);
        if (length <= 0 || (size_t)length >= capacity - used || ++extents > 340) {
            free(ids); free(copy); return -1;
        }
        used += (size_t)length;
    }
    free(ids); free(copy); return 0;
}

static const char *hl_native_supervised_policy_rejection(const hl_engine_config *config) {
    const hl_engine_box_config *box = config->box;
    if (geteuid() != 0 || getegid() != 0) return "host-root-required";
    if (config->rootfs == NULL || box == NULL) return "typed-box-and-rootfs-required";
    if (config->memory_limit != 0 || config->pid_limit != 0 || config->cpu_limit != 0) return "cgroup-limits";
    if (box->uid < -1 || box->gid < -1) return "identity";
    if (box->lower_layers != NULL && strchr(box->lower_layers, '\n') != NULL) return "multiple-lower-layers";
    if (box->publish_count != 0) return "published-network";
    if (box->network_interface_count != 0 || box->network_bridge != NULL || box->ip != NULL ||
        box->egress_proxy != NULL)
        return "bridged-network";
    /* The generation file invalidates the translated backend's user-space pathname caches after a
     * daemon-side write.  Native-supervised has no such cache: every lookup goes through the kernel
     * VFS, so retaining the typed field is semantics-preserving and requires no poll or mapping. */
    if (box->file_owners != NULL && box->lower_layers == NULL) return "ownership-without-overlay";
    if (box->checkpoint_mode != 0 || box->checkpoint_policy != 0) return "checkpoint";
    int isolated = (box->flags & HL_ENGINE_BOX_NETWORK_ISOLATED) != 0;
    if (box->network_mode == 2) {
        if (isolated || box->network_namespace != NULL) return "host-network-policy";
    } else if (box->network_mode == 0) {
        if (!isolated) return "bridged-network";
    } else {
        return "network-mode";
    }
    if ((box->flags & ~(HL_ENGINE_BOX_ROOTFS_READ_ONLY | HL_ENGINE_BOX_NETWORK_ISOLATED |
                        HL_ENGINE_BOX_TRANSLATION_CACHE_DISABLED | HL_ENGINE_BOX_SENTRY_ONLY)) != 0)
        return "box-flags";
    return NULL;
}

static int hl_native_supervised_loopback_up(void) {
    int socket_fd = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
    if (socket_fd < 0) return -1;
    struct ifreq request = {0};
    memcpy(request.ifr_name, "lo", 3);
    int result = ioctl(socket_fd, SIOCGIFFLAGS, &request);
    if (result == 0) {
        request.ifr_flags |= IFF_UP | IFF_RUNNING;
        result = ioctl(socket_fd, SIOCSIFFLAGS, &request);
    }
    int failure = errno;
    close(socket_fd);
    errno = failure;
    return result;
}

/* An isolated native guest owns a private UTS namespace but has no DNS path.
 * Keep its own hostname local, as the translated network does, without
 * modifying the image's identity file: bind a mode/owner-preserving copy over
 * the existing /etc/hosts only inside this mount namespace. */
static int hl_native_supervised_hostname_valid(const char *hostname) {
    size_t hostname_length = strlen(hostname);
    int valid_hostname = hostname_length > 0 && hostname_length <= HOST_NAME_MAX;
    for (size_t index = 0; valid_hostname && index < hostname_length; ++index) {
        unsigned char byte = (unsigned char)hostname[index];
        int alphanumeric = (byte >= 'a' && byte <= 'z') || (byte >= 'A' && byte <= 'Z') ||
                           (byte >= '0' && byte <= '9');
        if (!alphanumeric && byte != '-' && byte != '.') valid_hostname = 0;
        if (byte == '-' && (index == 0 || index + 1 == hostname_length || hostname[index - 1] == '.' ||
                            hostname[index + 1] == '.')) valid_hostname = 0;
        if (byte == '.' && (index == 0 || index + 1 == hostname_length || hostname[index - 1] == '.' ||
                            hostname[index - 1] == '-')) valid_hostname = 0;
    }
    return valid_hostname;
}

static int hl_native_supervised_open_hosts(const char *root) {
    int rootfd = open(root, O_PATH | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (rootfd < 0) return -1;
    struct open_how hosts_how = {
        .flags = O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK,
        .resolve = RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_SYMLINKS,
    };
    int input = (int)syscall(SYS_openat2, rootfd, "etc/hosts", &hosts_how, sizeof(hosts_how));
    int failure = errno;
    close(rootfd);
    errno = failure;
    return input;
}

static int hl_native_supervised_private_read_only_hosts(const char *root, const char *source, int pinned) {
    static const char prefix[] = "/var/tmp/husklet-native-overlay.";
    struct stat root_status, pinned_status, path_status, source_status, mounted_status;
    struct statx pinned_key, path_key, mounted_key, final_key;
    const char *separator = strchr(root + sizeof prefix - 1, '/');
    if (strncmp(root, prefix, sizeof prefix - 1) != 0 || separator == NULL || strcmp(separator, "/root") != 0)
        return -1;
    char parent[PATH_MAX];
    size_t parent_length = (size_t)(separator - root);
    if (parent_length >= sizeof parent) return -1;
    memcpy(parent, root, parent_length); parent[parent_length] = 0;
    if (lstat(parent, &root_status) != 0 || !S_ISDIR(root_status.st_mode) ||
        (root_status.st_mode & 07777) != 0700 || root_status.st_uid != geteuid() ||
        fstat(pinned, &pinned_status) != 0 || stat(source, &source_status) != 0 ||
        syscall(SYS_statx, pinned, "", AT_EMPTY_PATH, STATX_INO | STATX_MNT_ID, &pinned_key) != 0)
        return -1;
    char target[PATH_MAX];
    if (snprintf(target, sizeof target, "%s/etc/hosts", root) >= (int)sizeof target) return -1;
    int target_fd = open(target, O_PATH | O_CLOEXEC | O_NOFOLLOW);
    if (target_fd < 0 || fstat(target_fd, &path_status) != 0 ||
        syscall(SYS_statx, target_fd, "", AT_EMPTY_PATH, STATX_INO | STATX_MNT_ID, &path_key) != 0 ||
        path_status.st_dev != pinned_status.st_dev || path_status.st_ino != pinned_status.st_ino ||
        path_key.stx_ino != pinned_key.stx_ino || path_key.stx_mnt_id != pinned_key.stx_mnt_id) {
        if (target_fd >= 0) close(target_fd);
        errno = ESTALE;
        return -1;
    }
    close(target_fd);
    if (mount(source, target, NULL, MS_BIND, NULL) != 0) return -1;
    int tree = (int)syscall(SYS_open_tree, AT_FDCWD, target, OPEN_TREE_CLOEXEC);
    target_fd = open(target, O_PATH | O_CLOEXEC | O_NOFOLLOW);
    if (tree < 0 || target_fd < 0 || fstat(tree, &mounted_status) != 0 ||
        syscall(SYS_statx, tree, "", AT_EMPTY_PATH, STATX_INO | STATX_MNT_ID, &mounted_key) != 0 ||
        syscall(SYS_statx, target_fd, "", AT_EMPTY_PATH, STATX_INO | STATX_MNT_ID, &final_key) != 0 ||
        mounted_status.st_dev != source_status.st_dev || mounted_status.st_ino != source_status.st_ino ||
        mounted_key.stx_ino != final_key.stx_ino || mounted_key.stx_mnt_id != final_key.stx_mnt_id) {
        if (tree >= 0) close(tree);
        if (target_fd >= 0) close(target_fd);
        errno = ESTALE;
        return -1;
    }
    close(target_fd);
    struct mount_attr attributes = {.attr_set = MOUNT_ATTR_RDONLY};
    int exact = syscall(SYS_mount_setattr, tree, "", AT_EMPTY_PATH, &attributes, sizeof attributes) == 0;
    int failure = errno;
    struct statvfs flags;
    if (exact && (statvfs(target, &flags) != 0 || (flags.f_flag & ST_RDONLY) == 0)) {
        exact = 0;
        failure = errno != 0 ? errno : EROFS;
    }
    close(tree);
    if (!exact) { errno = failure; return -1; }
    return 0;
}

static int hl_native_supervised_project_hostname(const char *root, const char *hostname, int read_only,
                                                 int private_root) {
    char inherited[HOST_NAME_MAX + 1];
    if (hostname == NULL || hostname[0] == 0) {
        if (gethostname(inherited, HOST_NAME_MAX) != 0) return -1;
        inherited[HOST_NAME_MAX] = 0;
        hostname = inherited;
    }
    if (!hl_native_supervised_hostname_valid(hostname)) {
        errno = EINVAL;
        return -1;
    }
    int input = hl_native_supervised_open_hosts(root);
    if (input < 0 && errno == ENOENT) return 0;
    if (input < 0) return -1;
    struct stat metadata;
    if (fstat(input, &metadata) != 0 || !S_ISREG(metadata.st_mode)) {
        int failure = errno != 0 ? errno : EINVAL;
        close(input);
        errno = failure;
        return -1;
    }
    char pinned_target[64];
    if (snprintf(pinned_target, sizeof pinned_target, "/proc/self/fd/%d", input) >= (int)sizeof pinned_target) {
        close(input);
        errno = ENAMETOOLONG;
        return -1;
    }
    char temporary[] = "/var/tmp/husklet-native-hosts.XXXXXX";
    int output = mkstemp(temporary);
    if (output < 0) { close(input); return -1; }
    int exact = fchown(output, metadata.st_uid, metadata.st_gid) == 0 &&
                fchmod(output, metadata.st_mode & 07777) == 0;
    char *contents = malloc(1024u * 1024u + 1);
    if (contents == NULL) { close(input); close(output); unlink(temporary); return -1; }
    size_t total = 0;
    while (exact) {
        ssize_t count = read(input, contents + total, 1024u * 1024u + 1 - total);
        if (count < 0) { if (errno == EINTR) continue; exact = 0; break; }
        if (count == 0) break;
        total += (size_t)count;
        if (total > 1024u * 1024u) { errno = EFBIG; exact = 0; break; }
    }
    if (exact) {
        char record[HOST_NAME_MAX + 16];
        int length = snprintf(record, sizeof record, "127.0.1.1\t%s\n", hostname);
        exact = length > 0 && (size_t)length < sizeof record && write(output, record, (size_t)length) == length;
        if (!exact && errno == 0) errno = EINVAL;
    }
    size_t written = 0;
    while (exact && written < total) {
        ssize_t step = write(output, contents + written, total - written);
        if (step < 0 && errno == EINTR) continue;
        if (step <= 0) { exact = 0; break; }
        written += (size_t)step;
    }
    free(contents);
    int failure = errno;
    if (close(output) != 0 && exact) { exact = 0; failure = errno; }
    if (exact && !(read_only && private_root)) {
        /* Mount through the descriptor pinned above: pathname replacement cannot redirect the target. */
        exact = mount(temporary, pinned_target, NULL, MS_BIND, NULL) == 0;
        if (!exact) failure = errno;
    }
    if (exact && read_only) {
        exact = private_root ? hl_native_supervised_private_read_only_hosts(root, temporary, input) == 0
                             : mount(NULL, pinned_target, NULL, MS_BIND | MS_REMOUNT | MS_RDONLY, NULL) == 0;
        if (!exact) failure = errno;
    }
    close(input);
    (void)unlink(temporary);
    if (!exact) { errno = failure; return -1; }
    return 0;
}

#if defined(HL_NATIVE_TEST_HOOKS) && defined(HL_NATIVE_TEST_HOOK_EXPORT)
HL_API int hl_native_supervised_hostname_projection_test(uint32_t scenario) {
    static const char *const hostile[] = {"line\nbreak", "white space", "under_score", "control\001byte"};
    if (scenario == 4) {
        char root[] = "/var/tmp/husklet-hostname-root.XXXXXX";
        char outside[] = "/var/tmp/husklet-hostname-outside.XXXXXX";
        if (mkdtemp(root) == NULL || mkdtemp(outside) == NULL) return 97;
        char outside_hosts[PATH_MAX], etc[PATH_MAX];
        int status = 0;
        if (snprintf(outside_hosts, sizeof outside_hosts, "%s/hosts", outside) >= (int)sizeof outside_hosts ||
            snprintf(etc, sizeof etc, "%s/etc", root) >= (int)sizeof etc) status = 98;
        static const char original[] = "127.0.0.1\toutside\n";
        int descriptor = status == 0 ? open(outside_hosts, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0640) : -1;
        if (status == 0 && (descriptor < 0 || write(descriptor, original, sizeof original - 1) != sizeof original - 1 ||
                            close(descriptor) != 0 || symlink(outside, etc) != 0)) status = 99;
        errno = 0;
        if (status == 0 && hl_native_supervised_project_hostname(root, "builder", 0, 0) != -1) status = 100;
        char receipt[sizeof original] = {0};
        descriptor = status == 0 ? open(outside_hosts, O_RDONLY | O_CLOEXEC) : -1;
        if (status == 0 && (descriptor < 0 || read(descriptor, receipt, sizeof receipt) != sizeof original - 1 ||
                            memcmp(receipt, original, sizeof original) != 0)) status = 101;
        if (descriptor >= 0) close(descriptor);
        unlink(etc);
        unlink(outside_hosts);
        rmdir(root);
        rmdir(outside);
        return status;
    }
    if (scenario == 5) {
        char root[] = "/var/tmp/husklet-hostname-inroot.XXXXXX";
        if (mkdtemp(root) == NULL) return 102;
        char real_etc[PATH_MAX], hosts[PATH_MAX], etc[PATH_MAX];
        int status = 0;
        if (snprintf(real_etc, sizeof real_etc, "%s/real-etc", root) >= (int)sizeof real_etc ||
            snprintf(hosts, sizeof hosts, "%s/hosts", real_etc) >= (int)sizeof hosts ||
            snprintf(etc, sizeof etc, "%s/etc", root) >= (int)sizeof etc || mkdir(real_etc, 0700) != 0) status = 103;
        int descriptor = status == 0 ? open(hosts, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0640) : -1;
        if (status == 0 && (descriptor < 0 || write(descriptor, "hosts\n", 6) != 6 || close(descriptor) != 0 ||
                            symlink("real-etc", etc) != 0)) status = 104;
        errno = 0;
        descriptor = status == 0 ? hl_native_supervised_open_hosts(root) : -1;
        if (status == 0 && descriptor >= 0) status = 105;
        if (descriptor >= 0) close(descriptor);
        unlink(etc);
        unlink(hosts);
        rmdir(real_etc);
        rmdir(root);
        return status;
    }
    if (scenario >= sizeof hostile / sizeof hostile[0]) return 90;
    char root[] = "/var/tmp/husklet-hostname-hook.XXXXXX";
    if (mkdtemp(root) == NULL) return 91;
    char etc[PATH_MAX], hosts[PATH_MAX];
    int status = 0;
    if (snprintf(etc, sizeof etc, "%s/etc", root) >= (int)sizeof etc || mkdir(etc, 0700) != 0 ||
        snprintf(hosts, sizeof hosts, "%s/hosts", etc) >= (int)sizeof hosts) status = 92;
    int descriptor = status == 0 ? open(hosts, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0640) : -1;
    static const char original[] = "127.0.0.1\toriginal\n";
    if (status == 0 && (descriptor < 0 || write(descriptor, original, sizeof original - 1) != sizeof original - 1 ||
                        close(descriptor) != 0)) status = 93;
    if (status == 0 && hl_native_supervised_hostname_valid(hostile[scenario])) status = 96;
    errno = 0;
    if (status == 0 && (hl_native_supervised_project_hostname(root, hostile[scenario], 0, 0) != -1 || errno != EINVAL))
        status = 94;
    char receipt[sizeof original] = {0};
    descriptor = status == 0 ? open(hosts, O_RDONLY | O_CLOEXEC) : -1;
    if (status == 0 && (descriptor < 0 || read(descriptor, receipt, sizeof receipt) != sizeof original - 1 ||
                        memcmp(receipt, original, sizeof original) != 0)) status = 95;
    if (descriptor >= 0) close(descriptor);
    unlink(hosts);
    rmdir(etc);
    rmdir(root);
    return status;
}
#endif

static int hl_native_supervised_limit_resource(const char *name) {
    static const struct { const char *name; int resource; } resources[] = {
        {"cpu", RLIMIT_CPU}, {"fsize", RLIMIT_FSIZE}, {"data", RLIMIT_DATA}, {"stack", RLIMIT_STACK},
        {"core", RLIMIT_CORE}, {"rss", RLIMIT_RSS}, {"nproc", RLIMIT_NPROC}, {"nofile", RLIMIT_NOFILE},
        {"memlock", RLIMIT_MEMLOCK}, {"as", RLIMIT_AS}, {"locks", RLIMIT_LOCKS},
        {"sigpending", RLIMIT_SIGPENDING}, {"msgqueue", RLIMIT_MSGQUEUE}, {"nice", RLIMIT_NICE},
        {"rtprio", RLIMIT_RTPRIO}, {"rttime", RLIMIT_RTTIME}, {NULL, -1}};
    for (size_t index = 0; resources[index].name != NULL; ++index)
        if (strcmp(name, resources[index].name) == 0) return resources[index].resource;
    return -1;
}

static int hl_native_supervised_limit_value(const char *text, rlim_t *value) {
    if (strcmp(text, "unlimited") == 0 || strcmp(text, "-1") == 0) { *value = RLIM_INFINITY; return 0; }
    errno = 0;
    char *end = NULL;
    unsigned long long parsed = strtoull(text, &end, 10);
    if (errno != 0 || end == text || *end != 0 || (rlim_t)parsed != parsed) return -1;
    *value = (rlim_t)parsed;
    return 0;
}

static int hl_native_supervised_limits_apply(const char *spec) {
    if (spec == NULL) return 0;
    char *copy = strdup(spec);
    if (copy == NULL) return -1;
    char *save = NULL;
    for (char *record = strtok_r(copy, ",", &save); record != NULL; record = strtok_r(NULL, ",", &save)) {
        char *equals = strchr(record, '=');
        if (equals == NULL) { free(copy); return -1; }
        *equals++ = 0;
        int resource = hl_native_supervised_limit_resource(record);
        char *colon = strchr(equals, ':');
        if (colon != NULL) *colon++ = 0;
        struct rlimit limit;
        if (resource < 0 || hl_native_supervised_limit_value(equals, &limit.rlim_cur) != 0 ||
            (colon != NULL ? hl_native_supervised_limit_value(colon, &limit.rlim_max) :
                             (limit.rlim_max = limit.rlim_cur, 0)) != 0 ||
            limit.rlim_cur > limit.rlim_max || setrlimit(resource, &limit) != 0) {
            free(copy); return -1;
        }
    }
    free(copy);
    return 0;
}

static int hl_native_supervised_project_container(const hl_engine_config *config, const hl_options *options,
                                                  hl_native_supervised_bootstrap *bootstrap,
                                                  const hl_native_supervised_volumes *volumes, int mapping_fd,
                                                  const char *uid_map, const char *gid_map) {
    const hl_engine_box_config *box = config->box;
    if ((box->flags & HL_ENGINE_BOX_NETWORK_ISOLATED) != 0 && hl_native_supervised_loopback_up() != 0) return -1;
    if (mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL) != 0) return -1;
    char projected_root[PATH_MAX];
    if (hl_native_supervised_overlay_mount(config, options, projected_root) != 0) return -1;
    int projected_overlay = box->lower_layers != NULL;
    if (projected_overlay) {
        memcpy(bootstrap->projected_root, projected_root, strlen(projected_root) + 1);
        atomic_store_explicit(&bootstrap->projected_overlay, 1, memory_order_release);
    }
    int private_setup = projected_overlay &&
                        atomic_load_explicit(&bootstrap->listener, memory_order_acquire) == -1 &&
                        atomic_load_explicit(&bootstrap->target_pid, memory_order_acquire) == -1 &&
                        atomic_load_explicit(&bootstrap->acknowledged, memory_order_acquire) == 0 &&
                        atomic_load_explicit(&bootstrap->clone_stages, memory_order_acquire) == 1;
    if (projected_overlay && !private_setup) {
        if (hl_options_get(options, "HL_C_DIAGNOSTICS") != NULL)
            fprintf(stderr, "[hl-native-supervised]\tprojector_stage=private_setup errno=%d\n", errno);
        goto projection_failed;
    }
    int diagnostics = hl_options_get(options, "HL_C_DIAGNOSTICS") != NULL;
    if (hl_native_supervised_names_apply(projected_root, hl_options_get(options, "HL_FILE_NAMES"), diagnostics) != 0) {
        if (diagnostics)
            fprintf(stderr, "[hl-native-supervised]\tprojector_stage=names errno=%d\n", errno);
        goto projection_failed;
    }
    if (hl_native_supervised_owners_apply(projected_root, box->file_owners, diagnostics) != 0) {
        if (hl_options_get(options, "HL_C_DIAGNOSTICS") != NULL)
            fprintf(stderr, "[hl-native-supervised]\tprojector_stage=owners errno=%d\n", errno);
        goto projection_failed;
    }
    char byte;
    if (config->box->lower_layers == NULL && strcmp(projected_root, "/") != 0 &&
        mount(projected_root, projected_root, NULL, MS_BIND, NULL) != 0) return -1;
    if (hl_native_supervised_volumes_mount(projected_root, volumes, options) != 0) return -1;
    if (hl_native_supervised_terminal_mount(projected_root) != 0) return -1;
    if (hl_native_supervised_flag(options, "HL_NATIVE_SUPERVISED_PANE") &&
        hl_native_supervised_devpts_mount(projected_root) != 0) {
        if (diagnostics)
            fprintf(stderr, "[hl-native-supervised]\tprojector_stage=devpts errno=%d\n", errno);
        return -1;
    }
    if ((box->flags & HL_ENGINE_BOX_NETWORK_ISOLATED) != 0 &&
        !hl_native_supervised_volumes_contains(volumes, "/etc/hosts") &&
        hl_native_supervised_project_hostname(projected_root, box->hostname,
                                              (box->flags & HL_ENGINE_BOX_ROOTFS_READ_ONLY) != 0,
                                              private_setup) != 0)
        return -1;
    char proc_target[PATH_MAX];
    if (snprintf(proc_target, sizeof(proc_target), "%s%s", projected_root, "/proc") >= (int)sizeof(proc_target)) return -1;
    if (umount2(proc_target, MNT_DETACH) != 0 && errno != EINVAL && errno != ENOENT) return -1;
    if (mount("proc", proc_target, "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL) != 0) return -1;
    if ((box->flags & HL_ENGINE_BOX_ROOTFS_READ_ONLY) != 0 &&
        mount(NULL, projected_root, NULL, MS_BIND | MS_REMOUNT | MS_RDONLY, NULL) != 0)
        return -1;
    if (box->hostname != NULL && sethostname(box->hostname, strlen(box->hostname)) != 0) return -1;
    if (setgroups(0, NULL) != 0 || prctl(PR_SET_DUMPABLE, 1, 0, 0, 0) != 0 || unshare(CLONE_NEWUSER) != 0 ||
        (mapping_fd >= 0
             ? (write(mapping_fd, "1", 1) != 1 || read(mapping_fd, &byte, 1) != 1)
             : (hl_native_supervised_write_text("/proc/self/setgroups", "deny") != 0 ||
                hl_native_supervised_write_text("/proc/self/uid_map", uid_map) != 0 ||
                hl_native_supervised_write_text("/proc/self/gid_map", gid_map) != 0)) ||
        prctl(PR_SET_DUMPABLE, 1, 0, 0, 0) != 0)
        return -1;
    if (mapping_fd >= 0) close(mapping_fd);
    if (chroot(projected_root) != 0) return -1;
    if (chdir(box->working_directory == NULL ? "/" : box->working_directory) != 0) return -1;
    if (hl_native_supervised_limits_apply(box->limits) != 0) return -1;
    for (int capability = 0; capability <= CAP_LAST_CAP; ++capability)
        if (prctl(PR_CAPBSET_DROP, capability, 0, 0, 0) != 0) return -1;
    if (setresgid(box->gid < 0 ? 0 : box->gid, box->gid < 0 ? 0 : box->gid, box->gid < 0 ? 0 : box->gid) != 0 ||
        setresuid(box->uid < 0 ? 0 : box->uid, box->uid < 0 ? 0 : box->uid, box->uid < 0 ? 0 : box->uid) != 0)
        return -1;
    struct __user_cap_header_struct header = {_LINUX_CAPABILITY_VERSION_3, 0};
    struct __user_cap_data_struct data[2] = {{0}};
    if (syscall(SYS_capset, &header, data) != 0 || prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return -1;
    return 0;
projection_failed: {
        int failure = errno;
        if (projected_overlay) {
            (void)umount2(projected_root, MNT_DETACH);
            (void)rmdir(projected_root);
        }
        errno = failure;
        return -1;
    }
}

/* The one option in this file that widens what a capture will admit, and it is off unless asked for.
 *
 * Unset, everything below behaves exactly as it did: `sigaltstack` is notified, the domain is
 * tainted on the first arming call, and gate arm -7 refuses the capture.  Set, the supervisor stops
 * watching `sigaltstack` at all -- because the capture no longer needs to know that the guest
 * ASKED.  It reads the kernel's own answer instead, by injecting `sigaltstack(NULL, &old)` into the
 * frozen task and carrying what comes back, which is an observation of the live state rather than a
 * hypothesis about it.  The interval timers and POSIX timers keep tainting under both settings:
 * they arm an expiry that runs down afterwards, the kernel publishes no remaining value, and a
 * carry could only re-arm the original duration.  This option does not touch them.
 *
 * Disarming the notification is not an optimisation, it is a requirement -- and it is a requirement
 * for TWO independent reasons.  Only the first is about deadlock, and reading it as the whole story
 * is what makes this site dangerous to touch.
 *
 * Deadlock: the supervisor is blocked in the snapshot channel call for the whole capture, so a
 * `sigaltstack` notification raised by the INJECTED syscall would wait for an answer that cannot
 * come until the capture finishes -- and the capture cannot finish until the injected syscall
 * returns.
 *
 * The lift: the disarm, not the taint classifier, is what actually keeps gate arm -7 from refusing
 * the capture.  A disarmed syscall raises no notification, so the GUEST's own `sigaltstack` calls
 * never reach `hl_native_checkpoint_taints_state` and the taint is never set.  The carry arm inside
 * that classifier is therefore redundant under this option rather than load-bearing: forcing the
 * classifier to taint unconditionally leaves the flagship carry test green, because the classifier
 * is not on the path at all.  Both are kept -- the classifier arm states the rule for any caller
 * that does reach it -- but the redundancy runs one way only.  Reorder this disarm after the filter
 * is installed, or delete it in the belief that the classifier covers the lift, and the tests stay
 * green while the carry silently stops applying and every such capture is refused -7 again. */
static int hl_native_supervised_carry_altstack(const hl_options *options) {
    return hl_native_supervised_flag(options, "HL_NATIVE_CKPT_CARRY_ALTSTACK");
}

/* Turns one `HL_NATIVE_NOTIFY(number)` arm into a dead comparison, in place.
 *
 * The three programs below are C initialisers, so an arm cannot be compiled out per launch; this
 * rewrites the compared syscall number to one the kernel can never deliver, leaving the program
 * length, every jump offset and every other arm exactly as they were.  Matching the RET that
 * follows is what keeps it from disarming an unrelated comparison that happens to share a
 * constant. */
static void hl_native_supervised_disarm_notification(struct sock_filter *program, size_t count, int number) {
    for (size_t index = 0; index + 1 < count; ++index)
        if (program[index].code == (BPF_JMP | BPF_JEQ | BPF_K) && program[index].k == (unsigned int)number &&
            program[index + 1].code == (BPF_RET | BPF_K) && program[index + 1].k == SECCOMP_RET_USER_NOTIF)
            program[index].k = 0xFFFFFFFFu;
}

static int hl_native_supervised_create_listener(const hl_options *options) {
#define HL_NATIVE_NOTIFY(number) \
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (number), 0, 1), \
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_USER_NOTIF)
    struct sock_filter instructions[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, HL_NATIVE_AUDIT_ARCH, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
#ifdef SYS_open
        HL_NATIVE_NOTIFY(SYS_open),
#endif
        HL_NATIVE_NOTIFY(SYS_openat),
#ifdef SYS_creat
        HL_NATIVE_NOTIFY(SYS_creat),
#endif
#ifdef SYS_openat2
        HL_NATIVE_NOTIFY(SYS_openat2),
#endif
        HL_NATIVE_NOTIFY(SYS_execve), HL_NATIVE_NOTIFY(SYS_clone),
#ifdef SYS_fork
        HL_NATIVE_NOTIFY(SYS_fork),
#endif
#ifdef SYS_execveat
        HL_NATIVE_NOTIFY(SYS_execveat),
#endif
#ifdef SYS_clone3
        HL_NATIVE_NOTIFY(SYS_clone3),
#endif
#ifdef SYS_vfork
        HL_NATIVE_NOTIFY(SYS_vfork),
#endif
#ifdef SYS_unlink
        HL_NATIVE_NOTIFY(SYS_unlink),
#endif
        HL_NATIVE_NOTIFY(SYS_unlinkat),
#ifdef SYS_rename
        HL_NATIVE_NOTIFY(SYS_rename),
#endif
        HL_NATIVE_NOTIFY(SYS_renameat), HL_NATIVE_NOTIFY(SYS_renameat2),
#ifdef SYS_mkdir
        HL_NATIVE_NOTIFY(SYS_mkdir),
#endif
        HL_NATIVE_NOTIFY(SYS_mkdirat),
#ifdef SYS_rmdir
        HL_NATIVE_NOTIFY(SYS_rmdir),
#endif
#ifdef SYS_link
        HL_NATIVE_NOTIFY(SYS_link),
#endif
        HL_NATIVE_NOTIFY(SYS_linkat),
#ifdef SYS_symlink
        HL_NATIVE_NOTIFY(SYS_symlink),
#endif
        HL_NATIVE_NOTIFY(SYS_symlinkat),
#ifdef SYS_chmod
        HL_NATIVE_NOTIFY(SYS_chmod),
#endif
        HL_NATIVE_NOTIFY(SYS_fchmod), HL_NATIVE_NOTIFY(SYS_fchmodat),
#ifdef SYS_chown
        HL_NATIVE_NOTIFY(SYS_chown),
#endif
        HL_NATIVE_NOTIFY(SYS_fchown),
#ifdef SYS_lchown
        HL_NATIVE_NOTIFY(SYS_lchown),
#endif
        HL_NATIVE_NOTIFY(SYS_fchownat), HL_NATIVE_NOTIFY(SYS_truncate), HL_NATIVE_NOTIFY(SYS_ftruncate),
#ifdef SYS_mknod
        HL_NATIVE_NOTIFY(SYS_mknod),
#endif
        HL_NATIVE_NOTIFY(SYS_mknodat),
        HL_NATIVE_NOTIFY(SYS_mount), HL_NATIVE_NOTIFY(SYS_umount2), HL_NATIVE_NOTIFY(SYS_pivot_root),
        HL_NATIVE_NOTIFY(SYS_chroot), HL_NATIVE_NOTIFY(SYS_setns), HL_NATIVE_NOTIFY(SYS_unshare),
        HL_NATIVE_NOTIFY(SYS_socket), HL_NATIVE_NOTIFY(SYS_socketpair), HL_NATIVE_NOTIFY(SYS_connect),
        HL_NATIVE_NOTIFY(SYS_bind), HL_NATIVE_NOTIFY(SYS_listen), HL_NATIVE_NOTIFY(SYS_accept),
        HL_NATIVE_NOTIFY(SYS_accept4), HL_NATIVE_NOTIFY(SYS_ioctl), HL_NATIVE_NOTIFY(SYS_ptrace),
        HL_NATIVE_NOTIFY(SYS_seccomp), HL_NATIVE_NOTIFY(SYS_sendmsg),
        /* Internal refusal-test probe. Production policy otherwise lets identity reads stay native. */
        HL_NATIVE_NOTIFY(SYS_getpid),
        /* The kernel state no /proc scan can see.  These are notified only so the supervisor can
         * mark the domain before the syscall runs; every one of them is answered with CONTINUE by
         * the default arm below, so the guest's semantics are byte-for-byte unchanged and no
         * refusal, injection or argument rewrite is involved.  See the taint gate for why a
         * notification is the only observation point that exists for them. */
#ifdef SYS_sigaltstack
        HL_NATIVE_NOTIFY(SYS_sigaltstack),
#endif
#ifdef SYS_setitimer
        HL_NATIVE_NOTIFY(SYS_setitimer),
#endif
#ifdef SYS_alarm
        HL_NATIVE_NOTIFY(SYS_alarm),
#endif
#ifdef SYS_timer_create
        HL_NATIVE_NOTIFY(SYS_timer_create),
#endif
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
    struct sock_filter selective[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, HL_NATIVE_AUDIT_ARCH, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        HL_NATIVE_NOTIFY(SYS_clone),
#ifdef SYS_clone3
        HL_NATIVE_NOTIFY(SYS_clone3),
#endif
        HL_NATIVE_NOTIFY(SYS_ioctl), HL_NATIVE_NOTIFY(SYS_ptrace), HL_NATIVE_NOTIFY(SYS_seccomp),
        HL_NATIVE_NOTIFY(SYS_mount), HL_NATIVE_NOTIFY(SYS_umount2), HL_NATIVE_NOTIFY(SYS_pivot_root),
        HL_NATIVE_NOTIFY(SYS_chroot), HL_NATIVE_NOTIFY(SYS_setns), HL_NATIVE_NOTIFY(SYS_unshare),
        /* The kernel state no /proc scan can see.  These are notified only so the supervisor can
         * mark the domain before the syscall runs; every one of them is answered with CONTINUE by
         * the default arm below, so the guest's semantics are byte-for-byte unchanged and no
         * refusal, injection or argument rewrite is involved.  See the taint gate for why a
         * notification is the only observation point that exists for them. */
#ifdef SYS_sigaltstack
        HL_NATIVE_NOTIFY(SYS_sigaltstack),
#endif
#ifdef SYS_setitimer
        HL_NATIVE_NOTIFY(SYS_setitimer),
#endif
#ifdef SYS_alarm
        HL_NATIVE_NOTIFY(SYS_alarm),
#endif
#ifdef SYS_timer_create
        HL_NATIVE_NOTIFY(SYS_timer_create),
#endif
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
    struct sock_filter restore_selective[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, HL_NATIVE_AUDIT_ARCH, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        HL_NATIVE_NOTIFY(SYS_write), HL_NATIVE_NOTIFY(SYS_clone),
#ifdef SYS_clone3
        HL_NATIVE_NOTIFY(SYS_clone3),
#endif
        HL_NATIVE_NOTIFY(SYS_ioctl), HL_NATIVE_NOTIFY(SYS_ptrace), HL_NATIVE_NOTIFY(SYS_seccomp),
        HL_NATIVE_NOTIFY(SYS_mount), HL_NATIVE_NOTIFY(SYS_umount2), HL_NATIVE_NOTIFY(SYS_pivot_root),
        HL_NATIVE_NOTIFY(SYS_chroot), HL_NATIVE_NOTIFY(SYS_setns), HL_NATIVE_NOTIFY(SYS_unshare),
        /* The kernel state no /proc scan can see.  These are notified only so the supervisor can
         * mark the domain before the syscall runs; every one of them is answered with CONTINUE by
         * the default arm below, so the guest's semantics are byte-for-byte unchanged and no
         * refusal, injection or argument rewrite is involved.  See the taint gate for why a
         * notification is the only observation point that exists for them. */
#ifdef SYS_sigaltstack
        HL_NATIVE_NOTIFY(SYS_sigaltstack),
#endif
#ifdef SYS_setitimer
        HL_NATIVE_NOTIFY(SYS_setitimer),
#endif
#ifdef SYS_alarm
        HL_NATIVE_NOTIFY(SYS_alarm),
#endif
#ifdef SYS_timer_create
        HL_NATIVE_NOTIFY(SYS_timer_create),
#endif
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
#undef HL_NATIVE_NOTIFY
#ifdef SYS_sigaltstack
    if (hl_native_supervised_carry_altstack(options)) {
        hl_native_supervised_disarm_notification(instructions, sizeof instructions / sizeof instructions[0],
                                                 SYS_sigaltstack);
        hl_native_supervised_disarm_notification(selective, sizeof selective / sizeof selective[0],
                                                 SYS_sigaltstack);
        hl_native_supervised_disarm_notification(restore_selective,
                                                 sizeof restore_selective / sizeof restore_selective[0],
                                                 SYS_sigaltstack);
    }
#endif
    int refusal = hl_options_get(options, "HL_NATIVE_SUPERVISED_REFUSE") != NULL;
    int restore = hl_options_get(options, "HL_RESTORE") != NULL;
    struct sock_fprog program =
        refusal ? (struct sock_fprog){(unsigned short)(sizeof(instructions) / sizeof(instructions[0])), instructions}
        : restore ? (struct sock_fprog){(unsigned short)(sizeof(restore_selective) / sizeof(restore_selective[0])), restore_selective}
                  : (struct sock_fprog){(unsigned short)(sizeof(selective) / sizeof(selective[0])), selective};
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return -1;
    return (int)syscall(SYS_seccomp, SECCOMP_SET_MODE_FILTER, SECCOMP_FILTER_FLAG_NEW_LISTENER, &program);
}

static int hl_native_supervised_refusal(const hl_options *options, int *number, int *error) {
    const char *value = hl_options_get(options, "HL_NATIVE_SUPERVISED_REFUSE");
    *number = -1;
    *error = 0;
    if (value == NULL) return 0;
    char *end = NULL;
    long parsed_number = strtol(value, &end, 10);
    if (end == value || *end != ':') return -1;
    char *error_end = NULL;
    long parsed_error = strtol(end + 1, &error_end, 10);
    if (*error_end != 0 || parsed_number < 0 || parsed_number > INT_MAX ||
        (parsed_error != EPERM && parsed_error != ENOSYS)) return -1;
    *number = (int)parsed_number;
    *error = (int)parsed_error;
    return 0;
}

static int hl_native_supervised_denied(int number) {
    return number == SYS_ptrace || number == SYS_seccomp || number == SYS_mount ||
           number == SYS_umount2 || number == SYS_pivot_root || number == SYS_chroot || number == SYS_setns ||
           number == SYS_unshare;
}

static int hl_native_supervised_clone_namespaces(uint64_t flags) {
    const uint64_t namespaces = CLONE_NEWCGROUP | CLONE_NEWIPC | CLONE_NEWNET | CLONE_NEWNS |
                                CLONE_NEWPID | CLONE_NEWTIME | CLONE_NEWUSER | CLONE_NEWUTS;
    return (flags & namespaces) != 0;
}

/* FIOCLEX/FIONCLEX are exactly fcntl(F_SETFD, FD_CLOEXEC) on the same descriptor, and fcntl is not
 * in any of the three BPF programs above -- it falls through to SECCOMP_RET_ALLOW without even a
 * notification. Refusing the ioctl spelling while the fcntl spelling is unfiltered grants no safety;
 * it only breaks callers that use the ioctl form (CPython's _Py_set_inheritable is the live case).
 * These are therefore unconditional: closing an asymmetry, not widening authority. */
static int hl_native_supervised_ioctl_allowed(uint64_t request) {
    return request == TCGETS || request == TCSETS || request == TCSETSW || request == TCSETSF ||
           request == TIOCGWINSZ || request == TIOCSWINSZ || request == TIOCGPGRP || request == TIOCSPGRP ||
           request == TIOCGSID || request == HL_NATIVE_TCGETS2 || request == FIONREAD || request == FIONBIO ||
           request == TIOCGPTN || request == TIOCSPTLCK ||
           request == HL_NATIVE_FIOCLEX || request == HL_NATIVE_FIONCLEX;
}

/* Opt-in (HL_NATIVE_SUPERVISED_PANE) terminal surface. Every entry below acts only on the descriptor
 * the guest already holds; none names an object outside the guest and none can affect another
 * session's tty.  Deliberately absent and still refused: TIOCSTI (injects bytes into a tty's input
 * queue as if typed -- a container-escape primitive whenever the pty is shared with the host),
 * TIOCSETD and TIOCSLCKTRMIOS (change line discipline / lock termios, reaching the host's view of
 * the shared pts), TIOCCONS and TIOCLINUX, every VT_* and KD*, TUNSETIFF and the SIOCS* setters.
 * TIOCEXCL/TIOCNXCL are also withheld: the guest's stdin is the *host's* pty slave, so exclusive
 * mode would change whether the host can reopen it -- the one candidate that does reach outward. */
static int hl_native_supervised_ioctl_pane_allowed(uint64_t request) {
    return /* symmetric with TCGETS2, already allowed; same reach as TCSETS/W/F, already allowed */
           request == HL_NATIVE_TCSETS2 || request == HL_NATIVE_TCSETSW2 || request == HL_NATIVE_TCSETSF2 ||
           /* read-only scalars off the guest's own descriptor */
           request == HL_NATIVE_TIOCOUTQ || request == HL_NATIVE_TIOCMGET ||
           request == HL_NATIVE_TIOCGETD || request == HL_NATIVE_TIOCGSOFTCAR ||
           request == HL_NATIVE_TIOCGLCKTRMIOS ||
           /* discards buffered bytes on that descriptor's own queues and nothing else */
           request == HL_NATIVE_TCFLSH ||
           /* exactly fcntl(F_SETFL, O_ASYNC), which is unfiltered; SIGIO goes to the fd's own owner */
           request == HL_NATIVE_FIOASYNC;
}

/* Only meaningful once the projection carries a devpts: these name a pty the guest itself created. */
static int hl_native_supervised_ioctl_devpts_allowed(uint64_t request) {
    return request == HL_NATIVE_TIOCGPTPEER || request == HL_NATIVE_TIOCPKT;
}

static int hl_native_supervised_ioctl_permitted(uint64_t request, uint64_t argument, int pane) {
    if (hl_native_supervised_ioctl_allowed(request)) return 1;
    if (!pane) return 0;
    if (hl_native_supervised_ioctl_pane_allowed(request)) return 1;
    if (hl_native_supervised_ioctl_devpts_allowed(request)) return 1;
    /* TIOCSCTTY(0) can only claim a tty that currently has no session, so it can never steal one;
     * TIOCSCTTY(1) is the steal form and stays refused. The BPF program cannot see the argument --
     * the notify path can, which is the whole reason this split is enforced here and not there. */
    if (request == HL_NATIVE_TIOCSCTTY && argument == 0) return 1;
    return 0;
}

static int hl_native_supervised_single_child(pid_t parent, pid_t *child) {
    char path[64], bytes[128];
    if (snprintf(path, sizeof(path), "/proc/%d/task/%d/children", parent, parent) >= (int)sizeof(path)) return -1;
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return -1;
    ssize_t count = read(fd, bytes, sizeof(bytes) - 1);
    close(fd);
    if (count <= 0) return -1;
    bytes[count] = 0;
    char *end = NULL;
    long value = strtol(bytes, &end, 10);
    while (end != NULL && *end == ' ') ++end;
    if (value <= 0 || value > INT_MAX || end == NULL || *end != 0) return -1;
    *child = (pid_t)value;
    return 0;
}

/* Closed-world, read-only preflight for the native phase-1 coordinator.  Keeping
 * this separate from capture is intentional: an admitted process still receives
 * the existing freeze-only refusal below. */
static int hl_native_checkpoint_path(char *path, size_t capacity, const char *proc_root, pid_t process,
                                     const char *suffix) {
    return snprintf(path, capacity, "%s/%d/%s", proc_root, process, suffix) < (int)capacity ? 0 : -1;
}

static int hl_native_checkpoint_tasks_admissible(const char *proc_root, pid_t process) {
    char path[PATH_MAX];
    if (hl_native_checkpoint_path(path, sizeof path, proc_root, process, "task") != 0) return -1;
    DIR *tasks = opendir(path);
    if (tasks == NULL) return -1;
    size_t count = 0;
    struct dirent *entry;
    char sole[32] = {0};
    int scan_error = 0;
    for (;;) {
        errno = 0;
        entry = readdir(tasks);
        if (entry == NULL) { scan_error = errno; break; }
        char *end = NULL;
        long task = strtol(entry->d_name, &end, 10);
        if (*entry->d_name == 0 || *end != 0 || task <= 0 || task > INT_MAX) continue;
        ++count;
        if (count == 1) snprintf(sole, sizeof sole, "%ld", task);
    }
    closedir(tasks);
    if (scan_error != 0) return -1;
    if (count != 1 || strtol(sole, NULL, 10) != process) return -1;
    if (snprintf(path, sizeof path, "%s/%d/task/%s/children", proc_root, process, sole) >= (int)sizeof path)
        return -1;
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return -1;
    char children[128];
    ssize_t length = read(fd, children, sizeof children);
    close(fd);
    if (length < 0 || length == (ssize_t)sizeof children) return -1;
    for (ssize_t index = 0; index < length; ++index)
        if (children[index] != ' ' && children[index] != '\t' && children[index] != '\r' &&
            children[index] != '\n')
            return -1;
    return 0;
}

static int hl_native_checkpoint_fds_admissible(const char *proc_root, pid_t process,
                                                const int *private_fds, size_t private_count) {
    char path[PATH_MAX];
    if (hl_native_checkpoint_path(path, sizeof path, proc_root, process, "fd") != 0) return -1;
    DIR *fds = opendir(path);
    if (fds == NULL) return -1;
    int admissible = 1;
    struct dirent *entry;
    int scan_error = 0;
    while (admissible) {
        errno = 0;
        entry = readdir(fds);
        if (entry == NULL) { scan_error = errno; break; }
        char *end = NULL;
        long descriptor = strtol(entry->d_name, &end, 10);
        if (*entry->d_name == 0 || *end != 0) continue;
        if (descriptor < 0 || descriptor > INT_MAX) { admissible = 0; break; }
        if (descriptor <= STDERR_FILENO) continue;
        int recognized = 0;
        for (size_t index = 0; index < private_count; ++index)
            if (private_fds[index] == descriptor) { recognized = 1; break; }
        if (!recognized) admissible = 0;
    }
    if (scan_error != 0) admissible = 0;
    closedir(fds);
    return admissible ? 0 : -1;
}

static int hl_native_checkpoint_maps_admissible(const char *proc_root, pid_t process) {
    char path[PATH_MAX];
    if (hl_native_checkpoint_path(path, sizeof path, proc_root, process, "maps") != 0) return -1;
    FILE *maps = fopen(path, "re");
    if (maps == NULL) return -1;
    char *line = NULL;
    size_t capacity = 0;
    int admissible = 1;
    size_t rows = 0;
    while (admissible && getline(&line, &capacity, maps) >= 0) {
        ++rows;
        unsigned long long start, end, offset, inode;
        unsigned major, minor;
        char perms[5] = {0}, mapped[PATH_MAX] = {0};
        int fields = sscanf(line, "%llx-%llx %4s %llx %x:%x %llu %4095[^\n]",
                            &start, &end, perms, &offset, &major, &minor, &inode, mapped);
        (void)start; (void)end; (void)offset; (void)major; (void)minor; (void)inode;
        if (fields < 7 || strlen(perms) != 4 || perms[3] != 'p' || (perms[1] == 'w' && perms[2] == 'x')) {
            admissible = 0; break;
        }
        char *name = fields == 8 ? mapped : mapped + sizeof(mapped) - 1;
        while (*name == ' ' || *name == '\t') ++name;
        if (*name == 0) { if (perms[2] == 'x') admissible = 0; continue; }
        if (strstr(name, " (deleted)") != NULL) { admissible = 0; break; }
        if (name[0] == '[') {
            int kernel = strcmp(name, "[vdso]") == 0 || strcmp(name, "[vvar]") == 0 ||
                         strcmp(name, "[vvar_vclock]") == 0 || strcmp(name, "[vsyscall]") == 0;
            int anonymous = strcmp(name, "[heap]") == 0 || strncmp(name, "[stack", 6) == 0;
            if ((!kernel && !anonymous) || (anonymous && perms[2] == 'x')) admissible = 0;
            continue;
        }
        if (name[0] != '/') { admissible = 0; break; }
        char rooted[PATH_MAX];
        if (snprintf(rooted, sizeof rooted, "%s/%d/root%s", proc_root, process, name) >= (int)sizeof rooted) {
            admissible = 0; break;
        }
        struct stat status;
        /* Capture hashes each mapped byte range before publication and restore rechecks that digest.
         * Unix owner-write mode is not evidence that the stopped process or any other process changed
         * the file, and rejecting ordinary 0755 executables made this preflight refuse every real image. */
        if (stat(rooted, &status) != 0 || !S_ISREG(status.st_mode)) {
            admissible = 0;
        }
    }
    free(line);
    if (ferror(maps) || rows == 0) admissible = 0;
    fclose(maps);
    return admissible ? 0 : -1;
}

/* Per-descriptor lock attribution.
 *
 * The global /proc/locks table names an owner pid, and for two of the three advisory flavours that
 * pid is this process, so scanning the table catches them. It cannot catch the rest:
 *
 *   - An OFD lock (F_OFD_SETLK) belongs to the open file description, not to a process, so the
 *     kernel prints its owner as the literal -1. No pid comparison can ever match it.
 *   - flock() and OFD locks taken before a fork survive into the child through the shared open file
 *     description, but the table keeps naming whichever process originally took them.
 *
 * Both shapes leave a restored process believing it holds a lock it does not, which is silent guest
 * data corruption, so both must refuse. /proc/<pid>/fdinfo/<n> settles the attribution question the
 * table cannot: the kernel emits a "lock:" line there only for locks reachable through that very
 * descriptor, and it does so for every flavour (POSIX, FLOCK, OFDLCK, LEASE). A lock another process
 * holds on the same file never appears, which is exactly the distinction the gate needs.
 *
 * Presence of the line is the whole test -- no column is parsed and no type token is matched -- so
 * this stays correct across the kernel revisions that have reshuffled the table's columns, and a
 * future lock flavour is refused by default rather than admitted by omission.
 *
 * Descriptors the supervisor declared private are skipped. Those are the supervisor's own injected
 * descriptors, already excluded from the workload by the fd gate; the restored image never has them,
 * so a lock reachable through one is not a lock the guest can observe. */
static int hl_native_checkpoint_fd_locks_admissible(const char *proc_root, pid_t process,
                                                    const int *private_fds, size_t private_count) {
    char path[PATH_MAX], info_root[PATH_MAX];
    /* Enumerate the authoritative descriptor list and demand attribution for each one. Walking
     * fdinfo instead would make a descriptor whose fdinfo cannot be read simply invisible, which
     * turns a failed read into a silent admission. */
    if (hl_native_checkpoint_path(path, sizeof path, proc_root, process, "fd") != 0) return -1;
    if (hl_native_checkpoint_path(info_root, sizeof info_root, proc_root, process, "fdinfo") != 0)
        return -1;
    DIR *entries = opendir(path);
    if (entries == NULL) return -1;
    int admissible = 1;
    int scan_error = 0;
    struct dirent *entry;
    while (admissible) {
        errno = 0;
        entry = readdir(entries);
        if (entry == NULL) { scan_error = errno; break; }
        char *end = NULL;
        long descriptor = strtol(entry->d_name, &end, 10);
        if (*entry->d_name == 0 || *end != 0) continue;
        if (descriptor < 0 || descriptor > INT_MAX) { admissible = 0; break; }
        int private_descriptor = 0;
        for (size_t index = 0; index < private_count; ++index)
            if (private_fds[index] == descriptor) { private_descriptor = 1; break; }
        if (private_descriptor) continue;
        char info[PATH_MAX];
        if (snprintf(info, sizeof info, "%s/%ld", info_root, descriptor) >= (int)sizeof info) {
            admissible = 0; break;
        }
        FILE *stream = fopen(info, "re");
        if (stream == NULL) { admissible = 0; break; }
        char *line = NULL;
        size_t capacity = 0;
        while (getline(&line, &capacity, stream) >= 0)
            if (strncmp(line, "lock:", 5) == 0) { admissible = 0; break; }
        if (ferror(stream)) admissible = 0;
        free(line);
        fclose(stream);
    }
    if (scan_error != 0) admissible = 0;
    closedir(entries);
    return admissible ? 0 : -1;
}

static int hl_native_checkpoint_locks_admissible(const char *proc_root, pid_t process,
                                                 const int *private_fds, size_t private_count) {
    char path[PATH_MAX];
    if (snprintf(path, sizeof path, "%s/locks", proc_root) >= (int)sizeof path) return -1;
    FILE *locks = fopen(path, "re");
    if (locks == NULL) return -1;
    char *line = NULL;
    size_t capacity = 0;
    int admissible = 1;
    while (getline(&line, &capacity, locks) >= 0) {
        long owner = -1;
        int ordinary = sscanf(line, "%*s %*s %*s %*s %ld", &owner);
        int blocked = ordinary == 1 ? 0 : sscanf(line, "%*s -> %*s %*s %*s %ld", &owner);
        if (ordinary != 1 && blocked != 1) { admissible = 0; break; }
        if (owner == process) { admissible = 0; break; }
    }
    free(line);
    if (ferror(locks)) admissible = 0;
    fclose(locks);
    /* The table scan still runs first: it is the only view of a *blocked* lock request, which is
     * pending rather than held and so never reaches fdinfo. */
    if (!admissible) return -1;
    return hl_native_checkpoint_fd_locks_admissible(proc_root, process, private_fds, private_count);
}

/* Fifth gate: a process with queued signals. The NativeX86V1 image is a register record whose only
 * signal state is one u64 blocked mask (capture issues PTRACE_GETSIGMASK, restore PTRACE_SETSIGMASK)
 * plus memory objects, so there is nowhere for a pending queue to live. Measured, not inferred: a
 * fixture that blocked SIGUSR1 and SIGRTMIN and queued one SIGUSR1 (payload 0x77) and three SIGRTMIN
 * (payloads 0x11/0x22/0x33) parked with ShdPnd=0000000200000200; the image restored SigBlk intact at
 * 0000000200000200 but ShdPnd=0000000000000000, and unblocking in the restored process delivered none
 * of the four. The restored process therefore waits forever on signals that silently no longer exist.
 *
 * Capturing them is not obtainable from outside the process. PTRACE_GETSIGINFO reports only the signal
 * that caused the current ptrace-stop, no ptrace request enumerates a pending queue, and SigPnd/ShdPnd
 * are bitmasks carrying neither multiplicity nor siginfo -- three queued SIGRTMIN with distinct payloads
 * and one are the same bit. Draining the real queue requires injecting code that runs rt_sigtimedwait
 * inside the tracee, which both this read-only preflight and the refuse-before-mutation restore path
 * exclude by design, and which destroys the queue if capture then aborts. Restoring the bitmask alone
 * and re-raising would resume the process with the wrong signal count, a fabricated si_code and a
 * fabricated payload while appearing to have worked, so this refuses instead.
 *
 * Both fields are load-bearing: a process-directed sigqueue lands in ShdPnd, and SigPnd stayed zero
 * throughout the measurement above. Reading only SigPnd would have missed every signal that was lost. */
static int hl_native_checkpoint_signals_admissible(const char *proc_root, pid_t process) {
    char path[PATH_MAX];
    if (hl_native_checkpoint_path(path, sizeof path, proc_root, process, "status") != 0) return -1;
    FILE *status = fopen(path, "re");
    if (status == NULL) return -1;
    char *line = NULL;
    size_t capacity = 0;
    int admissible = 1;
    int seen = 0;
    while (admissible && getline(&line, &capacity, status) >= 0) {
        if (strncmp(line, "SigPnd:", 7) != 0 && strncmp(line, "ShdPnd:", 7) != 0) continue;
        const char *field = line + 7;
        while (*field == ' ' || *field == '\t') ++field;
        char *end = NULL;
        errno = 0;
        unsigned long long pending = strtoull(field, &end, 16);
        if (end == field || errno != 0) { admissible = 0; break; }
        while (*end == ' ' || *end == '\t' || *end == '\r') ++end;
        if (*end != '\n' && *end != 0) { admissible = 0; break; }
        ++seen;
        if (pending != 0) admissible = 0;
    }
    free(line);
    /* An unreadable, truncated or duplicated status refuses: this gate must never admit by default. */
    if (ferror(status) || seen != 2) admissible = 0;
    fclose(status);
    return admissible ? 0 : -1;
}

/* Sixth gate: state the kernel holds per process that NOTHING outside the process can see.
 *
 * `sigaltstack` and the interval timers are the two cells the /proc scan cannot reach at all.
 * Measured on this host: a process with `sigaltstack` registered reports `ss_sp=0x5d29b8a6d060` to
 * itself and a free one reports `(nil)`, and no entry of /proc/<pid> differs between them -- the
 * whole directory was enumerated.  With `ITIMER_REAL` armed at 7200 s the target reports
 * `realtimer=7199` to itself while `/proc/<pid>/stat` field 21 (`itrealvalue`) reads 0 in BOTH arms
 * and `/proc/<pid>/timers` is empty in both.  There is likewise no ptrace request that reads either
 * one, and no syscall that sets either one in another task, so they can be neither captured nor
 * compared nor reinstalled.
 *
 * Executed proof that this matters: an armed guest captured and restored into a free one reported
 * `altstack=0 realtimer=0` while the capture committed, the restore reported success and the guest
 * exited 0 -- with `identity=1111111111111111`, the CAPTURED argv digits, proving the memory image
 * did land.  The same restore into a target that armed them itself reported `altstack=1 realtimer=1`,
 * so the probe is not blind.
 *
 * What CAN be observed is the guest asking for them.  Every route to either one is a syscall, the
 * supervisor already owns a seccomp notification listener on this domain, and a notification is
 * delivered to the supervisor BEFORE the syscall runs.  So the domain is marked here, on receipt,
 * and the mark is sticky: once a guest has armed an alternate stack or an interval timer, no later
 * capture of that domain can honestly claim to carry it.
 *
 * The ordering is what makes this sound rather than approximate.  The taint is stored before the
 * notification is answered, and the syscall cannot take effect until it is answered, so any domain
 * whose state is actually armed was marked strictly earlier.  A notification that is still queued
 * when a capture runs belongs to a syscall that has not executed, so nothing is armed yet and
 * admitting is correct.  There is no window in which the state exists unmarked.
 *
 * Deliberately sticky, and deliberately not refined by reading the guest's argument buffers.  Stated
 * precisely, because the reason is narrower than "it would race": a `stack_t` or `struct itimerval`
 * lives in guest memory, and in a domain with more than one task a sibling can rewrite it between
 * the supervisor's read and the kernel's copy.  In the ONLY shape this gate can ever admit -- a
 * single task, which the topology arm demands -- the caller is blocked in the notification and no
 * such sibling exists, so a read there would in fact be sound if it were guarded with
 * SECCOMP_IOCTL_NOTIF_ID_VALID.  It is not done because this decision does not need it: the mark
 * only has to record THAT a call happened, and the scalar arguments the kernel already copied into
 * the notification settle the only cases worth skipping -- a NULL `new` pointer cannot arm anything,
 * and `alarm(0)` only cancels.  Reading the buffer would buy nothing here and would put a
 * guest-memory read on the supervisor's notification path.  It is, however, exactly the read a
 * future lane would need if it wanted to CARRY the alternate stack rather than refuse it.
 *
 * `timer_create` is in the set as well.  POSIX timers ARE externally visible -- `/proc/<pid>/timers`
 * lists them, measured -- and the arm below reads that file, but the taint covers the flavour
 * uniformly and covers a timer that was created and deleted, which the file no longer shows.
 *
 * What this costs, measured rather than assumed, because it narrows a path that previously reported
 * success.  Traced over each guest runtime available on this host, only Rust's std arms any of these
 * at startup: it issues `sigaltstack(NULL, &old)` (a pure query, which the argument test above
 * correctly ignores) and then `sigaltstack({ss_sp=..., ss_flags=0}, NULL)`, which arms and stays
 * armed for the process's whole life.  C against static or dynamic glibc, /bin/sh, busybox, python3
 * and node issue none of the four at all.  Go has no toolchain here and was not measured.  A parked
 * single-threaded Rust guest holding only stdio classifies 0 on every other arm, so this one is the
 * only thing that refuses it -- the narrowing is reachable, not masked.  What such a guest got
 * before was a committed capture and an exit-0 restore that dropped its SIGSEGV alternate stack, so
 * its stack-overflow handler would thereafter run on the overflowing stack.  This refusal replaces a
 * silent wrong restore, not a correct one.
 *
 * `timerfd_create` is NOT in the set and needs no arm: a timerfd is an ordinary descriptor, and the
 * descriptor gate already refuses every descriptor above 2 that the supervisor did not declare
 * private.  That refusal is asserted by execution rather than assumed. */
static _Atomic int hl_native_checkpoint_state_taint;
/* Set once per supervised domain, from the launch options, before the first notification is read.
 * It is the only thing that removes a flavour from the taint set, and it removes exactly one. */
static _Atomic int hl_native_checkpoint_carry_altstack;

static int hl_native_checkpoint_taints_state(int number, const __u64 *arguments) {
    switch (number) {
#ifdef SYS_sigaltstack
        /* A NULL `new` is a pure query and leaves the alternate stack exactly as it was.
         *
         * Under the carry option this flavour leaves the taint set entirely, and the reason is not
         * that it stopped mattering.  It is that the taint records that the guest ASKED, which is a
         * hypothesis about the kernel's state -- the notification is answered CONTINUE, so the
         * syscall's return value is never seen, and a `sigaltstack` that failed EFAULT, EINVAL or
         * EPERM leaves the OLD stack installed.  The capture replaces the hypothesis with the
         * kernel's own answer, so the record it keeps does not need this one. */
        case SYS_sigaltstack:
            return arguments[0] != 0 &&
                   !atomic_load_explicit(&hl_native_checkpoint_carry_altstack, memory_order_acquire);
#endif
#ifdef SYS_setitimer
        /* A NULL `new_value` cannot arm a timer; `getitimer` is a different number and is absent. */
        case SYS_setitimer: return arguments[1] != 0;
#endif
#ifdef SYS_alarm
        /* `alarm(0)` only cancels.  Anything that armed ITIMER_REAL earlier already tainted. */
        case SYS_alarm: return arguments[0] != 0;
#endif
#ifdef SYS_timer_create
        case SYS_timer_create: return 1;
#endif
        default: return 0;
    }
}

/* Seventh gate: POSIX interval timers, which unlike the two above DO have an external view.
 *
 * Measured: a process holding one armed `CLOCK_MONOTONIC` timer publishes
 * `ID: 0 / signal: 10/... / notify: signal/pid.<pid> / ClockID: 1` in /proc/<pid>/timers, and a free
 * process publishes nothing there.  Nothing in the image carries a timer id, its clock, its
 * expiry, its interval, its overrun count or its sigevent, and `timer_create` names no other
 * process, so a restore cannot rebuild one; this refuses instead.
 *
 * Presence of any entry is the whole test -- no field is parsed -- so a kernel that adds a column
 * does not change the verdict.
 *
 * A /proc that does not publish the file at all is NOT refused here, and that is a deliberate,
 * bounded exemption rather than an admission by omission: the taint arm above is the authority for
 * this flavour and covers it without reading any file, because every POSIX timer begins with a
 * `timer_create` the listener sees first.  This arm is the second, independent look. */
static int hl_native_checkpoint_timers_admissible(const char *proc_root, pid_t process) {
    char path[PATH_MAX];
    if (hl_native_checkpoint_path(path, sizeof path, proc_root, process, "timers") != 0) return -1;
    FILE *timers = fopen(path, "re");
    if (timers == NULL) return 0;
    char *line = NULL;
    size_t capacity = 0;
    int admissible = 1;
    while (getline(&line, &capacity, timers) >= 0)
        if (strncmp(line, "ID:", 3) == 0) { admissible = 0; break; }
    if (ferror(timers)) admissible = 0;
    free(line);
    fclose(timers);
    return admissible ? 0 : -1;
}

#if defined(HL_NATIVE_TEST_HOOKS)
static _Atomic int hl_native_checkpoint_test_scan_stopped;
static int hl_native_checkpoint_test_observe_stop;
static int hl_native_checkpoint_test_race_command = -1;
static int hl_native_checkpoint_test_race_reply = -1;
static pid_t hl_native_checkpoint_test_kill_after_stop = -1;
static int hl_native_supervised_stopped(pid_t process);
#endif

/* One name per gate arm, so a refusal says which domain rejected it rather than only that something
 * did.  The numbers are the admission verdicts and are part of the diagnostic contract. */
static const char *hl_native_checkpoint_refusal_domain(int verdict) {
    switch (verdict) {
        case -2: return "task-topology";
        case -3: return "descriptor";
        case -4: return "mapping";
        case -5: return "file-lock";
        case -6: return "pending-signal";
        case -7: return "unobservable-timer-or-altstack";
        case -8: return "posix-timer";
        default: return "unspecified";
    }
}

static int hl_native_checkpoint_admissible_at(const char *proc_root, pid_t process,
                                              const int *private_fds, size_t private_count) {
#if defined(HL_NATIVE_TEST_HOOKS)
    if (hl_native_checkpoint_test_observe_stop && strcmp(proc_root, "/proc") == 0)
        atomic_store_explicit(&hl_native_checkpoint_test_scan_stopped,
                              hl_native_supervised_stopped(process), memory_order_release);
#endif
    if (process <= 0 || hl_native_checkpoint_tasks_admissible(proc_root, process) != 0) return -2;
    if (hl_native_checkpoint_fds_admissible(proc_root, process, private_fds, private_count) != 0) return -3;
    if (hl_native_checkpoint_maps_admissible(proc_root, process) != 0) return -4;
    if (hl_native_checkpoint_locks_admissible(proc_root, process, private_fds, private_count) != 0) return -5;
    if (hl_native_checkpoint_signals_admissible(proc_root, process) != 0) return -6;
    if (atomic_load_explicit(&hl_native_checkpoint_state_taint, memory_order_acquire)) return -7;
    if (hl_native_checkpoint_timers_admissible(proc_root, process) != 0) return -8;
    return 0;
}

#if defined(HL_NATIVE_TEST_HOOKS) && defined(HL_NATIVE_TEST_HOOK_EXPORT)
static int hl_native_checkpoint_phase1_test(void);
static int hl_native_checkpoint_empty_fds_test(void);
static int hl_native_checkpoint_domain_freeze_test(void);
static int hl_native_checkpoint_taint_test(void);
static int hl_native_checkpoint_disarm_test(void);
static int hl_native_checkpoint_taint_set_test(int marked);
HL_API int hl_native_checkpoint_admission_test(const char *proc_root, int process,
                                               const int *private_fds, size_t private_count) {
    if (proc_root == NULL || (private_count != 0 && private_fds == NULL)) return -1;
    if (strcmp(proc_root, "phase1:test") == 0) return hl_native_checkpoint_phase1_test();
    if (strcmp(proc_root, "empty-fds:test") == 0) return hl_native_checkpoint_empty_fds_test();
    if (strcmp(proc_root, "domain-freeze:test") == 0) return hl_native_checkpoint_domain_freeze_test();
    if (strcmp(proc_root, "taint:test") == 0) return hl_native_checkpoint_taint_test();
    if (strcmp(proc_root, "disarm:test") == 0) return hl_native_checkpoint_disarm_test();
    if (strcmp(proc_root, "taint:set") == 0) return hl_native_checkpoint_taint_set_test(1);
    if (strcmp(proc_root, "taint:clear") == 0) return hl_native_checkpoint_taint_set_test(0);
    return hl_native_checkpoint_admissible_at(proc_root, (pid_t)process, private_fds, private_count);
}
#endif

static int hl_native_supervised_stopped(pid_t process) {
    char path[64], bytes[256];
    if (snprintf(path, sizeof(path), "/proc/%d/status", process) >= (int)sizeof(path)) return 0;
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return 0;
    ssize_t count = read(fd, bytes, sizeof(bytes) - 1);
    close(fd);
    if (count <= 0) return 0;
    bytes[count] = 0;
    char *state = strstr(bytes, "\nState:\t");
    return state != NULL && (state[8] == 'T' || state[8] == 't');
}

#define HL_NATIVE_CHECKPOINT_MEMBER_MAX 4096

typedef struct {
    pid_t pid;
    int pidfd;
    int was_stopped;
} hl_native_checkpoint_member;

typedef struct {
    hl_native_checkpoint_member members[HL_NATIVE_CHECKPOINT_MEMBER_MAX];
    size_t count;
} hl_native_checkpoint_domain;

static void hl_native_checkpoint_domain_close(hl_native_checkpoint_domain *domain) {
    for (size_t index = 0; index < domain->count; ++index) {
        if (domain->members[index].pidfd >= 0) close(domain->members[index].pidfd);
        domain->members[index].pidfd = -1;
    }
    domain->count = 0;
}

static ssize_t hl_native_checkpoint_domain_find(const hl_native_checkpoint_domain *domain, pid_t pid) {
    for (size_t index = 0; index < domain->count; ++index)
        if (domain->members[index].pid == pid) return (ssize_t)index;
    return -1;
}

/* Open the capability before retaining the numeric name. Every later signal uses the pidfd, so an exit
 * followed by reuse can only make the operation fail; it can never stop or resume the replacement. */
static int hl_native_checkpoint_domain_add(hl_native_checkpoint_domain *domain, pid_t pid) {
    if (pid <= 0 || hl_native_checkpoint_domain_find(domain, pid) >= 0) return pid > 0 ? 0 : -1;
    if (domain->count == HL_NATIVE_CHECKPOINT_MEMBER_MAX) return -1;
    int pidfd = (int)syscall(SYS_pidfd_open, pid, 0u);
    if (pidfd < 0) return -1;
    hl_native_checkpoint_member *member = &domain->members[domain->count++];
    member->pid = pid;
    member->pidfd = pidfd;
    member->was_stopped = hl_native_supervised_stopped(pid);
    return 0;
}

/* Enumerate every process below one native-supervised workload. Children is per task, not per process:
 * walking only task/<tgid>/children misses a fork performed by another thread. Clone/fork/vfork are held
 * in the seccomp listener while this runs; the second scan catches a syscall that was continued just
 * before the generation trigger won the listener. */
static int hl_native_checkpoint_domain_collect(pid_t root, hl_native_checkpoint_domain *domain) {
    memset(domain, 0, sizeof(*domain));
    if (hl_native_checkpoint_domain_add(domain, root) != 0) return -1;
    for (size_t process_index = 0; process_index < domain->count; ++process_index) {
        pid_t process = domain->members[process_index].pid;
        char task_path[64];
        if (snprintf(task_path, sizeof task_path, "/proc/%d/task", process) >= (int)sizeof task_path) goto failed;
        DIR *tasks = opendir(task_path);
        if (tasks == NULL) goto failed;
        int scan_failed = 0;
        for (;;) {
            errno = 0;
            struct dirent *task = readdir(tasks);
            if (task == NULL) { scan_failed = errno != 0; break; }
            char *end = NULL;
            long tid = strtol(task->d_name, &end, 10);
            if (task->d_name[0] == 0 || end == NULL || *end != 0 || tid <= 0 || tid > INT_MAX) continue;
            char children_path[96];
            if (snprintf(children_path, sizeof children_path, "/proc/%d/task/%ld/children", process, tid) >=
                (int)sizeof children_path) {
                closedir(tasks); goto failed;
            }
            FILE *children = fopen(children_path, "re");
            if (children == NULL) { closedir(tasks); goto failed; }
            long child;
            while (fscanf(children, "%ld", &child) == 1) {
                if (child <= 0 || child > INT_MAX ||
                    hl_native_checkpoint_domain_add(domain, (pid_t)child) != 0) {
                    fclose(children); closedir(tasks); goto failed;
                }
            }
            int read_failed = ferror(children);
            fclose(children);
            if (read_failed) { closedir(tasks); goto failed; }
        }
        if (closedir(tasks) != 0 || scan_failed) goto failed;
    }
    return 0;
failed:
    hl_native_checkpoint_domain_close(domain);
    return -1;
}

static int hl_native_checkpoint_member_signal(const hl_native_checkpoint_member *member, int signal) {
    return (int)syscall(SYS_pidfd_send_signal, member->pidfd, signal, NULL, 0);
}

static int hl_native_checkpoint_domain_stop(hl_native_checkpoint_domain *domain) {
    for (size_t index = 0; index < domain->count; ++index)
        if (hl_native_checkpoint_member_signal(&domain->members[index], SIGSTOP) != 0) return -1;
    for (int attempt = 0; attempt < 1000; ++attempt) {
        int stopped = 1;
        for (size_t index = 0; index < domain->count; ++index) {
            if (hl_native_checkpoint_member_signal(&domain->members[index], 0) != 0 ||
                !hl_native_supervised_stopped(domain->members[index].pid)) {
                stopped = 0; break;
            }
        }
        if (stopped) return 0;
        usleep(1000);
    }
    return -1;
}

/* Resume only processes this ledger moved into the stopped state. ESRCH is success for rollback: the
 * pidfd proves that exact incarnation is gone, and in particular prevents a reused numeric pid from being
 * resumed. Every other failure is retained even while rollback continues over the rest of the domain. */
static int hl_native_checkpoint_domain_thaw(hl_native_checkpoint_domain *domain) {
    int result = 0;
    for (size_t index = domain->count; index > 0; --index) {
        hl_native_checkpoint_member *member = &domain->members[index - 1];
        if (!member->was_stopped && hl_native_checkpoint_member_signal(member, SIGCONT) != 0 && errno != ESRCH)
            result = -1;
    }
    return result;
}

static int hl_native_checkpoint_domain_same(const hl_native_checkpoint_domain *left,
                                            const hl_native_checkpoint_domain *right) {
    if (left->count != right->count) return 0;
    for (size_t index = 0; index < left->count; ++index) {
        ssize_t other = hl_native_checkpoint_domain_find(right, left->members[index].pid);
        if (other < 0 || hl_native_checkpoint_member_signal(&left->members[index], 0) != 0 ||
            hl_native_checkpoint_member_signal(&right->members[other], 0) != 0 ||
            !hl_native_supervised_stopped(left->members[index].pid))
            return 0;
    }
    return 1;
}

/* Preserve newly discovered incarnations in the rollback ledger before refusing. They are stopped as
 * well: a racing child must not keep running while its parent and siblings are rolled back. */
static int hl_native_checkpoint_domain_merge(hl_native_checkpoint_domain *ledger,
                                             hl_native_checkpoint_domain *observed) {
    for (size_t index = 0; index < observed->count; ++index) {
        hl_native_checkpoint_member *member = &observed->members[index];
        if (hl_native_checkpoint_domain_find(ledger, member->pid) >= 0) continue;
        if (ledger->count == HL_NATIVE_CHECKPOINT_MEMBER_MAX) return -1;
        ledger->members[ledger->count++] = *member;
        member->pidfd = -1;
    }
    return 0;
}

/* 0 is a sealed and wholly stopped inventory; 1 is a topology race; -1 is any other refusal. On every
 * return the ledger owns all capabilities acquired so far and the caller must thaw then close it. */
static int hl_native_checkpoint_domain_freeze(pid_t root, hl_native_checkpoint_domain *ledger) {
    hl_native_checkpoint_domain observed = {0};
    if (hl_native_checkpoint_domain_collect(root, ledger) != 0) return -1;
#if defined(HL_NATIVE_TEST_HOOKS)
    if (hl_native_checkpoint_test_race_command >= 0) {
        unsigned char command = 1;
        pid_t raced = -1;
        if (write(hl_native_checkpoint_test_race_command, &command, 1) != 1 ||
            read(hl_native_checkpoint_test_race_reply, &raced, sizeof(raced)) != (ssize_t)sizeof(raced))
            return -1;
    }
#endif
    if (hl_native_checkpoint_domain_stop(ledger) != 0) return -1;
#if defined(HL_NATIVE_TEST_HOOKS)
    if (hl_native_checkpoint_test_kill_after_stop > 0) {
        (void)kill(hl_native_checkpoint_test_kill_after_stop, SIGKILL);
        usleep(10000);
    }
#endif
    if (hl_native_checkpoint_domain_collect(root, &observed) != 0) return -1;
    int same = hl_native_checkpoint_domain_same(ledger, &observed);
    if (!same) {
        int merged = hl_native_checkpoint_domain_merge(ledger, &observed);
        hl_native_checkpoint_domain_close(&observed);
        if (merged != 0 || hl_native_checkpoint_domain_stop(ledger) != 0) return -1;
        return 1;
    }
    hl_native_checkpoint_domain_close(&observed);
    return 0;
}

static int hl_native_supervised_checkpoint_phase1(pid_t workload, uint32_t generation, const hl_options *options) {
    hl_native_checkpoint_domain domain = {0};
    int freeze = workload > 0 ? hl_native_checkpoint_domain_freeze(workload, &domain) : -1;
    int admissible = freeze == 0;
    int verdict = 0;
    for (size_t index = 0; admissible && index < domain.count; ++index) {
        verdict = hl_native_checkpoint_admissible_at("/proc", domain.members[index].pid, NULL, 0);
        if (hl_options_get(options, "HL_C_DIAGNOSTICS") != NULL)
            fprintf(stderr, "[hl-native-checkpoint]\tphase=admission pid=%d verdict=%d members=%zu\n",
                    (int)domain.members[index].pid, verdict, domain.count);
        admissible = verdict == 0;
    }
    if (!admissible) {
        hl_ckpt_request refusal = {.op = HL_CKPT_OP_CAPTURE_REFUSED, .generation = generation};
        (void)hl_ckpt_channel_acquire();
        const char *domain_name = freeze == 1    ? "topology-race"
                                  : freeze != 0 ? "freeze-failed"
                                                : hl_native_checkpoint_refusal_domain(verdict);
        char reason[192];
        if (freeze == 1)
            snprintf(reason, sizeof reason, "native phase-1 process-domain topology changed during freeze");
        else if (freeze != 0)
            snprintf(reason, sizeof reason, "native phase-1 could not freeze the process domain");
        else
            snprintf(reason, sizeof reason,
                     "native phase-1 read-only admission rejected process state: %s domain (verdict %d)",
                     domain_name, verdict);
        (void)hl_ckpt_channel_notify(&refusal, reason);
        int thawed = hl_native_checkpoint_domain_thaw(&domain) == 0;
        const char *receipt = hl_options_get(options, "HL_NATIVE_CKPT_TEST_RECEIPT");
        if (receipt != NULL) {
            char line[192];
            snprintf(line, sizeof line, "generation=%u registered=0 members=%zu frozen=%d thawed=%d refusal=%s\n",
                     generation, domain.count, freeze >= 0, thawed, domain_name);
            (void)hl_native_supervised_write_text(receipt, line);
        }
        hl_native_checkpoint_domain_close(&domain);
        return -1;
    }
    int registered = 0;
    if (hl_options_get(options, "HL_NATIVE_CKPT_TEST_SKIP_REGISTER") == NULL) {
        /* The trigger is bumped while the host still owns the capture-state lock; wait until the
         * matching membership ledger is visible before announcing this stopped participant. */
        usleep(10000);
        size_t payload_size = 8 + domain.count * sizeof(uint32_t);
        unsigned char *payload = calloc(1, payload_size);
        if (payload != NULL) {
            uint32_t count = (uint32_t)domain.count;
            memcpy(payload, &count, sizeof(count));
            for (size_t index = 0; index < domain.count; ++index) {
                uint32_t executor = (uint32_t)domain.members[index].pid;
                memcpy(payload + 8 + index * sizeof(executor), &executor, sizeof(executor));
            }
        }
        hl_ckpt_reply reply = {0};
        int called = -1;
        for (int attempt = 0; payload != NULL && attempt < 1000 && !registered; ++attempt) {
            hl_ckpt_request request = {
                .op = HL_CKPT_OP_REGISTER_READY, .length = payload_size, .generation = generation};
            called = hl_ckpt_channel_call(&request, NULL, payload, &reply, NULL, 0);
            registered = called == 0 && reply.status == HL_CKPT_STATUS_OK && reply.value != 0;
            if (!registered) usleep(1000);
        }
        free(payload);
        if (!registered && hl_options_get(options, "HL_C_DIAGNOSTICS") != NULL)
            fprintf(stderr, "[hl-native-checkpoint]\tregister_call=%d status=%d member=%llu failure=%s\n",
                    called, reply.status, (unsigned long long)reply.value,
                    hl_ckpt_channel_failure() == NULL ? "none" : hl_ckpt_channel_failure());
    }
    int captured = 0;
    if (registered && domain.count == 1) {
        /* pid, then the capture directives this supervisor is the authority for.  Bit 0 is the
         * alternate-stack carry: the taint arm above is disarmed exactly when it is set, so the two
         * decisions cannot drift apart -- whoever admitted the guest also tells the capture why it
         * was admitted, in the same message. */
        uint64_t snapshot[2] = {(uint64_t)domain.members[0].pid,
                                hl_native_supervised_carry_altstack(options) ? 1u : 0u};
        uint64_t process = snapshot[0];
        if (hl_options_get(options, "HL_C_DIAGNOSTICS") != NULL)
            fprintf(stderr,
                    "[hl-native-checkpoint]\tphase=native_snapshot_request pid=%llu generation=%u directives=%llu\n",
                    (unsigned long long)process, generation, (unsigned long long)snapshot[1]);
        hl_ckpt_request request = {
            .op = HL_CKPT_OP_NATIVE_SNAPSHOT, .length = sizeof(snapshot), .generation = generation};
        hl_ckpt_reply reply = {0};
        captured = hl_ckpt_channel_call(&request, NULL, snapshot, &reply, NULL, 0) == 0 &&
                   reply.status == HL_CKPT_STATUS_OK;
        if (hl_options_get(options, "HL_C_DIAGNOSTICS") != NULL)
            fprintf(stderr, "[hl-native-checkpoint]\tphase=native_snapshot_reply captured=%d status=%d\n",
                    captured, reply.status);
    }
    if (captured) {
        (void)hl_native_checkpoint_member_signal(&domain.members[0], SIGKILL);
        hl_native_checkpoint_domain_close(&domain);
        return 0;
    }
    hl_ckpt_request refusal = {.op = HL_CKPT_OP_CAPTURE_REFUSED, .generation = generation};
    (void)hl_ckpt_channel_notify(
        &refusal, registered ? "native checkpoint image capture failed" : "native phase-1 participant registration failed");
    int thawed = hl_native_checkpoint_domain_thaw(&domain) == 0;
    if (hl_options_get(options, "HL_C_DIAGNOSTICS") != NULL)
        fprintf(stderr, "[hl-native-checkpoint]\tgeneration=%u registered=%d members=%zu frozen=1 thawed=%d\n",
                generation, registered, domain.count, thawed);
    const char *receipt = hl_options_get(options, "HL_NATIVE_CKPT_TEST_RECEIPT");
    if (receipt != NULL) {
        char line[160];
        snprintf(line, sizeof(line), "generation=%u registered=%d members=%zu frozen=1 thawed=%d\n",
                 generation, registered, domain.count, thawed);
        (void)hl_native_supervised_write_text(receipt, line);
    }
    hl_native_checkpoint_domain_close(&domain);
    return registered && thawed ? 0 : -1;
}

#if defined(HL_NATIVE_TEST_HOOKS) && defined(HL_NATIVE_TEST_HOOK_EXPORT)
static int hl_native_checkpoint_phase1_test(void) {
    pid_t child = fork();
    if (child < 0) return 1;
    if (child == 0) {
        for (int fd = 3; fd < 4096; ++fd) close(fd);
        for (;;) pause();
    }
    usleep(10000);
    const char *names[] = {"HL_NATIVE_CKPT_TEST_SKIP_REGISTER"};
    const char *values[] = {"1"};
    hl_options options = {0};
    if (hl_options_init_records(&options, 1, names, values) != 0) {
        (void)kill(child, SIGKILL); (void)waitpid(child, NULL, 0); return 2;
    }
    atomic_store_explicit(&hl_native_checkpoint_test_scan_stopped, 0, memory_order_release);
    hl_native_checkpoint_test_observe_stop = 1;
    (void)hl_native_supervised_checkpoint_phase1(child, 1, &options);
    hl_native_checkpoint_test_observe_stop = 0;
    int scanned_stopped = atomic_load_explicit(&hl_native_checkpoint_test_scan_stopped, memory_order_acquire);
    int thawed = !hl_native_supervised_stopped(child);
    (void)kill(child, SIGKILL); (void)waitpid(child, NULL, 0);
    hl_options_destroy(&options);
    return scanned_stopped && thawed ? 0 : 3;
}

/* The taint classifier's answer for every syscall it knows, for the argument shapes that cannot arm
 * anything, and for one syscall outside the set.  The gate arm it feeds is driven from the Rust side
 * against the synthetic closed-world /proc, because a forked child of the test harness is refused by
 * an earlier arm and would mask it.  The non-zero return is the step that failed, so a regression
 * names itself. */
static int hl_native_checkpoint_taint_test(void) {
    __u64 arguments[6];
    memset(arguments, 0, sizeof arguments);
    int step = 10;
    atomic_store_explicit(&hl_native_checkpoint_carry_altstack, 0, memory_order_release);
#ifdef SYS_sigaltstack
    arguments[0] = 0;
    if (hl_native_checkpoint_taints_state(SYS_sigaltstack, arguments)) return step;
    ++step;
    arguments[0] = 0x1000;
    if (!hl_native_checkpoint_taints_state(SYS_sigaltstack, arguments)) return step;
    ++step;
    /* The carry option removes this flavour and ONLY this flavour.  Asserted here rather than
     * reasoned about, because a carry that silently kept tainting would look exactly like a carry
     * that worked until a Rust guest was actually offered to the gate. */
    atomic_store_explicit(&hl_native_checkpoint_carry_altstack, 1, memory_order_release);
    if (hl_native_checkpoint_taints_state(SYS_sigaltstack, arguments)) return step;
    ++step;
#ifdef SYS_setitimer
    arguments[1] = 0x1000;
    if (!hl_native_checkpoint_taints_state(SYS_setitimer, arguments)) return step;
    ++step;
    arguments[1] = 0;
#endif
#ifdef SYS_timer_create
    if (!hl_native_checkpoint_taints_state(SYS_timer_create, arguments)) return step;
    ++step;
#endif
    atomic_store_explicit(&hl_native_checkpoint_carry_altstack, 0, memory_order_release);
    arguments[0] = 0;
#endif
#ifdef SYS_setitimer
    arguments[1] = 0;
    if (hl_native_checkpoint_taints_state(SYS_setitimer, arguments)) return step;
    ++step;
    arguments[1] = 0x1000;
    if (!hl_native_checkpoint_taints_state(SYS_setitimer, arguments)) return step;
    ++step;
    arguments[1] = 0;
#endif
#ifdef SYS_alarm
    arguments[0] = 0;
    if (hl_native_checkpoint_taints_state(SYS_alarm, arguments)) return step;
    ++step;
    arguments[0] = 7200;
    if (!hl_native_checkpoint_taints_state(SYS_alarm, arguments)) return step;
    ++step;
    arguments[0] = 0;
#endif
#ifdef SYS_timer_create
    if (!hl_native_checkpoint_taints_state(SYS_timer_create, arguments)) return step;
    ++step;
#endif
    /* A syscall outside the set must never mark, or the arm would refuse every capture there is. */
    if (hl_native_checkpoint_taints_state(SYS_getpid, arguments)) return step;
    return 0;
}

/* The filter rewrite, checked on a real program rather than by inspection.
 *
 * Three properties, because getting any one of them wrong is silent: the named arm stops matching
 * its syscall, every OTHER notified arm still matches, and the program length is unchanged (a
 * shortened program would shift jump offsets and quietly change which syscalls are notified). */
static int hl_native_checkpoint_disarm_test(void) {
#ifdef SYS_sigaltstack
    struct sock_filter program[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_sigaltstack, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_USER_NOTIF),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_getpid, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_USER_NOTIF),
        /* Same constant, different verdict: a rewrite keyed on the number alone would take it. */
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_sigaltstack, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
    size_t count = sizeof program / sizeof program[0];
    hl_native_supervised_disarm_notification(program, count, SYS_sigaltstack);
    if (program[1].k != 0xFFFFFFFFu) return 60;
    if (program[3].k != (unsigned int)SYS_getpid) return 61;
    if (program[5].k != (unsigned int)SYS_sigaltstack) return 62;
    if (count != 8) return 63;
#endif
    return 0;
}

/* Drives the mark itself, so the gate arm can be exercised against a /proc the other arms admit. */
static int hl_native_checkpoint_taint_set_test(int marked) {
    atomic_store_explicit(&hl_native_checkpoint_state_taint, marked ? 1 : 0, memory_order_release);
    return 0;
}

static int hl_native_checkpoint_empty_fds_test(void) {
    pid_t child = fork();
    if (child < 0) return 1;
    if (child == 0) {
        for (int fd = 3; fd < 4096; ++fd) close(fd);
        for (;;) pause();
    }
    usleep(10000);
    (void)kill(child, SIGSTOP);
    for (int attempt = 0; attempt < 1000 && !hl_native_supervised_stopped(child); ++attempt) usleep(1000);
    int result = hl_native_checkpoint_fds_admissible("/proc", child, NULL, 0);
    (void)kill(child, SIGKILL); (void)waitpid(child, NULL, 0);
    return result;
}

static int hl_native_checkpoint_test_wait_state(pid_t process, int stopped) {
    for (int attempt = 0; attempt < 1000; ++attempt) {
        if (hl_native_supervised_stopped(process) == stopped) return 0;
        usleep(1000);
    }
    return -1;
}

/* One non-vacuous native test exercises the production freeze primitive across the failure modes that
 * matter as a unit: the second enumeration catches a fork between inventory and stop, the union ledger
 * stops and thaws that missed child, stable generations repeat, a killed member refuses while its live
 * peer resumes, and the dead member's pidfd cannot be redirected by changing its numeric pid field. */
static int hl_native_checkpoint_domain_freeze_test(void) {
    int command[2] = {-1, -1}, reply[2] = {-1, -1};
    if (pipe2(command, O_CLOEXEC) != 0 || pipe2(reply, O_CLOEXEC) != 0) return 1;
    pid_t root = fork();
    if (root < 0) return 2;
    if (root == 0) {
        close(command[1]); close(reply[0]);
        unsigned char byte;
        if (read(command[0], &byte, 1) != 1) _exit(90);
        pid_t child = fork();
        if (child < 0 || write(reply[1], &child, sizeof(child)) != (ssize_t)sizeof(child)) _exit(91);
        if (child == 0) for (;;) pause();
        for (;;) pause();
    }
    close(command[0]); close(reply[1]);
    usleep(10000);
    hl_native_checkpoint_test_race_command = command[1];
    hl_native_checkpoint_test_race_reply = reply[0];
    hl_native_checkpoint_domain domain = {0};
    int result = hl_native_checkpoint_domain_freeze(root, &domain);
    hl_native_checkpoint_test_race_command = -1;
    hl_native_checkpoint_test_race_reply = -1;
    pid_t raced = domain.count == 2 ? domain.members[1].pid : -1;
    int raced_refused = result == 1 && domain.count == 2 &&
                        hl_native_supervised_stopped(root) && hl_native_supervised_stopped(raced);
    int raced_thawed = hl_native_checkpoint_domain_thaw(&domain) == 0 &&
                       hl_native_checkpoint_test_wait_state(root, 0) == 0 &&
                       hl_native_checkpoint_test_wait_state(raced, 0) == 0;
    hl_native_checkpoint_domain_close(&domain);
    if (!raced_refused || !raced_thawed) { result = 3; goto done; }

    for (int generation = 0; generation < 2; ++generation) {
        memset(&domain, 0, sizeof(domain));
        if (hl_native_checkpoint_domain_freeze(root, &domain) != 0 || domain.count != 2 ||
            !hl_native_supervised_stopped(root) || !hl_native_supervised_stopped(raced) ||
            hl_native_checkpoint_domain_thaw(&domain) != 0) {
            hl_native_checkpoint_domain_close(&domain); result = 4; goto done;
        }
        hl_native_checkpoint_domain_close(&domain);
        if (hl_native_checkpoint_test_wait_state(root, 0) != 0 ||
            hl_native_checkpoint_test_wait_state(raced, 0) != 0) { result = 5; goto done; }
    }

    hl_native_checkpoint_test_kill_after_stop = raced;
    memset(&domain, 0, sizeof(domain));
    if (hl_native_checkpoint_domain_freeze(root, &domain) == 0) { result = 6; goto killed_done; }
    hl_native_checkpoint_test_kill_after_stop = -1;
    if (hl_native_checkpoint_domain_thaw(&domain) != 0 || hl_native_checkpoint_test_wait_state(root, 0) != 0) {
        result = 7; goto killed_done;
    }
    hl_native_checkpoint_domain_close(&domain);
    pid_t dead_process = fork();
    if (dead_process < 0) { result = 8; goto done; }
    if (dead_process == 0) for (;;) pause();
    hl_native_checkpoint_member dead_member = {.pid = dead_process, .pidfd = -1, .was_stopped = 0};
    dead_member.pidfd = (int)syscall(SYS_pidfd_open, dead_process, 0u);
    if (dead_member.pidfd < 0) {
        (void)kill(dead_process, SIGKILL); (void)waitpid(dead_process, NULL, 0); result = 8; goto done;
    }
    (void)kill(dead_process, SIGKILL); (void)waitpid(dead_process, NULL, 0);
    pid_t replacement = fork();
    if (replacement < 0) { close(dead_member.pidfd); result = 9; goto done; }
    if (replacement == 0) for (;;) pause();
    (void)kill(replacement, SIGSTOP);
    if (hl_native_checkpoint_test_wait_state(replacement, 1) != 0) {
        close(dead_member.pidfd); (void)kill(replacement, SIGKILL); (void)waitpid(replacement, NULL, 0);
        result = 10; goto done;
    }
    dead_member.pid = replacement;
    errno = 0;
    int stale = hl_native_checkpoint_member_signal(&dead_member, SIGCONT);
    int stale_errno = errno;
    int replacement_still_stopped = hl_native_supervised_stopped(replacement);
    close(dead_member.pidfd);
    (void)kill(replacement, SIGCONT); (void)kill(replacement, SIGKILL); (void)waitpid(replacement, NULL, 0);
    result = stale == 0 || stale_errno != ESRCH || !replacement_still_stopped ? 11 : 0;
killed_done:
    hl_native_checkpoint_test_kill_after_stop = -1;
    hl_native_checkpoint_domain_close(&domain);
done:
    close(command[1]); close(reply[0]);
    (void)kill(root, SIGCONT); (void)kill(root, SIGKILL); (void)waitpid(root, NULL, 0);
    if (raced > 0) { (void)kill(raced, SIGKILL); (void)waitpid(raced, NULL, 0); }
    return result;
}
#endif

static char **hl_native_supervised_environment(const hl_options *options) {
    const char *encoded = hl_options_get(options, "HL_GUEST_ENV");
    int escaped = hl_options_get(options, "HL_GUEST_ENV_ESC") != NULL;
    if (encoded == NULL || encoded[0] == 0) return calloc(1, sizeof(char *));
    size_t count = 1;
    for (const char *cursor = encoded; *cursor; ++cursor) count += *cursor == '\n';
    char **environment = calloc(count + 1, sizeof(char *));
    char *storage = strdup(encoded);
    if (environment == NULL || storage == NULL) { free(environment); free(storage); return NULL; }
    size_t index = 0;
    char *record = storage;
    for (char *cursor = storage;; ++cursor) {
        if (*cursor != '\n' && *cursor != 0) continue;
        int last = *cursor == 0;
        *cursor = 0;
        if (escaped) {
            char *read = record, *write = record;
            while (*read) {
                if (read[0] == '\\' && read[1] == 'n') { *write++ = '\n'; read += 2; }
                else if (read[0] == '\\' && read[1] == '\\') { *write++ = '\\'; read += 2; }
                else *write++ = *read++;
            }
            *write = 0;
        }
        environment[index++] = record;
        if (last) break;
        record = cursor + 1;
    }
    return environment;
}

static void hl_native_supervised_environment_free(char **environment) {
    if (environment == NULL) return;
    free(environment[0]);
    free(environment);
}

static int hl_native_supervised_wait(int listener, int leader_pidfd, pid_t leader,
                                     const hl_options *options, int *guest_signal) {
    /* A new supervised domain starts clean.  The mark belongs to this domain's guest processes and to
     * nothing that ran before them; making that explicit here rather than relying on the supervisor
     * being a fresh process keeps the scope a property of the code. */
    atomic_store_explicit(&hl_native_checkpoint_state_taint, 0, memory_order_release);
    atomic_store_explicit(&hl_native_checkpoint_carry_altstack,
                          hl_native_supervised_carry_altstack(options), memory_order_release);
    int refused_number, refused_error;
    if (hl_native_supervised_refusal(options, &refused_number, &refused_error) != 0) return 70;
    struct seccomp_notif_sizes sizes = {0};
    if (syscall(SYS_seccomp, SECCOMP_GET_NOTIF_SIZES, 0, &sizes) != 0) return 70;
    struct seccomp_notif *request = calloc(1, sizes.seccomp_notif);
    struct seccomp_notif_resp *response = calloc(1, sizes.seccomp_notif_resp);
    if (request == NULL || response == NULL) { free(request); free(response); return 70; }
    int leader_result = 70, leader_done = 0;
    int diagnostics = hl_options_get(options, "HL_C_DIAGNOSTICS") != NULL;
    const char *notification_receipt = hl_options_get(options, "HL_NATIVE_NOTIFY_TEST_RECEIPT");
    int count_notifications = diagnostics || notification_receipt != NULL;
    int pane_terminal = hl_native_supervised_flag(options, "HL_NATIVE_SUPERVISED_PANE");
    unsigned long idle_timeouts = 0, notifications = 0, open_notifications = 0;
    int listener_active = listener;
    volatile uint32_t *trigger = NULL;
    uint32_t trigger_seen = 0;
    int trigger_descriptor = hl_ckpt_trigger_descriptor();
    int trigger_wake = hl_ckpt_broker_descriptor();
    if (trigger_descriptor >= 0) {
        void *mapping = mmap(NULL, sizeof(uint32_t), PROT_READ | PROT_WRITE, MAP_SHARED, trigger_descriptor, 0);
        if (mapping != MAP_FAILED) { trigger = mapping; trigger_seen = *trigger; }
    }
    int restore_pending = hl_options_get(options, "HL_RESTORE") != NULL;
    pid_t restore_workload = -1;
    struct timespec restore_started = {0};
    if (restore_pending && clock_gettime(CLOCK_MONOTONIC, &restore_started) != 0) {
        free(request); free(response); return 70;
    }
    *guest_signal = 0;
    for (;;) {
        if (restore_pending) {
            struct timespec now = {0};
            if (clock_gettime(CLOCK_MONOTONIC, &now) != 0 || now.tv_sec - restore_started.tv_sec >= 10) {
                if (diagnostics)
                    fprintf(stderr, "[hl-native-checkpoint]\tphase=restore_rendezvous_timeout workload=%d\n",
                            (int)restore_workload);
                free(request); free(response); return 70;
            }
            if (restore_workload < 0) {
                (void)hl_native_supervised_single_child(leader, &restore_workload);
                if (diagnostics && restore_workload > 0)
                    fprintf(stderr, "[hl-native-checkpoint]\tphase=restore_workload pid=%d\n",
                            (int)restore_workload);
            }
        }
        int status;
        pid_t waited;
        while ((waited = waitpid(-1, &status, WNOHANG)) > 0) {
            if (waited == leader) {
                leader_done = 1;
                if (WIFEXITED(status)) leader_result = WEXITSTATUS(status);
                else if (WIFSIGNALED(status)) {
                    *guest_signal = WTERMSIG(status);
                    /* finish_process authenticates the signal record against this worker status. */
                    leader_result = 128 + *guest_signal;
                }
            }
        }
        if (waited < 0 && errno == ECHILD && leader_done) {
            const char *idle_receipt = hl_options_get(options, "HL_NATIVE_CKPT_TEST_IDLE_RECEIPT");
            if (idle_receipt != NULL) {
                char line[64];
                snprintf(line, sizeof(line), "periodic_wakeups=%lu\n", idle_timeouts);
                (void)hl_native_supervised_write_text(idle_receipt, line);
            }
            if (diagnostics)
                fprintf(stderr, "[hl-native-supervised]\tnotifications=%lu open=%lu\n", notifications,
                        open_notifications);
            if (notification_receipt != NULL) {
                char line[64];
                snprintf(line, sizeof(line), "notifications=%lu open=%lu\n", notifications, open_notifications);
                (void)hl_native_supervised_write_text(notification_receipt, line);
            }
            free(request); free(response); return leader_result;
        }
        if (waited < 0 && errno != EINTR && errno != ECHILD) { free(request); free(response); return 70; }
        struct pollfd events[3] = {
            {listener_active, POLLIN, 0}, {leader_pidfd, POLLIN, 0}, {trigger_wake, POLLIN, 0}};
        int polled = poll(events, trigger_wake < 0 ? (leader_pidfd < 0 ? 1 : 2) : 3,
                          restore_pending ? 1 : -1);
        if (polled < 0) { if (errno == EINTR) continue; free(request); free(response); return 70; }
        if (polled == 0) { ++idle_timeouts; continue; }
        if (trigger_wake >= 0 && (events[2].revents & POLLIN)) {
            unsigned char wakes[64];
            while (recv(trigger_wake, wakes, sizeof(wakes), MSG_DONTWAIT) > 0) {}
            if (trigger != NULL && *trigger != trigger_seen) {
                trigger_seen = *trigger;
                pid_t workload = -1;
                (void)hl_native_supervised_single_child(leader, &workload);
                (void)hl_native_supervised_checkpoint_phase1(workload, trigger_seen, options);
            }
        }
        if (events[0].revents & (POLLHUP | POLLNVAL)) listener_active = -1;
        if (!(events[0].revents & POLLIN)) continue;
        memset(request, 0, sizes.seccomp_notif);
        if (ioctl(listener, SECCOMP_IOCTL_NOTIF_RECV, request) != 0) {
            if (errno == EINTR || errno == ENOENT) continue;
            free(request); free(response); return 70;
        }
        memset(response, 0, sizes.seccomp_notif_resp);
        response->id = request->id;
        int number = (int)request->data.nr;
        /* Before the response, never after: the syscall cannot take effect until the notification is
         * answered, so a domain whose alternate stack or interval timer is really armed is marked
         * strictly earlier than the moment it becomes armed. */
        if (hl_native_checkpoint_taints_state(number, request->data.args))
            atomic_store_explicit(&hl_native_checkpoint_state_taint, 1, memory_order_release);
        int complete_restore_after_response = 0;
        if (count_notifications) {
            ++notifications;
#ifdef SYS_open
            if (number == SYS_open) ++open_notifications;
#endif
        }
        if (number == refused_number) {
            response->error = -refused_error;
#ifdef SYS_write
        } else if (restore_pending && number == SYS_write) {
            /* Keep the notification unresolved while the broker takes ptrace ownership. Only after
             * READY is the write answered EINTR; final registers are installed after that reply. */
            if (diagnostics)
                fprintf(stderr, "[hl-native-checkpoint]\tphase=restore_write notification_pid=%d host_pid=%d\n",
                        (int)request->pid, (int)restore_workload);
            if (restore_workload <= 0) {
                free(request); free(response); return 70;
            }
            /* Same pid-plus-directives shape as the capture request.  The restore needs the carry
             * bit for the same reason the capture does and for one more: the injected `sigaltstack`
             * that installs the image's alternate stack runs under THIS launch's filter, so a
             * restore of a carrying image under a supervisor that still notifies `sigaltstack` is
             * refused before any memory is written rather than discovered as a stall afterwards. */
            uint64_t prepare_words[2] = {(uint64_t)restore_workload,
                                         hl_native_supervised_carry_altstack(options) ? 1u : 0u};
            hl_ckpt_request prepare = {.op = HL_CKPT_OP_NATIVE_RESTORE_PREPARE,
                                       .length = sizeof(prepare_words), .generation = trigger_seen};
            hl_ckpt_reply prepared = {0};
            if (hl_ckpt_channel_call(&prepare, NULL, prepare_words, &prepared, NULL, 0) != 0 ||
                prepared.status != HL_CKPT_STATUS_OK) {
                free(request); free(response); return 70;
            }
            response->error = -EINTR;
            complete_restore_after_response = 1;
#endif
#ifdef SYS_ptrace
        } else if (restore_pending && number == SYS_ptrace &&
                   (request->data.args[0] == PTRACE_TRACEME || request->data.args[0] == PTRACE_DETACH)) {
            response->flags = SECCOMP_USER_NOTIF_FLAG_CONTINUE;
#endif
#ifdef SYS_clone3
        } else if (number == SYS_clone3) {
            response->error = -ENOSYS;
#endif
        } else if (number == SYS_ioctl &&
                   !hl_native_supervised_ioctl_permitted(request->data.args[1], request->data.args[2],
                                                         pane_terminal)) {
            /* ENOTTY, not EPERM. A refused ioctl is indistinguishable to the caller from one the
             * descriptor simply does not implement, and ENOTTY is both what the kernel returns for
             * that and what every fallback path in real software is written against. EPERM asserts
             * the opposite -- that the operation exists and was denied by policy -- which defeats
             * those fallbacks: CPython's _Py_set_inheritable falls back to fcntl only on ENOTTY or
             * EACCES and raises on EPERM. The errno was never the security boundary; the refusal is,
             * and the refusal set is unchanged. */
            response->error = -ENOTTY;
        } else if (hl_native_supervised_denied(number) ||
                   (number == SYS_clone && hl_native_supervised_clone_namespaces(request->data.args[0]))
                   ) {
            /* These keep EPERM. mount/umount2/pivot_root/chroot/setns/unshare/ptrace/seccomp and
             * namespace-creating clone are genuine privilege refusals: the operation does exist and
             * is being denied deliberately, so EPERM is the truthful answer and the one a caller
             * should see rather than paper over. ENOTTY would also be meaningless for all of them. */
            response->error = -EPERM;
        } else {
            response->flags = SECCOMP_USER_NOTIF_FLAG_CONTINUE;
        }
        if (ioctl(listener, SECCOMP_IOCTL_NOTIF_SEND, response) != 0 && errno != ENOENT) {
            free(request); free(response); return 70;
        }
        if (complete_restore_after_response) {
            hl_ckpt_request complete = {.op = HL_CKPT_OP_NATIVE_RESTORE_COMPLETE, .generation = trigger_seen};
            hl_ckpt_reply restored = {0};
            if (hl_ckpt_channel_call(&complete, NULL, NULL, &restored, NULL, 0) != 0 ||
                restored.status != HL_CKPT_STATUS_OK) {
                free(request); free(response); return 70;
            }
            restore_pending = 0;
        }
    }
}

static int32_t hl_native_supervised_run(const hl_host_services *host, hl_linux_abi *box,
                                        const hl_engine_config *config,
                                        hl_host_handle executable_handle, uint32_t argc, char *const argv[],
                                        const hl_options *options, int activation_ready, int *guest_signal) {
#if defined(HL_NATIVE_TEST_HOOKS)
    /* Every selected integration scenario is also a structural gate: rebuilding the translated ABI makes
     * the native-only suite fail instead of silently preserving behavior through the old heavyweight seam. */
    if (box != NULL) return 70;
#endif
    if (argv == NULL || argv[0] == NULL) return 70;
    if (host == NULL || host->posix_attachment == NULL || host->posix_attachment->borrow_file_at_least == NULL ||
        host->posix_attachment->release == NULL) return 70;
    char **exec_argv = calloc((size_t)argc + 1, sizeof(char *));
    if (exec_argv == NULL) return 70;
    for (uint32_t index = 0; index < argc; ++index) exec_argv[index] = argv[index];
    const char *policy_rejection = hl_native_supervised_policy_rejection(config);
    if (policy_rejection != NULL) {
        if (hl_options_get(options, "HL_C_DIAGNOSTICS") != NULL)
            fprintf(stderr, "[hl-native-supervised]\tunsupported-policy=%s\n", policy_rejection);
        return 70;
    }
    if (hl_options_get(options, "HL_C_DIAGNOSTICS") != NULL)
        fprintf(stderr, "[hl-native-supervised]\tselected=1 translated_abi=%d constructed=%llu destroyed=%llu\n",
                box != NULL, (unsigned long long)hl_linux_abi_constructed(),
                (unsigned long long)hl_linux_abi_destroyed());
    char **environment = hl_native_supervised_environment(options);
    if (environment == NULL) { free(exec_argv); return 70; }
    hl_host_result executable_attachment =
        host->posix_attachment->borrow_file_at_least(host->context, executable_handle, 64);
    if (executable_attachment.status != HL_STATUS_OK || executable_attachment.value > INT_MAX) {
        hl_native_supervised_environment_free(environment); free(exec_argv); return 70;
    }
    int executable = (int)executable_attachment.value;
    int borrowed[3] = {-1, -1, -1};
    for (hl_linux_fd fd = 0; fd < 3; ++fd) {
        hl_linux_fd_snapshot snapshot = {0};
        if (box != NULL) {
            if (hl_linux_fd_snapshot_get(box, fd, &snapshot) != HL_STATUS_OK) goto attachment_failed;
        } else {
            snapshot.host_handle = HL_HOST_HANDLE_INVALID;
            for (uint32_t index = 0; index < config->fd_binding_count; ++index)
                if (config->fd_bindings[index].guest_fd == fd) {
                    snapshot.host_handle = config->fd_bindings[index].host_handle;
                    break;
                }
            if (snapshot.host_handle == HL_HOST_HANDLE_INVALID) goto attachment_failed;
        }
        hl_host_result attached = host->posix_attachment->borrow_file_at_least(host->context, snapshot.host_handle, 64);
        if (attached.status != HL_STATUS_OK || attached.value > INT_MAX) goto attachment_failed;
        borrowed[fd] = (int)attached.value;
    }
    int terminal = isatty(borrowed[STDIN_FILENO]);
    int planted_high_fd = -1;
    const char *test_refusal = hl_options_get(options, "HL_NATIVE_SUPERVISED_REFUSE");
    if (test_refusal != NULL && strcmp(test_refusal, "999:38") == 0) {
        int source = open("/dev/null", O_RDONLY | O_CLOEXEC);
        if (source < 0 || dup2(source, 1048575) != 1048575) { if (source >= 0) close(source); goto attachment_failed; }
        close(source);
        planted_high_fd = 1048575;
    }
    hl_native_supervised_bootstrap *bootstrap = mmap(NULL, sizeof(*bootstrap), PROT_READ | PROT_WRITE,
                                                     MAP_SHARED | MAP_ANONYMOUS, -1, 0);
    if (bootstrap == MAP_FAILED) goto attachment_failed;
    atomic_init(&bootstrap->listener, -1);
    atomic_init(&bootstrap->target_pid, -1);
    atomic_init(&bootstrap->acknowledged, 0);
    atomic_init(&bootstrap->result_signal, 0);
    atomic_init(&bootstrap->projected_overlay, 0);
    atomic_init(&bootstrap->clone_stages, 0);
#if defined(HL_NATIVE_TEST_HOOKS)
    atomic_init(&bootstrap->listener_wakes, 0);
#endif
    if (prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0) {
        munmap(bootstrap, sizeof(*bootstrap)); goto attachment_failed;
    }
    unsigned guest_uid = (unsigned)(config->box->uid < 0 ? 0 : config->box->uid);
    unsigned guest_gid = (unsigned)(config->box->gid < 0 ? 0 : config->box->gid);
    char uid_map[16384], gid_map[16384];
    int mapping[2] = {-1, -1};
    int leader_pidfd = -1;
    if (config->box->file_owners == NULL) {
        if (snprintf(uid_map, sizeof(uid_map), "%u %u 1\n", guest_uid, (unsigned)geteuid()) <= 0 ||
            snprintf(gid_map, sizeof(gid_map), "%u %u 1\n", guest_gid, (unsigned)getegid()) <= 0)
            goto clone_failed;
    } else if (hl_native_supervised_id_map(uid_map, sizeof(uid_map), guest_uid, config->box->file_owners, 0) != 0 ||
               hl_native_supervised_id_map(gid_map, sizeof(gid_map), guest_gid, config->box->file_owners, 1) != 0) {
        goto clone_failed;
    }
    if (config->box->file_owners != NULL && socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, mapping) != 0)
        goto clone_failed;
    uint64_t network_namespace = (config->box->flags & HL_ENGINE_BOX_NETWORK_ISOLATED) != 0 ? CLONE_NEWNET : 0;
    struct clone_args clone = {
        .flags = CLONE_NEWNS | CLONE_NEWPID | network_namespace | CLONE_NEWUTS | CLONE_NEWIPC | CLONE_PIDFD,
        .pidfd = (uint64_t)(uintptr_t)&leader_pidfd,
        .exit_signal = SIGCHLD,
    };
    if (hl_options_get(options, "HL_CHECKPOINT_COORDINATOR") != NULL ||
        hl_options_get(options, "HL_RESTORE") != NULL) {
        int current_personality = personality(0xffffffffUL);
        if (current_personality < 0 || personality((unsigned long)current_personality | ADDR_NO_RANDOMIZE) < 0)
            goto clone_failed;
    }
#if defined(HL_NATIVE_TEST_HOOKS)
    const char *stage_fail = test_refusal != NULL && strcmp(test_refusal, "998:38") == 0 ? "clone" :
                             test_refusal != NULL && strcmp(test_refusal, "997:38") == 0 ? "mapping" :
                             test_refusal != NULL && strcmp(test_refusal, "996:38") == 0 ? "listener" : NULL;
#else
    const char *stage_fail = NULL;
#endif
    pid_t child = stage_fail != NULL && strcmp(stage_fail, "clone") == 0
                      ? (errno = ENOSYS, (pid_t)-1)
                      : (pid_t)syscall(SYS_clone3, &clone, sizeof(clone));
    if (child < 0) goto clone_failed;
    if (child == 0) {
        atomic_fetch_add_explicit(&bootstrap->clone_stages, 1, memory_order_relaxed);
        if (mapping[0] >= 0) close(mapping[0]);
        for (int fd = 0; fd < 3; ++fd) {
            if (borrowed[fd] < 0) continue;
            if (dup2(borrowed[fd], fd) < 0) _exit(70);
            if (borrowed[fd] != fd) close(borrowed[fd]);
        }
        if (fcntl(executable, F_SETFD, 0) != 0) _exit(70);
        hl_native_supervised_volumes volumes;
        if (hl_native_supervised_volumes_open(config->box->volumes, &volumes) != 0 ||
            hl_native_supervised_project_container(config, options, bootstrap, &volumes, mapping[1], uid_map,
                                                    gid_map) != 0 ||
            hl_native_supervised_close_except(executable) != 0) {
            if (hl_options_get(options, "HL_C_DIAGNOSTICS") != NULL)
                fprintf(stderr, "[hl-native-supervised]\tprojector_errno=%d\n", errno);
            _exit(70);
        }
        /* Pin the descriptor the guest is executed through, because that descriptor NAMES the guest.
         *
         * The exec below is `execveat(executable, "", AT_EMPTY_PATH)`.  For an empty path Linux has no
         * pathname to attribute the image to, so it synthesises `/dev/fd/<descriptor>` and, in
         * `begin_new_exec`, sets the new task's `comm` to the basename of that -- the decimal
         * descriptor number.  `executable` is a host descriptor the engine borrowed into its private
         * band, whose number is simply the lowest free slot at the band floor when the borrow ran.  So
         * without this the guest's task name is an artifact of the engine's own descriptor table:
         * whatever else the host process had open at that instant, which differs between two engines
         * sharing a process, between two processes with different `RLIMIT_NOFILE`, and between one
         * launch and the next.
         *
         * That is guest-visible state -- `prctl(PR_GET_NAME)`, `/proc/self/comm`, `ps` -- and it is
         * captured state: the native checkpoint records `comm` in its process-state object, and
         * `NativeProcessState::admits` refuses a restore whose target disagrees, because `comm` has no
         * cross-process setter and fabricating the difference away would be a silently wrong restore.
         * A capture and a restore that drew different band slots therefore refused each other, killing
         * the freshly launched guest, for a difference that says nothing about either process.
         *
         * `close_except` above has just left this child holding exactly {0,1,2,executable}, so the
         * pinned slot is free by construction and the relocation needs no search.  The name is still a
         * number -- the kernel offers no other name for an anonymous image -- but it is now the SAME
         * number for every native-supervised guest on every host. */
        if (executable != HL_NATIVE_SUPERVISED_EXEC_DESCRIPTOR) {
            if (dup2(executable, HL_NATIVE_SUPERVISED_EXEC_DESCRIPTOR) != HL_NATIVE_SUPERVISED_EXEC_DESCRIPTOR)
                _exit(70);
            /* Deliberately NOT `hl_host_process_fd_private_remove`: that takes the private-fd fork
             * mutex, which a sibling thread can have been holding at `clone3`, and this child would
             * then block on it forever.  Nothing is leaked by skipping it -- the private registry is
             * keyed on (pid, start time), so every entry this child inherited already belongs to the
             * parent's identity and is invisible to the child. */
            close(executable);
            executable = HL_NATIVE_SUPERVISED_EXEC_DESCRIPTOR;
        }
        /* The generic lifecycle deliberately leaves native-supervised PTYs unattached. Claim this supplied
         * slave while setup is still trusted; the filtered workload then only inherits terminal authority. */
        if (terminal && (setsid() < 0 || ioctl(STDIN_FILENO, TIOCSCTTY, 0) != 0)) _exit(70);
        int listener = stage_fail != NULL && strcmp(stage_fail, "listener") == 0
                           ? (errno = EIO, -1)
                           : hl_native_supervised_create_listener(options);
        if (listener < 0) _exit(70);
#if defined(HL_NATIVE_TEST_HOOKS)
        if (test_refusal != NULL && (strcmp(test_refusal, "993:38") == 0 || strcmp(test_refusal, "995:38") == 0))
            usleep(10000);
#endif
        atomic_store_explicit(&bootstrap->listener, listener, memory_order_release);
        int listeners_woken = (int)syscall(SYS_futex, &bootstrap->listener, FUTEX_WAKE, 1, NULL, NULL, 0);
#if defined(HL_NATIVE_TEST_HOOKS)
        atomic_store_explicit(&bootstrap->listener_wakes, listeners_woken + 1, memory_order_release);
#else
        (void)listeners_woken;
#endif
        while (!atomic_load_explicit(&bootstrap->acknowledged, memory_order_acquire)) {
            if (syscall(SYS_futex, &bootstrap->acknowledged, FUTEX_WAIT, 0, NULL, NULL, 0) != 0 &&
                errno != EAGAIN && errno != EINTR)
                _exit(70);
        }
        close(listener);
        pid_t workload = fork();
        if (workload < 0) _exit(70);
        if (workload > 0) {
            atomic_fetch_add_explicit(&bootstrap->clone_stages, 1, memory_order_relaxed);
            int leader_status = 0;
            int status;
            pid_t waited;
            while ((waited = waitpid(-1, &status, 0)) > 0) {
                if (waited == workload && WIFSTOPPED(status) && WSTOPSIG(status) == SIGTRAP &&
                    hl_options_get(options, "HL_RESTORE") != NULL) {
                    if (ptrace(PTRACE_DETACH, workload, NULL, NULL) != 0) _exit(70);
                    continue;
                }
                if (waited == workload) leader_status = status;
            }
            if (WIFSIGNALED(leader_status)) {
                atomic_store_explicit(&bootstrap->result_signal, WTERMSIG(leader_status), memory_order_release);
                _exit(128 + WTERMSIG(leader_status));
            }
            _exit(WIFEXITED(leader_status) ? WEXITSTATUS(leader_status) : 70);
        }
        if (fcntl(executable, F_SETFD, FD_CLOEXEC) != 0) _exit(70);
        if (hl_options_get(options, "HL_RESTORE") != NULL && ptrace(PTRACE_TRACEME, 0, NULL, NULL) != 0) _exit(70);
        execveat(executable, "", exec_argv, environment, AT_EMPTY_PATH);
        if (hl_options_get(options, "HL_C_DIAGNOSTICS") != NULL)
            fprintf(stderr, "[hl-native-supervised]\texecveat_errno=%d\n", errno);
        _exit(errno == ENOENT ? 127 : 126);
    }
    if (mapping[1] >= 0) close(mapping[1]);
    if (mapping[0] < 0 && stage_fail != NULL && strcmp(stage_fail, "mapping") == 0) {
        kill(child, SIGKILL);
        waitpid(child, NULL, 0);
        goto clone_failed;
    }
    if (mapping[0] >= 0) {
        char byte;
        struct pollfd ready = {.fd = mapping[0], .events = POLLIN};
        if (poll(&ready, 1, 10000) != 1 || read(mapping[0], &byte, 1) != 1 ||
            (stage_fail != NULL && strcmp(stage_fail, "mapping") == 0) ||
            hl_native_supervised_write_process_text(child, "setgroups", "deny") != 0 ||
            hl_native_supervised_write_process_text(child, "uid_map", uid_map) != 0 ||
            hl_native_supervised_write_process_text(child, "gid_map", gid_map) != 0 || write(mapping[0], "1", 1) != 1) {
            close(mapping[0]);
            kill(child, SIGKILL);
            waitpid(child, NULL, 0);
            goto clone_failed;
        }
        close(mapping[0]);
    }
    if (planted_high_fd >= 0) { close(planted_high_fd); planted_high_fd = -1; }
    for (int fd = 0; fd < 3; ++fd) {
        if (borrowed[fd] >= 0) (void)host->posix_attachment->release(host->context, (uint64_t)borrowed[fd]);
        borrowed[fd] = -1;
    }
    (void)host->posix_attachment->release(host->context, (uint64_t)executable);
    executable = -1;
    int listener = leader_pidfd < 0 ? -1 : hl_native_supervised_listener_wait(bootstrap, leader_pidfd, options);
    if (listener >= 0) {
        atomic_store_explicit(&bootstrap->acknowledged, 1, memory_order_release);
        (void)syscall(SYS_futex, &bootstrap->acknowledged, FUTEX_WAKE, 1, NULL, NULL, 0);
    }
    if (listener < 0) {
        (void)kill(child, SIGKILL); (void)waitpid(child, NULL, 0);
        hl_native_supervised_projection_cleanup(bootstrap);
        if (leader_pidfd >= 0) close(leader_pidfd);
        munmap(bootstrap, sizeof(*bootstrap));
        hl_native_supervised_environment_free(environment); free(exec_argv); return 70;
    }
    unsigned char ready = 1;
    if (write(activation_ready, &ready, sizeof(ready)) != (ssize_t)sizeof(ready)) {
        close(listener); (void)kill(child, SIGKILL); (void)waitpid(child, NULL, 0);
        hl_native_supervised_projection_cleanup(bootstrap);
        if (leader_pidfd >= 0) close(leader_pidfd);
        munmap(bootstrap, sizeof(*bootstrap));
        hl_native_supervised_environment_free(environment); free(exec_argv); return 70;
    }
    int result = hl_native_supervised_wait(listener, leader_pidfd, child, options, guest_signal);
#if defined(HL_NATIVE_TEST_HOOKS)
    if (atomic_load_explicit(&bootstrap->clone_stages, memory_order_relaxed) != 2) result = 70;
#endif
    int result_signal = atomic_load_explicit(&bootstrap->result_signal, memory_order_acquire);
    if (result_signal != 0) *guest_signal = result_signal;
#if defined(HL_NATIVE_TEST_HOOKS)
    const char *reap_receipt_path = hl_options_get(options, "HL_NATIVE_REAP_TEST_RECEIPT");
#else
    const char *reap_receipt_path = NULL;
#endif
    int reap_diagnostics = hl_options_get(options, "HL_C_DIAGNOSTICS") != NULL;
    if (reap_diagnostics || reap_receipt_path != NULL) {
        char reap_receipt[128];
        snprintf(reap_receipt, sizeof(reap_receipt),
                 "reaped=1 isa=%s leader=%ld status=%d signal=%d\n",
                 HL_NATIVE_ISA_NAME, (long)child, result, *guest_signal);
        if (reap_diagnostics) fprintf(stderr, "[hl-native-supervised]\t%s", reap_receipt);
        if (reap_receipt_path != NULL) (void)hl_native_supervised_write_text(reap_receipt_path, reap_receipt);
    }
    hl_native_supervised_projection_cleanup(bootstrap);
    munmap(bootstrap, sizeof(*bootstrap));
    if (leader_pidfd >= 0) close(leader_pidfd);
    close(listener);
    hl_native_supervised_environment_free(environment);
    free(exec_argv);
    return result;
clone_failed:
    if (mapping[0] >= 0) close(mapping[0]);
    if (mapping[1] >= 0) close(mapping[1]);
    if (leader_pidfd >= 0) close(leader_pidfd);
    hl_native_supervised_projection_cleanup(bootstrap);
    munmap(bootstrap, sizeof(*bootstrap));
    goto attachment_failed;
attachment_failed:
    if (planted_high_fd >= 0) close(planted_high_fd);
    for (int fd = 0; fd < 3; ++fd)
        if (borrowed[fd] >= 0) (void)host->posix_attachment->release(host->context, (uint64_t)borrowed[fd]);
    if (executable >= 0) (void)host->posix_attachment->release(host->context, (uint64_t)executable);
    hl_native_supervised_environment_free(environment);
    free(exec_argv);
    return 70;
}
#else
static int hl_native_supervised_available(void) { return 0; }
static int32_t hl_native_supervised_run(const hl_host_services *host, hl_linux_abi *box,
                                        const hl_engine_config *config,
                                        hl_host_handle executable_handle, uint32_t argc, char *const argv[],
                                        const hl_options *options, int activation_ready, int *guest_signal) {
    (void)host; (void)box; (void)config; (void)executable_handle; (void)argc; (void)argv; (void)options;
    (void)activation_ready;
    *guest_signal = 0; return 70;
}
#endif
