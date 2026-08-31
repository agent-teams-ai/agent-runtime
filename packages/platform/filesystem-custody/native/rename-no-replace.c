#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <linux/fs.h>
#include <node_api.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

enum outcome {
  outcome_exists = 73,
  outcome_unsupported = 74,
  outcome_failure = 75,
  outcome_source_changed = 76,
  outcome_ambiguous_residue = 77
};

static int read_name(napi_env env, napi_value value, char **output) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok || length > 4096) {
    return 0;
  }
  char *buffer = malloc(length + 1);
  if (buffer == NULL) return 0;
  size_t written = 0;
  if (napi_get_value_string_utf8(env, value, buffer, length + 1, &written) != napi_ok ||
      written != length) {
    free(buffer);
    return 0;
  }
  *output = buffer;
  return 1;
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
  if (napi_get_value_int32(env, argv[0], &source_directory) != napi_ok ||
      !read_name(env, argv[1], &source_name) ||
      napi_get_value_int32(env, argv[2], &destination_directory) != napi_ok ||
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
    } else if (syscall(
      SYS_renameat2, destination_directory, incomplete_name,
      source_directory, source_name, RENAME_NOREPLACE
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
    } else if (syscall(
      SYS_renameat2,
      source_directory,
      source_name,
      destination_directory,
      incomplete_name,
      RENAME_NOREPLACE
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
      else if (syscall(
        SYS_renameat2, destination_directory, incomplete_name,
        source_directory, source_name, RENAME_NOREPLACE
      ) == 0) result = outcome_source_changed;
      else result = outcome_failure;
    } else if (syscall(
      SYS_renameat2, destination_directory, incomplete_name,
      destination_directory, destination_name, RENAME_NOREPLACE
    ) == 0) result = 0;
    else if (errno == EEXIST || errno == ENOTEMPTY) {
      /* Best-effort restoration preserves the old no-overwrite contract. */
      if (syscall(
        SYS_renameat2, destination_directory, incomplete_name,
        source_directory, source_name, RENAME_NOREPLACE
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

static napi_value try_lock_directory(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  int32_t directory;
  struct stat observation;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1 ||
      napi_get_value_int32(env, argv[0], &directory) != napi_ok || directory < 0 ||
      fstat(directory, &observation) != 0 || !S_ISDIR(observation.st_mode)) {
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
      napi_get_value_int32(env, argv[0], &directory) != napi_ok || directory < 0) {
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

NAPI_MODULE_INIT() {
  napi_value publication;
  napi_value crash_test;
  napi_value process_lock;
  napi_value process_unlock;
  if (napi_create_function(
        env,
        "publishNoReplace",
        NAPI_AUTO_LENGTH,
        publish_no_replace,
        NULL,
        &publication
      ) != napi_ok ||
      napi_set_named_property(env, exports, "publishNoReplace", publication) != napi_ok ||
      napi_create_function(
        env,
        "testCrashAfterCapture",
        NAPI_AUTO_LENGTH,
        test_crash_after_capture,
        NULL,
        &crash_test
      ) != napi_ok ||
      napi_set_named_property(env, exports, "testCrashAfterCapture", crash_test) != napi_ok ||
      napi_create_function(
        env,
        "tryLockDirectory",
        NAPI_AUTO_LENGTH,
        try_lock_directory,
        NULL,
        &process_lock
      ) != napi_ok ||
      napi_set_named_property(env, exports, "tryLockDirectory", process_lock) != napi_ok ||
      napi_create_function(
        env,
        "unlockDirectory",
        NAPI_AUTO_LENGTH,
        unlock_directory,
        NULL,
        &process_unlock
      ) != napi_ok ||
      napi_set_named_property(env, exports, "unlockDirectory", process_unlock) != napi_ok) {
    return NULL;
  }
  return exports;
}
