/* AE-private protocol v1. Observer of one retained direct child of our parent.
 * No enumeration of PIDs, signals, policy installation or recovery authority.
 * Name-bound pins and wrapper semantics remain trusted Host assumptions. */
#include <libproc.h>
#include <sys/proc_info.h>
#include <sys/stat.h>
#include <mach/vm_prot.h>
#include <unistd.h>
#include <stdint.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <limits.h>

static int bsd(pid_t pid, struct proc_bsdinfo *out) {
  memset(out, 0, sizeof(*out));
  return proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, out, sizeof(*out)) == (int)sizeof(*out)
    && out->pbi_pid == (uint32_t)pid && out->pbi_ppid == (uint32_t)getppid()
    && out->pbi_uid == getuid() && out->pbi_start_tvsec != 0;
}
static int same(const struct proc_bsdinfo *a, const struct proc_bsdinfo *b) {
  return a->pbi_pid == b->pbi_pid && a->pbi_ppid == b->pbi_ppid && a->pbi_pgid == b->pbi_pgid
    && a->pbi_start_tvsec == b->pbi_start_tvsec && a->pbi_start_tvusec == b->pbi_start_tvusec;
}
int main(int argc, char **argv) {
  if (argc != 3 || argv[2][0] != '/') return 64;
  char *end = NULL; errno = 0;
  long value = strtol(argv[1], &end, 10);
  if (errno || !end || *end || value < 2 || value > INT_MAX || value == getpid()) return 64;
  pid_t pid = (pid_t)value;
  struct proc_bsdinfo before, after;
  if (!bsd(pid, &before)) return 65;
  char path[PROC_PIDPATHINFO_MAXSIZE], final_path[PROC_PIDPATHINFO_MAXSIZE];
  memset(path, 0, sizeof(path)); memset(final_path, 0, sizeof(final_path));
  /* proc_pidpath is only a corroboration, never the mapped-image proof. */
  if (proc_pidpath(pid, path, sizeof(path)) <= 0 || strcmp(path, argv[2])) return 66;
  struct stat target;
  if (lstat(argv[2], &target) || !S_ISREG(target.st_mode) || target.st_nlink != 1) return 67;
  uint64_t cursor = 0; int found = 0;
  struct vinfo_stat image;
  memset(&image, 0, sizeof(image));
  for (unsigned count = 0; count < 4096; count++) {
    struct proc_regionwithpathinfo region;
    memset(&region, 0, sizeof(region));
    if (proc_pidinfo(pid, PROC_PIDREGIONPATHINFO, cursor, &region, sizeof(region)) != (int)sizeof(region)) break;
    const struct proc_regioninfo *r = &region.prp_prinfo;
    const struct vinfo_stat *v = &region.prp_vip.vip_vi.vi_stat;
    if (r->pri_address < cursor || !r->pri_size || UINT64_MAX - r->pri_address < r->pri_size) return 68;
    if ((r->pri_protection & VM_PROT_EXECUTE) && r->pri_offset == 0 &&
        v->vst_dev == (uint32_t)target.st_dev && v->vst_ino == (uint64_t)target.st_ino &&
        S_ISREG(v->vst_mode) && v->vst_nlink == 1 && v->vst_size == target.st_size &&
        v->vst_mtime == target.st_mtimespec.tv_sec && v->vst_mtimensec == target.st_mtimespec.tv_nsec &&
        v->vst_ctime == target.st_ctimespec.tv_sec && v->vst_ctimensec == target.st_ctimespec.tv_nsec) {
      image = *v; found = 1; break;
    }
    cursor = r->pri_address + r->pri_size;
  }
  struct stat final_target;
  if (lstat(argv[2], &final_target) || final_target.st_dev != target.st_dev || final_target.st_ino != target.st_ino ||
      final_target.st_size != target.st_size || final_target.st_nlink != 1 ||
      final_target.st_mtimespec.tv_sec != target.st_mtimespec.tv_sec || final_target.st_mtimespec.tv_nsec != target.st_mtimespec.tv_nsec ||
      final_target.st_ctimespec.tv_sec != target.st_ctimespec.tv_sec || final_target.st_ctimespec.tv_nsec != target.st_ctimespec.tv_nsec) return 69;
  if (!found || !bsd(pid, &after) || !same(&before, &after) ||
      proc_pidpath(pid, final_path, sizeof(final_path)) <= 0 || strcmp(path, final_path)) return 69;
  printf("{\"protocol\":\"ae-darwin-owned-image/v1\",\"pid\":%u,\"ppid\":%u,\"pgid\":%u,"
    "\"birthSeconds\":\"%" PRIu64 "\",\"birthMicros\":\"%" PRIu64 "\",\"dev\":\"%u\",\"ino\":\"%" PRIu64 "\"}\n",
    after.pbi_pid, after.pbi_ppid, after.pbi_pgid, after.pbi_start_tvsec, after.pbi_start_tvusec,
    image.vst_dev, image.vst_ino);
  return ferror(stdout) ? 70 : 0;
}
