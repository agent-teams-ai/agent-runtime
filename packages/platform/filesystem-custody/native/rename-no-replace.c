#define _GNU_SOURCE

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#ifdef __linux__
#include <linux/fs.h>
#endif
#include <node_api.h>
#include "host-errno.h"
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#ifdef __APPLE__
#include <sandbox.h>
#include <stdatomic.h>
#include <sys/mount.h>
#include <sys/param.h>
#endif
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

/* napi_get_value_int32 truncates; reject fractional, wrapped and AT_FDCWD
 * inputs before touching a namespace or acquiring/releasing a process lock. */
static bool read_directory(napi_env env, napi_value value, int32_t *output) {
  double number;
  struct stat observation;
  if (napi_get_value_double(env, value, &number) != napi_ok ||
      !(number >= 0 && number <= INT32_MAX)) return false;
  *output = (int32_t)number;
  return number == (double)*output && fstat(*output, &observation) == 0 &&
    S_ISDIR(observation.st_mode);
}

#if defined(__linux__) || defined(__APPLE__)
static int rename_exclusive(int from_fd, const char *from, int to_fd, const char *to) {
#ifdef __APPLE__
  return renameatx_np(from_fd, from, to_fd, to, RENAME_EXCL);
#else
  return syscall(SYS_renameat2, from_fd, from, to_fd, to, RENAME_NOREPLACE);
#endif
}

enum outcome {
  outcome_exists = 73,
  outcome_unsupported = 74,
  outcome_failure = 75,
  outcome_source_changed = 76,
  outcome_ambiguous_residue = 77
};

static int read_name(napi_env env, napi_value value, char **output) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok || length == 0 || length > 255) {
    return 0;
  }
  char16_t units[256];
  size_t unit_count = 0;
  if (napi_get_value_string_utf16(env, value, units, 256, &unit_count) != napi_ok) return 0;
  for (size_t i = 0; i < unit_count; i++) {
    if (units[i] >= 0xd800 && units[i] <= 0xdbff) {
      if (++i >= unit_count || units[i] < 0xdc00 || units[i] > 0xdfff) return 0;
    } else if (units[i] >= 0xdc00 && units[i] <= 0xdfff) return 0;
  }
  char *buffer = malloc(length + 1);
  if (buffer == NULL) return 0;
  size_t written = 0;
  if (napi_get_value_string_utf8(env, value, buffer, length + 1, &written) != napi_ok ||
      written != length || memchr(buffer, 0, length) != NULL ||
      strchr(buffer, '/') != NULL || strcmp(buffer, ".") == 0 || strcmp(buffer, "..") == 0) {
    free(buffer);
    return 0;
  }
  *output = buffer;
  return 1;
}

static int publish_captured(int source_directory, const char *source_name,
  int destination_directory, const char *destination_name, uint64_t expected_device,
  uint64_t expected_inode, const char *incomplete_name, bool crash_after_capture) {
  int result = outcome_failure;
  bool captured_this_call = false;
  struct stat captured;
  /*
   * The unchecked source is first captured under an incomplete name
   * in the destination parent.  Only that captured name is identity checked
   * and eligible for final publication.  A source-parent replacement can
   * therefore never be renamed directly to the final name.
  */
  if (fstatat(destination_directory, destination_name, &captured, AT_SYMLINK_NOFOLLOW) == 0) {
    if (fstatat(destination_directory, incomplete_name, &captured, AT_SYMLINK_NOFOLLOW) != 0) {
      if (errno == ENOENT) result = outcome_exists;
    } else if (
      (uint64_t)captured.st_dev != expected_device ||
      (uint64_t)captured.st_ino != expected_inode
    ) {
      result = outcome_source_changed;
    } else if (rename_exclusive(destination_directory, incomplete_name,
      source_directory, source_name
    ) == 0) {
      result = outcome_exists;
    } else {
      result = outcome_ambiguous_residue;
    }
  } else if (errno != ENOENT) {
    result = outcome_failure;
  } else if (fstatat(destination_directory, incomplete_name, &captured, AT_SYMLINK_NOFOLLOW) != 0) {
    if (errno != ENOENT) {
      result = outcome_failure;
    } else if (rename_exclusive(
      source_directory,
      source_name,
      destination_directory,
      incomplete_name
    ) != 0) {
      if (errno == ENOSYS || errno == EINVAL || errno == EOPNOTSUPP) result = outcome_unsupported;
      else result = outcome_failure;
    } else {
      captured_this_call = true;
      if (crash_after_capture) {
        kill(getpid(), SIGKILL);
        _exit(128 + SIGKILL);
      }
    }
  }
  if (result == outcome_failure &&
      fstatat(destination_directory, incomplete_name, &captured, AT_SYMLINK_NOFOLLOW) == 0) {
    if ((uint64_t)captured.st_dev != expected_device || (uint64_t)captured.st_ino != expected_inode) {
      if (!captured_this_call) result = outcome_source_changed;
      else if (rename_exclusive(destination_directory, incomplete_name,
        source_directory, source_name
      ) == 0) result = outcome_source_changed;
      else result = outcome_failure;
    } else if (rename_exclusive(destination_directory, incomplete_name,
      destination_directory, destination_name
    ) == 0) result = 0;
    else if (errno == EEXIST || errno == ENOTEMPTY) {
      /* Best-effort restoration preserves the old no-overwrite contract. */
      if (rename_exclusive(destination_directory, incomplete_name,
        source_directory, source_name
      ) == 0) result = outcome_exists;
      else result = outcome_failure;
    } else if (errno == ENOSYS || errno == EINVAL || errno == EOPNOTSUPP) {
      result = outcome_unsupported;
    }
  }
  if (result == outcome_failure &&
      fstatat(destination_directory, destination_name, &captured, AT_SYMLINK_NOFOLLOW) == 0) {
    /* A concurrent contender may have completed the same publication. */
    if (fstatat(destination_directory, incomplete_name, &captured, AT_SYMLINK_NOFOLLOW) != 0) {
      if (errno == ENOENT) result = outcome_exists;
    } else {
      result = outcome_ambiguous_residue;
    }
  }
  return result;
}

static napi_value publish_no_replace_impl(
  napi_env env,
  napi_callback_info info,
  bool crash_after_capture
) {
  size_t argc = 7;
  napi_value argv[7];
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 7) {
    napi_throw_type_error(env, NULL, "stable publication arguments are invalid");
    return NULL;
  }

  int32_t source_directory;
  int32_t destination_directory;
  uint64_t expected_device;
  uint64_t expected_inode;
  bool device_lossless;
  bool inode_lossless;
  char *source_name = NULL;
  char *destination_name = NULL;
  char *incomplete_name = NULL;
  if (!read_directory(env, argv[0], &source_directory) ||
      !read_name(env, argv[1], &source_name) ||
      !read_directory(env, argv[2], &destination_directory) ||
      !read_name(env, argv[3], &destination_name) ||
      napi_get_value_bigint_uint64(env, argv[4], &expected_device, &device_lossless) != napi_ok ||
      napi_get_value_bigint_uint64(env, argv[5], &expected_inode, &inode_lossless) != napi_ok ||
      !read_name(env, argv[6], &incomplete_name) ||
      !device_lossless || !inode_lossless) {
    free(source_name);
    free(destination_name);
    free(incomplete_name);
    napi_throw_type_error(env, NULL, "stable publication arguments are invalid");
    return NULL;
  }

  int result = publish_captured(source_directory, source_name, destination_directory,
    destination_name, expected_device, expected_inode, incomplete_name, crash_after_capture);
  free(source_name);
  free(destination_name);
  free(incomplete_name);

  napi_value output;
  if (napi_create_int32(env, result, &output) != napi_ok) return NULL;
  return output;
}

static napi_value publish_no_replace(napi_env env, napi_callback_info info) {
  return publish_no_replace_impl(env, info, false);
}

static napi_value test_crash_after_capture(napi_env env, napi_callback_info info) {
  return publish_no_replace_impl(env, info, true);
}

#endif

static napi_value try_lock_directory(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  int32_t directory;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1 ||
      !read_directory(env, argv[0], &directory)) {
    napi_throw_type_error(env, NULL, "stable directory process lock argument is invalid");
    return NULL;
  }
  bool acquired = false;
  if (flock(directory, LOCK_EX | LOCK_NB) == 0) {
    acquired = true;
  } else if (errno != EWOULDBLOCK && errno != EAGAIN) {
    napi_throw_error(env, NULL, "stable directory process lock acquisition failed");
    return NULL;
  }
  napi_value output;
  if (napi_get_boolean(env, acquired, &output) != napi_ok) return NULL;
  return output;
}

static napi_value unlock_directory(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  int32_t directory;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1 ||
      !read_directory(env, argv[0], &directory)) {
    napi_throw_type_error(env, NULL, "stable directory process lock argument is invalid");
    return NULL;
  }
  if (flock(directory, LOCK_UN) != 0) {
    napi_throw_error(env, NULL, "stable directory process lock release failed");
    return NULL;
  }
  napi_value output;
  if (napi_get_undefined(env, &output) != napi_ok) return NULL;
  return output;
}

#if defined(__linux__) || defined(__APPLE__)
/* Private Node-API primitives for Host scanner and artifact/receipt custody.
 * Included by the existing qualified translation unit, not a separate service. */
typedef struct { int fd; } host_descriptor;
static const napi_type_tag host_descriptor_tag = { 0x4a43cdb6e3264b01ULL, 0xb8c88c4473290ac2ULL };

static napi_value host_error(napi_env env, const char *message) {
  /* Preserve the positive OS errno before allocation or Node-API calls. */
  const int saved = errno;
  const char *code = host_errno_name(saved);
  napi_value text, error, number, symbol;
  if (napi_create_string_utf8(env, message, NAPI_AUTO_LENGTH, &text) != napi_ok ||
      napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &symbol) != napi_ok ||
      napi_create_error(env, symbol, text, &error) != napi_ok ||
      napi_create_int32(env, saved, &number) != napi_ok ||
      napi_set_named_property(env, error, "errno", number) != napi_ok) return NULL;
  napi_throw(env, error);
  return NULL;
}
/* Process-local, irreversible authority; neither exports nor JS handles own it. */
#ifdef __APPLE__
static atomic_bool host_guard_installed = ATOMIC_VAR_INIT(false);
static atomic_flag host_guard_installing = ATOMIC_FLAG_INIT;
static const char host_guard_profile[] =
  "(version 1)(allow default)(deny file-read-data file-write-data (require-not (require-any (vnode-type REGULAR-FILE) (vnode-type DIRECTORY))))";
static napi_value host_guard_status(napi_env env, napi_callback_info info) {
  (void)info;
  napi_value result;
  if (napi_get_boolean(env, atomic_load(&host_guard_installed), &result) != napi_ok) return NULL;
  return result;
}
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
static napi_value host_guard_initialize(napi_env env, napi_callback_info info) {
  (void)info;
  if (!atomic_load(&host_guard_installed)) {
    if (atomic_flag_test_and_set(&host_guard_installing)) {
      napi_throw_error(env, NULL, "Host acquisition guard initialization is in progress"); return NULL;
    }
    char *error = NULL;
    int status = atomic_load(&host_guard_installed) ? 0 : sandbox_init(host_guard_profile, 0, &error);
    if (status == 0) atomic_store(&host_guard_installed, true);
    atomic_flag_clear(&host_guard_installing);
    if (status != 0) {
      napi_throw_error(env, NULL, "Host acquisition guard installation failed; terminate child");
      if (error) sandbox_free_error(error);
      return NULL;
    }
    if (error) sandbox_free_error(error);
  }
  napi_value result;
  if (napi_get_undefined(env, &result) != napi_ok) return NULL;
  return result;
}
#pragma clang diagnostic pop
#endif
static bool host_require_guard(napi_env env) {
#ifdef __APPLE__
  if (!atomic_load(&host_guard_installed)) {
    napi_throw_error(env, NULL, "Host acquisition guard is not installed"); return false;
  }
#else
  (void)env;
#endif
  return true;
}
static void host_finalize(napi_env env, void *data, void *hint) {
  (void)env; (void)hint;
  host_descriptor *handle = data;
  if (handle->fd >= 0) close(handle->fd);
  free(handle);
}
static napi_value host_own(napi_env env, int fd) {
  if (fd < 0) return host_error(env, "Host descriptor open failed");
  host_descriptor *handle = malloc(sizeof(*handle));
  if (!handle) { close(fd); napi_throw_error(env, NULL, "Host descriptor allocation failed"); return NULL; }
  handle->fd = fd;
  napi_value object;
  if (napi_create_object(env, &object) != napi_ok ||
      napi_type_tag_object(env, object, &host_descriptor_tag) != napi_ok ||
      napi_wrap(env, object, handle, host_finalize, NULL, NULL) != napi_ok) {
    close(fd); free(handle); return NULL;
  }
  return object;
}
static host_descriptor *host_get(napi_env env, napi_value value) {
  bool valid = false;
  void *data = NULL;
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_object ||
      napi_check_object_type_tag(env, value, &host_descriptor_tag, &valid) != napi_ok || !valid ||
      napi_unwrap(env, value, &data) != napi_ok || !data || ((host_descriptor *)data)->fd < 0) {
    napi_throw_type_error(env, "EBADF", "Host descriptor is invalid or closed"); return NULL;
  }
  return data;
}
static bool host_args(napi_env env, napi_callback_info info, size_t count, napi_value *args) {
  size_t argc = count;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc != count) {
    napi_throw_type_error(env, NULL, "Host descriptor arguments are invalid"); return false;
  }
  return true;
}
static bool host_uint(napi_env env, napi_value value, uint32_t maximum, uint32_t *out) {
  double number;
  if (napi_get_value_double(env, value, &number) != napi_ok || !(number >= 0 && number <= maximum)) return false;
  *out = (uint32_t)number;
  return number == *out;
}
static napi_value host_root(napi_env env, napi_callback_info info) {
  if (!host_require_guard(env)) return NULL;
  (void)info;
  return host_own(env, open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
}
static napi_value host_open(napi_env env, napi_callback_info info) {
  if (!host_require_guard(env)) return NULL;
  napi_value args[3];
  if (!host_args(env, info, 3, args)) return NULL;
  host_descriptor *parent = host_get(env, args[0]);
  if (!parent) return NULL;
  char *name = NULL;
  uint32_t kind;
  if (!read_name(env, args[1], &name) || !host_uint(env, args[2], 2, &kind)) {
    free(name); napi_throw_type_error(env, NULL, "Host entry name or open kind is invalid"); return NULL;
  }
  /* Reject existing special files before invoking their open operation. This
   * observation must also match the captured descriptor. O_NONBLOCK protects
   * against FIFO replacement but is NOT an O_PATH equivalent for devices. */
  struct stat before;
  if (kind != 2) {
    if (fstatat(parent->fd, name, &before, AT_SYMLINK_NOFOLLOW) != 0) {
      int saved = errno; free(name); errno = saved;
      return host_error(env, "Host entry observation before open failed");
    }
    if ((!S_ISDIR(before.st_mode) && !S_ISREG(before.st_mode)) ||
        (kind == 1 && !S_ISDIR(before.st_mode))) {
      free(name); napi_throw_error(env, NULL, "Host entry open failed: not a regular file or directory"); return NULL;
    }
  }
  int flags = O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK | O_NOCTTY |
    (kind == 2 ? O_WRONLY | O_CREAT | O_EXCL : O_RDONLY) |
    (kind != 2 && S_ISDIR(before.st_mode) ? O_DIRECTORY : 0);
  int fd = openat(parent->fd, name, flags, 0600);
  int saved = errno;
  free(name);
  if (fd < 0) { errno = saved; return host_error(env, "Host entry open failed"); }
  struct stat observed;
  if (fstat(fd, &observed) != 0) {
    int saved = errno; close(fd); errno = saved;
    return host_error(env, "Host entry observation after open failed");
  }
  if (!S_ISDIR(observed.st_mode) && !S_ISREG(observed.st_mode)) {
    close(fd); napi_throw_error(env, NULL, "Host entry is not a regular file or directory"); return NULL;
  }
  if (kind != 2 && (before.st_dev != observed.st_dev || before.st_ino != observed.st_ino ||
      before.st_mode != observed.st_mode)) {
    close(fd); napi_throw_error(env, NULL, "Host entry changed during open"); return NULL;
  }
  return host_own(env, fd);
}
/* Quarantine observes the entry itself, never readable-opens a special file.
 * Directories alone are opened with O_DIRECTORY (including across replacement)
 * to prove their mount. rename_exclusive cannot move mounted entries; a raced
 * replacement is still subject to the shared captured-inode check/restoration. */
static bool host_same_mount(int left, int right) {
#ifdef __APPLE__
  struct statfs a, b;
  if (fstatfs(left, &a) != 0 || fstatfs(right, &b) != 0) return false;
  return memcmp(&a.f_fsid, &b.f_fsid, sizeof(a.f_fsid)) == 0 &&
    strnlen(a.f_mntonname, sizeof(a.f_mntonname)) < sizeof(a.f_mntonname) &&
    strnlen(b.f_mntonname, sizeof(b.f_mntonname)) < sizeof(b.f_mntonname) &&
    strcmp(a.f_mntonname, b.f_mntonname) == 0;
#else
  struct statx a, b;
  return statx(left, "", AT_EMPTY_PATH, STATX_MNT_ID, &a) == 0 &&
    statx(right, "", AT_EMPTY_PATH, STATX_MNT_ID, &b) == 0 &&
    (a.stx_mask & STATX_MNT_ID) && (b.stx_mask & STATX_MNT_ID) && a.stx_mnt_id == b.stx_mnt_id;
#endif
}
static napi_value host_quarantine(napi_env env, napi_callback_info info) {
  if (!host_require_guard(env)) return NULL;
  napi_value args[4], output;
  if (!host_args(env, info, 4, args)) return NULL;
  host_descriptor *source = host_get(env, args[0]);
  if (!source) return NULL;
  host_descriptor *destination = host_get(env, args[2]);
  if (!destination) return NULL;
  char *name = NULL, *target = NULL;
  if (!read_name(env, args[1], &name) || !read_name(env, args[3], &target)) {
    free(name); free(target);
    napi_throw_type_error(env, NULL, "Host quarantine names are invalid"); return NULL;
  }
  struct stat before, parent, target_parent;
  if (fstatat(source->fd, name, &before, AT_SYMLINK_NOFOLLOW) != 0 ||
      fstat(source->fd, &parent) != 0 || fstat(destination->fd, &target_parent) != 0) {
    int saved = errno; free(name); free(target); errno = saved;
    return host_error(env, "Host quarantine observation failed");
  }
  bool safe = S_ISDIR(parent.st_mode) && S_ISDIR(target_parent.st_mode) &&
    before.st_dev == parent.st_dev && host_same_mount(source->fd, destination->fd);
  if (safe && S_ISDIR(before.st_mode)) {
    int fd = openat(source->fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK);
    struct stat observed;
    safe = fd >= 0 && fstat(fd, &observed) == 0 &&
      observed.st_dev == before.st_dev && observed.st_ino == before.st_ino &&
      host_same_mount(source->fd, fd);
    if (fd >= 0) close(fd);
  }
  if (!safe) {
    free(name); free(target);
    napi_throw_error(env, NULL, "Host quarantine mount relationship is unproved"); return NULL;
  }
  char incomplete[256];
  int length = snprintf(incomplete, sizeof(incomplete), ".ar-publish-v1-%llx-%llx-%s.incomplete",
    (unsigned long long)before.st_dev, (unsigned long long)before.st_ino, target);
  if (length < 0 || (size_t)length >= sizeof(incomplete)) {
    free(name); free(target);
    napi_throw_range_error(env, NULL, "Host quarantine recovery name is too long"); return NULL;
  }
  int result = publish_captured(source->fd, name, destination->fd, target,
    before.st_dev, before.st_ino, incomplete, false);
  free(name); free(target);
  if (napi_create_int32(env, result, &output) != napi_ok) return NULL;
  return output;
}
static napi_value host_close(napi_env env, napi_callback_info info) {
  napi_value args[1], result;
  if (!host_args(env, info, 1, args)) return NULL;
  host_descriptor *handle = host_get(env, args[0]);
  if (!handle) return NULL;
  int fd = handle->fd;
  handle->fd = -1; /* Never retry close on a possibly reused descriptor. */
  if (close(fd) != 0) return host_error(env, "Host descriptor close failed");
  if (napi_get_undefined(env, &result) != napi_ok) return NULL;
  return result;
}
static napi_value host_fd(napi_env env, napi_callback_info info) {
  napi_value args[1], result;
  if (!host_args(env, info, 1, args)) return NULL;
  host_descriptor *handle = host_get(env, args[0]);
  if (!handle || napi_create_int32(env, handle->fd, &result) != napi_ok) return NULL;
  return result;
}
static napi_value host_duplicate(napi_env env, napi_callback_info info) {
  if (!host_require_guard(env)) return NULL;
  napi_value args[1];
  if (!host_args(env, info, 1, args)) return NULL;
  host_descriptor *handle = host_get(env, args[0]);
  if (!handle) return NULL;
  return host_own(env, fcntl(handle->fd, F_DUPFD_CLOEXEC, 0));
}
static bool host_bigint(napi_env env, napi_value object, const char *key, int64_t number) {
  napi_value value;
  return napi_create_bigint_int64(env, number, &value) == napi_ok &&
    napi_set_named_property(env, object, key, value) == napi_ok;
}
static napi_value host_stat(napi_env env, napi_callback_info info) {
  napi_value args[1], result;
  if (!host_args(env, info, 1, args)) return NULL;
  host_descriptor *handle = host_get(env, args[0]);
  if (!handle) return NULL;
  struct stat st;
  if (fstat(handle->fd, &st) != 0) return host_error(env, "Host descriptor observation failed");
#ifdef __APPLE__
  struct timespec ctime = st.st_ctimespec, mtime = st.st_mtimespec;
#else
  struct timespec ctime = st.st_ctim, mtime = st.st_mtim;
#endif
  if (napi_create_object(env, &result) != napi_ok ||
      !host_bigint(env, result, "dev", st.st_dev) || !host_bigint(env, result, "ino", st.st_ino) ||
      !host_bigint(env, result, "mode", st.st_mode) || !host_bigint(env, result, "uid", st.st_uid) ||
      !host_bigint(env, result, "nlink", st.st_nlink) || !host_bigint(env, result, "size", st.st_size) ||
      !host_bigint(env, result, "ctimeNs", (int64_t)ctime.tv_sec * 1000000000 + ctime.tv_nsec) ||
      !host_bigint(env, result, "mtimeNs", (int64_t)mtime.tv_sec * 1000000000 + mtime.tv_nsec)) return NULL;
  return result;
}
static napi_value host_names(napi_env env, napi_callback_info info) {
  if (!host_require_guard(env)) return NULL;
  napi_value args[2], result;
  if (!host_args(env, info, 2, args)) return NULL;
  host_descriptor *handle = host_get(env, args[0]);
  if (!handle) return NULL;
  uint32_t maximum;
  if (!host_uint(env, args[1], 4096, &maximum)) {
    napi_throw_range_error(env, NULL, "Host directory enumeration limit is invalid"); return NULL;
  }
  /* A fresh open description gives an independent enumeration offset. */
  int fd = openat(handle->fd, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return host_error(env, "Host enumeration descriptor open failed");
  DIR *directory = fdopendir(fd);
  if (!directory) { int saved = errno; close(fd); errno = saved; return host_error(env, "Host fdopendir failed"); }
  if (napi_create_array(env, &result) != napi_ok) { closedir(directory); return NULL; }
  uint32_t count = 0;
  for (;;) {
    errno = 0;
    struct dirent *entry = readdir(directory);
    if (!entry) {
      int saved = errno;
      int closed = closedir(directory);
      if (saved || closed != 0) { if (saved) errno = saved; return host_error(env, "Host enumeration failed"); }
      return result;
    }
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    size_t length = strnlen(entry->d_name, 256);
    /* Reject before adding an element or allocating a proportional string. */
    if (count >= maximum || length == 0 || length > 255) {
      closedir(directory); napi_throw_range_error(env, NULL, "Host directory exceeded bounded enumeration"); return NULL;
    }
    napi_value name;
    if (napi_create_buffer_copy(env, length, entry->d_name, NULL, &name) != napi_ok ||
        napi_set_element(env, result, count++, name) != napi_ok) { closedir(directory); return NULL; }
  }
}
static napi_value host_read(napi_env env, napi_callback_info info) {
  napi_value args[3], result;
  if (!host_args(env, info, 3, args)) return NULL;
  host_descriptor *handle = host_get(env, args[0]);
  if (!handle) return NULL;
  void *data; size_t size; uint32_t position;
  if (napi_get_buffer_info(env, args[1], &data, &size) != napi_ok || size > 65536 ||
      !host_uint(env, args[2], 33554432, &position)) {
    napi_throw_range_error(env, NULL, "Host bounded read arguments are invalid"); return NULL;
  }
  ssize_t count;
  do { count = pread(handle->fd, data, size, position); } while (count < 0 && errno == EINTR);
  if (count < 0) return host_error(env, "Host descriptor read failed");
  if (napi_create_int64(env, count, &result) != napi_ok) return NULL;
  return result;
}
static napi_value host_write(napi_env env, napi_callback_info info) {
  napi_value args[2], result;
  if (!host_args(env, info, 2, args)) return NULL;
  host_descriptor *handle = host_get(env, args[0]);
  if (!handle) return NULL;
  void *data; size_t size;
  if (napi_get_buffer_info(env, args[1], &data, &size) != napi_ok || size > 65536) {
    napi_throw_range_error(env, NULL, "Host write chunk exceeds bound"); return NULL;
  }
  size_t offset = 0;
  while (offset < size) {
    ssize_t count = write(handle->fd, (char *)data + offset, size - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) return host_error(env, "Host descriptor write failed");
    if (count == 0) { napi_throw_error(env, NULL, "Host descriptor write made no progress"); return NULL; }
    offset += count;
  }
  if (napi_get_undefined(env, &result) != napi_ok) return NULL;
  return result;
}
static napi_value host_sync(napi_env env, napi_callback_info info) {
  napi_value args[1], result;
  if (!host_args(env, info, 1, args)) return NULL;
  host_descriptor *handle = host_get(env, args[0]);
  if (!handle) return NULL;
  if (fsync(handle->fd) != 0) return host_error(env, "Host descriptor sync failed");
  if (napi_get_undefined(env, &result) != napi_ok) return NULL;
  return result;
}
static napi_value host_chmod(napi_env env, napi_callback_info info) {
  napi_value args[2], result; uint32_t mode;
  if (!host_args(env, info, 2, args)) return NULL;
  host_descriptor *handle = host_get(env, args[0]);
  if (!handle) return NULL;
  if (!host_uint(env, args[1], 0777, &mode)) { napi_throw_type_error(env, NULL, "Host mode is invalid"); return NULL; }
  if (fchmod(handle->fd, mode) != 0) return host_error(env, "Host descriptor chmod failed");
  if (napi_get_undefined(env, &result) != napi_ok) return NULL;
  return result;
}
static napi_value host_entry_mutation(napi_env env, napi_callback_info info, bool create) {
  napi_value args[2], result; char *name = NULL;
  if (!host_args(env, info, 2, args)) return NULL;
  host_descriptor *parent = host_get(env, args[0]);
  if (!parent) return NULL;
  if (!read_name(env, args[1], &name)) { napi_throw_type_error(env, NULL, "Host entry name is invalid"); return NULL; }
  int status = create ? mkdirat(parent->fd, name, 0700) : unlinkat(parent->fd, name, 0);
  int saved = errno; free(name);
  if (status != 0) { errno = saved; return host_error(env, "Host directory entry mutation failed"); }
  if (napi_get_undefined(env, &result) != napi_ok) return NULL;
  return result;
}
static napi_value host_mkdir(napi_env env, napi_callback_info info) { return host_entry_mutation(env, info, true); }
static napi_value host_unlink(napi_env env, napi_callback_info info) { return host_entry_mutation(env, info, false); }
#ifdef __APPLE__
static napi_value host_path(napi_env env, napi_callback_info info) {
  napi_value args[1], result;
  if (!host_args(env, info, 1, args)) return NULL;
  host_descriptor *handle = host_get(env, args[0]);
  if (!handle) return NULL;
  char path[MAXPATHLEN];
  if (fcntl(handle->fd, F_GETPATH, path) != 0) return host_error(env, "Host descriptor path observation failed");
  if (napi_create_string_utf8(env, path, strnlen(path, sizeof(path)), &result) != napi_ok) return NULL;
  return result;
}
static napi_value host_mount(napi_env env, napi_callback_info info) {
  napi_value args[1], result;
  if (!host_args(env, info, 1, args)) return NULL;
  host_descriptor *handle = host_get(env, args[0]);
  if (!handle) return NULL;
  struct statfs fs;
  if (fstatfs(handle->fd, &fs) != 0) return host_error(env, "Host descriptor mount observation failed");
  /* Include mount location as well as filesystem ID: device equality alone is
   * not mount equality, including stacked/aliased namespace mounts. */
  char identity[2 * MNAMELEN + 80];
  int used = snprintf(identity, sizeof(identity), "darwin:%08x:%08x:",
    (unsigned int)fs.f_fsid.val[0], (unsigned int)fs.f_fsid.val[1]);
  size_t length = strnlen(fs.f_mntonname, sizeof(fs.f_mntonname));
  if (used < 0 || length == sizeof(fs.f_mntonname)) { napi_throw_error(env, NULL, "Host mount identity is invalid"); return NULL; }
  for (size_t i = 0; i < length; i++) {
    snprintf(identity + used + 2 * i, sizeof(identity) - used - 2 * i, "%02x", (unsigned char)fs.f_mntonname[i]);
  }
  if (napi_create_string_utf8(env, identity, used + 2 * length, &result) != napi_ok) return NULL;
  return result;
}
#endif
static bool host_exports(napi_env env, napi_value exports) {
  const napi_property_descriptor properties[] = {
#define HOST_EXPORT(name, fn) { name, NULL, fn, NULL, NULL, NULL, napi_default, NULL }
    HOST_EXPORT("hostRoot", host_root), HOST_EXPORT("hostOpen", host_open),
    HOST_EXPORT("hostClose", host_close), HOST_EXPORT("hostFd", host_fd),
    HOST_EXPORT("hostDuplicate", host_duplicate), HOST_EXPORT("hostStat", host_stat),
    HOST_EXPORT("hostNames", host_names), HOST_EXPORT("hostRead", host_read),
    HOST_EXPORT("hostWrite", host_write), HOST_EXPORT("hostSync", host_sync),
    HOST_EXPORT("hostChmod", host_chmod), HOST_EXPORT("hostMkdir", host_mkdir),
    HOST_EXPORT("hostUnlink", host_unlink), HOST_EXPORT("hostQuarantine", host_quarantine),
#ifdef __APPLE__
    HOST_EXPORT("initializeDarwinHostAcquisitionGuard", host_guard_initialize),
    HOST_EXPORT("isDarwinHostAcquisitionGuardInstalled", host_guard_status),
    HOST_EXPORT("hostPath", host_path), HOST_EXPORT("hostMount", host_mount),
#endif
#undef HOST_EXPORT
  };
  return napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties) == napi_ok;
}

#endif

NAPI_MODULE_INIT() {
#if defined(__linux__) || defined(__APPLE__)
  if (!host_exports(env, exports)) return NULL;
#endif
#if defined(__linux__) || defined(__APPLE__)
  napi_value publication;
  napi_value crash_test;
  if (napi_create_function(env, "publishNoReplace", NAPI_AUTO_LENGTH,
        publish_no_replace, NULL, &publication) != napi_ok ||
      napi_set_named_property(env, exports, "publishNoReplace", publication) != napi_ok ||
      napi_create_function(env, "testCrashAfterCapture", NAPI_AUTO_LENGTH,
        test_crash_after_capture, NULL, &crash_test) != napi_ok ||
      napi_set_named_property(env, exports, "testCrashAfterCapture", crash_test) != napi_ok) {
    return NULL;
  }
#endif
  napi_value process_lock;
  napi_value process_unlock;
  if (napi_create_function(env, "tryLockDirectory", NAPI_AUTO_LENGTH,
        try_lock_directory, NULL, &process_lock) != napi_ok ||
      napi_set_named_property(env, exports, "tryLockDirectory", process_lock) != napi_ok ||
      napi_create_function(env, "unlockDirectory", NAPI_AUTO_LENGTH,
        unlock_directory, NULL, &process_unlock) != napi_ok ||
      napi_set_named_property(env, exports, "unlockDirectory", process_unlock) != napi_ok) {
    return NULL;
  }
  return exports;
}
