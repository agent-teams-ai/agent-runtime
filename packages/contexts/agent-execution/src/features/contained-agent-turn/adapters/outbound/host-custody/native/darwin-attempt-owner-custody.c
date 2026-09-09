#include "darwin-attempt-owner-custody.h"
#ifdef __APPLE__
#include <CommonCrypto/CommonDigest.h>
#include <sys/stat.h>
#include <sys/acl.h>
#include <sys/xattr.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <time.h>

static const char *const workspace_names[]={"workspace", "workspace.frozen", "workspace.cleanup", "workspace.closed"};
static const char *const slots[]={AE_SLOT_0, AE_SLOT_1};
static int unknown(ae_custody *c) {
  c->unknown=1; c->state.phase=AE_QUARANTINED; c->state.cutoff=1; return 0;
}
/* Invalidate the integer BEFORE close; never retry a possibly reused FD. */
static int close_once(int *fd) {
  int owned=*fd; *fd=-1; return owned<0 || close(owned)==0;
}
static int sync_fd(int fd) {
  return fsync(fd)==0 && fcntl(fd,F_FULLFSYNC)==0;
}
static int same(const struct stat *a, const struct stat *b) {
  return a->st_dev==b->st_dev && a->st_ino==b->st_ino && a->st_mode==b->st_mode &&
    a->st_nlink==b->st_nlink && a->st_size==b->st_size &&
    a->st_mtimespec.tv_sec==b->st_mtimespec.tv_sec && a->st_mtimespec.tv_nsec==b->st_mtimespec.tv_nsec &&
    a->st_ctimespec.tv_sec==b->st_ctimespec.tv_sec && a->st_ctimespec.tv_nsec==b->st_ctimespec.tv_nsec;
}
static int workspace_identity(ae_custody *c) {
  if (c->state.workspace<AE_ACTIVE || c->state.workspace>AE_CLOSED ||
      c->state.workspace_dev!=c->device || c->state.workspace_ino!=c->inode) return 0;
  struct stat held, named;
  return !c->unknown && fstat(c->workspace,&held)==0 && S_ISDIR(held.st_mode) &&
    (uint64_t)held.st_dev==c->device && (uint64_t)held.st_ino==c->inode &&
    fstatat(c->envelope,workspace_names[c->state.workspace],&named,AT_SYMLINK_NOFOLLOW)==0 &&
    same(&held,&named);
}
static void be32(uint8_t *b, uint32_t v) {
  b[0]=(uint8_t)(v>>24); b[1]=(uint8_t)(v>>16); b[2]=(uint8_t)(v>>8); b[3]=(uint8_t)v;
}
static void be64(uint8_t *b, uint64_t v) { be32(b,(uint32_t)(v>>32)); be32(b+4,(uint32_t)v); }
/* Fixed private storage encoding, distinct from command framing. No raw struct
 * padding, native endianness, silent overwrite or best-effort durability.
 * Each sequence has an immutable intent file. A torn entry is permanent debt;
 * restart must not skip it. This slice intentionally provides no recovery allocator. */
static void record_bytes(const ae_state *s, uint8_t b[192]) {
  memset(b,0,192);
  memcpy(b,"ae-owner-intent-v1",18);
  memcpy(b+24,s->binding,32); memcpy(b+56,s->launch,32);
  be32(b+88,(uint32_t)s->phase); be32(b+92,(uint32_t)s->workspace);
  be32(b+96,s->sequence); be32(b+100,s->settlements);
  be64(b+104,s->workspace_dev); be64(b+112,s->workspace_ino);
  be32(b+120,(uint32_t)s->cutoff); be32(b+124,(uint32_t)s->streams_sealed);
  be32(b+128,(uint32_t)s->reaped); be32(b+132,(uint32_t)s->preexec_applied);
  be32(b+136,(uint32_t)s->exit_code); be32(b+140,(uint32_t)s->exit_signal);
  be32(b+144,s->revision); be32(b+148,s->pending_effect);
  be32(b+152,s->pending_argument); be32(b+156,(uint32_t)s->birth_attempted);
  CC_SHA256(b,160,b+160);
}
int ae_native_persist(void *context, const ae_state *s) {
  ae_custody *c=context;
  uint8_t b[192]; char name[40],stage[40];
  if (c->unknown || snprintf(name,sizeof(name),"intent-%010u",s->revision)<0 ||
      snprintf(stage,sizeof(stage),"stage-%010u",s->revision)<0) return 0;
  record_bytes(s,b);
  int fd=openat(c->journal,stage,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600);
  if (fd<0) return unknown(c);
  /* A short write is uncertain and deliberately not retried. */
  int ok=write(fd,b,sizeof(b))==(ssize_t)sizeof(b) && sync_fd(fd);
  if (!close_once(&fd)) ok=0;
  if (ok) ok=renameatx_np(c->journal,stage,c->journal,name,RENAME_EXCL)==0;
  if (!sync_fd(c->journal)) ok=0;
  return ok ? 1 : unknown(c);
}
static int commit_effect(ae_custody *c, ae_state *next) {
  next->pending_effect=0;
  next->pending_argument=0;
  return ae_commit(&c->state,next,ae_native_persist,c)==AE_ACCEPTED;
}
int ae_native_workspace_move(ae_custody *c, ae_workspace target) {
  if (!ae_writer_stopped(&c->state) || !workspace_identity(c) ||
      target!=c->state.workspace+1 || target>AE_CLOSED ||
      c->state.pending_effect!=(target==AE_FROZEN ? AE_WORKSPACE_FREEZE :
        target==AE_CLEANUP ? AE_WORKSPACE_CLEANUP : AE_WORKSPACE_CLOSE) ||
      (target>=AE_CLEANUP && !(c->state.settlements&2))) return 0;
  /* The command intent has already committed. Native effect completion gets a
   * separate sequence. No success is inferred if rename happened but sync failed. */
  if (renameatx_np(c->envelope,workspace_names[c->state.workspace],
      c->envelope,workspace_names[target],RENAME_EXCL)!=0 || !sync_fd(c->envelope)) return unknown(c);
  ae_state next=c->state; next.workspace=target;
  struct stat st;
  if (fstatat(c->envelope,workspace_names[target],&st,AT_SYMLINK_NOFOLLOW)!=0 ||
      !S_ISDIR(st.st_mode) || (uint64_t)st.st_dev!=c->device || (uint64_t)st.st_ino!=c->inode)
    return unknown(c);
  return commit_effect(c,&next);
}
static int no_acl(int fd) {
  acl_t acl=acl_get_fd_np(fd,ACL_TYPE_EXTENDED);
  if (!acl) return 0;
  acl_entry_t entry;
  int result=acl_get_entry(acl,ACL_FIRST_ENTRY,&entry);
  int released=acl_free(acl);
  return result==0 && released==0;
}
/* Enumerate the WHOLE restricted writable tree. Reject extra entries, nested
 * directories, symlinks, mounts, hardlinks, ACLs, flags and missing fixed slots.
 * Bounds are on the enumeration, not just the selected output. */
static int complete_tree(ae_custody *c) {
  int scan=openat(c->workspace,".",O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
  if (scan<0) return 0;
  DIR *dir=fdopendir(scan);
  if (!dir) { if (!close_once(&scan)) unknown(c); return 0; }
  unsigned seen=0, count=0; int ok=1;
  for (;;) {
    errno=0; struct dirent *e=readdir(dir);
    if (!e) { if (errno) ok=0; break; }
    if (!strcmp(e->d_name,".") || !strcmp(e->d_name,"..")) continue;
    if (++count>AE_ARTIFACT_SLOTS) { ok=0; break; }
    int slot=!strcmp(e->d_name,slots[0]) ? 0 : !strcmp(e->d_name,slots[1]) ? 1 : -1;
    if (slot<0 || (seen&(1u<<slot))) { ok=0; break; }
    struct stat st;
    if (fstatat(c->workspace,e->d_name,&st,AT_SYMLINK_NOFOLLOW)!=0 ||
        !S_ISREG(st.st_mode) || st.st_nlink!=1 || (uint64_t)st.st_dev!=c->device ||
        st.st_size<0 || st.st_size>AE_ARTIFACT_MAX_BYTES || st.st_flags!=0 ||
        (st.st_mode&07000)!=0) { ok=0; break; }
    seen|=1u<<slot;
  }
  if (closedir(dir)!=0) { unknown(c); ok=0; }
  return ok && seen==3;
}
int ae_native_artifact(ae_custody *c, uint32_t slot, ae_artifact *out) {
  if (!out) return 0;
  memset(out,0,sizeof(*out));
  if (slot>=AE_ARTIFACT_SLOTS || c->state.pending_effect!=AE_READ_ARTIFACT_SLOT ||
      slot!=c->state.pending_argument || !ae_writer_stopped(&c->state) ||
      c->state.workspace!=AE_FROZEN || !workspace_identity(c) || !complete_tree(c)) return 0;
  int fd=openat(c->workspace,slots[slot],O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC);
  if (fd<0) return unknown(c);
  struct stat before,after,named;
  int ok=fstat(fd,&before)==0 && S_ISREG(before.st_mode) && before.st_nlink==1 &&
    (uint64_t)before.st_dev==c->device && before.st_size>=0 &&
    before.st_size<=AE_ARTIFACT_MAX_BYTES && before.st_flags==0 && no_acl(fd) &&
    flistxattr(fd,NULL,0,0)==0;
  uint8_t *bytes=NULL;
  if (ok) {
    bytes=malloc((size_t)before.st_size+1);
    ok=bytes!=NULL;
  }
  size_t used=0;
  while (ok && used<(size_t)before.st_size) {
    ssize_t n=read(fd,bytes+used,(size_t)before.st_size-used);
    if (n<=0) { ok=0; break; }
    used+=(size_t)n;
  }
  uint8_t extra;
  if (ok) ok=read(fd,&extra,1)==0 && fstat(fd,&after)==0 && same(&before,&after) &&
    fstatat(c->workspace,slots[slot],&named,AT_SYMLINK_NOFOLLOW)==0 && same(&before,&named);
  if (!close_once(&fd)) ok=0;
  if (ok) ok=workspace_identity(c) && complete_tree(c);
  if (!ok) { free(bytes); return unknown(c); }
  ae_state next=c->state;
  if (!commit_effect(c,&next)) { free(bytes); return 0; }
  out->bytes=bytes; out->length=used; out->device=(uint64_t)before.st_dev;
  out->inode=(uint64_t)before.st_ino; out->mode=(uint32_t)(before.st_mode&0777);
  return 1; /* Bytes only; no FD and no artifact receipt. Caller frees bytes. */
}

typedef struct {
  unsigned entries, directories; size_t bytes; struct timespec start;
  uint64_t seen_inodes[256];
} budget;
static int within_budget(budget *b) {
  struct timespec now;
  return clock_gettime(CLOCK_MONOTONIC,&now)==0 && now.tv_sec-b->start.tv_sec<2 &&
    b->entries<=256 && b->bytes<=8*AE_ARTIFACT_MAX_BYTES;
}
static int remove_entries(ae_custody *c,int fd, unsigned depth,budget *b) {
  if (depth>8 || !within_budget(b) || b->directories>=256) return 0;
  struct stat directory;
  if (fstat(fd,&directory)!=0 || !S_ISDIR(directory.st_mode) ||
      (uint64_t)directory.st_dev!=c->device || (uint64_t)directory.st_ino==c->inode) return 0;
  for (unsigned i=0;i<b->directories;i++) if (b->seen_inodes[i]==(uint64_t)directory.st_ino) return 0;
  b->seen_inodes[b->directories++]=(uint64_t)directory.st_ino;
  int copy=openat(fd,".",O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
  if (copy<0) return 0;
  DIR *dir=fdopendir(copy);
  if (!dir) { if (!close_once(&copy)) unknown(c); return 0; }
  int ok=1;
  for (;;) {
    errno=0; struct dirent *e=readdir(dir);
    if (!e) { if (errno) ok=0; break; }
    if (!strcmp(e->d_name,".") || !strcmp(e->d_name,"..")) continue;
    b->entries++;
    struct stat st,opened,again;
    if (!within_budget(b) || fstatat(fd,e->d_name,&st,AT_SYMLINK_NOFOLLOW)!=0 ||
        (uint64_t)st.st_dev!=c->device || st.st_flags ||
        (!S_ISREG(st.st_mode) && !S_ISDIR(st.st_mode)) ||
        (S_ISREG(st.st_mode) && (st.st_nlink!=1 || st.st_size<0 || st.st_size>8*AE_ARTIFACT_MAX_BYTES))) { ok=0; break; }
    if (S_ISREG(st.st_mode)) b->bytes+=(size_t)st.st_size;
    if (!within_budget(b)) { ok=0; break; }
    if (S_ISDIR(st.st_mode)) {
      int child=openat(fd,e->d_name,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
      ok=child>=0 && fstat(child,&opened)==0 && same(&st,&opened) &&
        remove_entries(c,child,depth+1,b);
      /* Directory size/time changes during removal; retained dev/inode bind it. */
      if (ok) ok=fstatat(fd,e->d_name,&again,AT_SYMLINK_NOFOLLOW)==0 &&
        S_ISDIR(again.st_mode) && again.st_dev==st.st_dev && again.st_ino==st.st_ino;
      if (!close_once(&child)) ok=0;
      if (ok) ok=unlinkat(fd,e->d_name,AT_REMOVEDIR)==0;
    } else {
      ok=fstatat(fd,e->d_name,&again,AT_SYMLINK_NOFOLLOW)==0 && same(&st,&again) &&
        unlinkat(fd,e->d_name,0)==0;
    }
    if (!ok) break;
  }
  if (closedir(dir)!=0) ok=0;
  return ok && sync_fd(fd);
}
int ae_native_dispose_private(ae_custody *c) {
  if (!ae_writer_stopped(&c->state) || !c->state.streams_sealed ||
      c->state.pending_effect!=AE_DISPOSE_ONCE ||
      c->state.settlements!=15 ||
      c->state.workspace!=AE_CLOSED || !workspace_identity(c)) return 0;
  struct stat before,held,after;
  if (fstatat(c->envelope,"private",&before,AT_SYMLINK_NOFOLLOW)!=0 ||
      !S_ISDIR(before.st_mode) || (uint64_t)before.st_dev!=c->device ||
      (uint64_t)before.st_dev!=c->private_device || (uint64_t)before.st_ino!=c->private_inode) return unknown(c);
  int fd=openat(c->envelope,"private",O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
  budget b={0};
  int ok=fd>=0 && fstat(fd,&held)==0 && same(&before,&held) &&
    clock_gettime(CLOCK_MONOTONIC,&b.start)==0 && remove_entries(c,fd,0,&b);
  if (ok) ok=fstatat(c->envelope,"private",&after,AT_SYMLINK_NOFOLLOW)==0 &&
    S_ISDIR(after.st_mode) && after.st_dev==before.st_dev && after.st_ino==before.st_ino;
  if (!close_once(&fd)) ok=0;
  if (ok) ok=unlinkat(c->envelope,"private",AT_REMOVEDIR)==0 && sync_fd(c->envelope) && workspace_identity(c);
  if (!ok) return unknown(c);
  ae_state next=c->state; next.phase=AE_DISPOSED;
  return commit_effect(c,&next); /* Not RELEASED: handles/retention handoff remain. */
}
int ae_native_read_closed(ae_custody *c) {
  if (c->state.phase!=AE_RELEASED || c->state.workspace!=AE_CLOSED || !workspace_identity(c)) return 0;
  for (unsigned i=0;i<AE_CLOSED;i++) {
    struct stat st;
    if (fstatat(c->envelope,workspace_names[i],&st,AT_SYMLINK_NOFOLLOW)==0 || errno!=ENOENT) return 0;
  }
  char name[40]; uint8_t expected[192],actual[193];
  if (snprintf(name,sizeof(name),"intent-%010u",c->state.revision)<0) return 0;
  record_bytes(&c->state,expected);
  int fd=openat(c->journal,name,O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC);
  if (fd<0) return 0;
  struct stat st;
  int ok=fstat(fd,&st)==0 && S_ISREG(st.st_mode) && st.st_uid==0 && st.st_nlink==1 &&
    st.st_size==(off_t)sizeof(expected) && (st.st_mode&0777)==0600 &&
    read(fd,actual,sizeof(actual))==(ssize_t)sizeof(expected) &&
    !memcmp(actual,expected,sizeof(expected));
  if (!close_once(&fd)) return unknown(c);
  return ok && complete_tree(c) && workspace_identity(c);
}
#endif
