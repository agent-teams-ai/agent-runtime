#include "darwin-attempt-owner-custody.h"
#ifdef __APPLE__
#include <sys/stat.h>
#include <sys/file.h>
#include <sys/acl.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

/* This module performs staging under already captured root descriptors. It is
 * not a root launcher or a range-admission mechanism. The unavailable main
 * cannot construct its input. Vacant account/process observations alone must
 * never be used to satisfy that missing root-controlled range capability. */
static int uncertain(ae_custody *c) {
  c->unknown=1; c->state.phase=AE_QUARANTINED; c->state.cutoff=1; return 0;
}
static int durable(int fd) { return fsync(fd)==0 && fcntl(fd,F_FULLFSYNC)==0; }
static int close_owned(int *fd) {
  int old=*fd; *fd=-1; return old<0 || close(old)==0;
}
static int acl_empty(int fd) {
  acl_t acl=acl_get_fd_np(fd,ACL_TYPE_EXTENDED);
  if (!acl) return 0;
  acl_entry_t entry;
  int empty=acl_get_entry(acl,ACL_FIRST_ENTRY,&entry)==0;
  if (acl_free(acl)!=0) empty=0;
  return empty;
}
static int clear_acl(int fd) {
  acl_t acl=acl_init(0);
  if (!acl) return 0;
  int ok=acl_set_fd_np(fd,acl,ACL_TYPE_EXTENDED)==0;
  if (acl_free(acl)!=0) ok=0;
  return ok && acl_empty(fd);
}
static int root_directory(int fd) {
  struct stat st;
  return fstat(fd,&st)==0 && S_ISDIR(st.st_mode) && st.st_uid==0 &&
    (st.st_mode&0022)==0 && st.st_flags==0 && acl_empty(fd);
}
static int allocation_lock(ae_custody *c) {
  c->allocation_lock=openat(c->lease_registry,"allocation-lock",
    O_RDWR|O_CREAT|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC,0600);
  if (c->allocation_lock<0) return 0;
  struct stat st;
  return fstat(c->allocation_lock,&st)==0 && S_ISREG(st.st_mode) && st.st_uid==0 &&
    st.st_nlink==1 && (st.st_mode&07777)==0600 && acl_empty(c->allocation_lock) &&
    flock(c->allocation_lock,LOCK_EX|LOCK_NB)==0 && durable(c->lease_registry);
}
/* O_EXCL makes the numerical slot permanent even if this file is torn, empty,
 * or its owning helper dies. Never unlink it on success OR failure. The kernel
 * lock is retained in c through release; loss of lock never means reusable.
 * UID and GID get independent names, so changing the other half cannot reuse
 * an already retired identity. The complete binding stays in the external
 * journal; these immutable tombstones only deny reuse and capture namespace. */
static int retire_slot(ae_custody *c, const char *kind, unsigned identity, int *held) {
  char name[32];
  if (snprintf(name,sizeof(name),"%s-%u",kind,identity)<0) return 0;
  *held=openat(c->lease_registry,name,O_RDWR|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600);
  if (*held<0) return 0;
  struct stat st;
  int ok=fstat(*held,&st)==0 && S_ISREG(st.st_mode) && st.st_uid==0 && st.st_nlink==1 &&
    clear_acl(*held) && fchmod(*held,0600)==0 && flock(*held,LOCK_EX|LOCK_NB)==0 &&
    write(*held,c->namespace_name,sizeof(c->namespace_name))==(ssize_t)sizeof(c->namespace_name) &&
    durable(*held) && durable(c->lease_registry);
  /* On failure retain the descriptor if possible; no cleanup rollback can
   * erase evidence that this identity was consumed. */
  return ok;
}
static int fresh_directory(int parent,const char *name,uid_t uid,gid_t gid,mode_t mode) {
  if (mkdirat(parent,name,0700)!=0) return -1;
  int fd=openat(parent,name,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
  if (fd<0) return -1;
  int ok=clear_acl(fd) && fchown(fd,uid,gid)==0 && fchmod(fd,mode)==0;
  struct stat st,named;
  if (ok) ok=fstat(fd,&st)==0 && fstatat(parent,name,&named,AT_SYMLINK_NOFOLLOW)==0 &&
    S_ISDIR(st.st_mode) && S_ISDIR(named.st_mode) && st.st_dev==named.st_dev && st.st_ino==named.st_ino &&
    st.st_uid==uid && st.st_gid==gid && (st.st_mode&07777)==mode && acl_empty(fd) &&
    durable(fd) && durable(parent);
  if (!ok) { (void)close_owned(&fd); return -1; }
  return fd;
}
static int empty_slot(ae_custody *c,const char *name) {
  int fd=openat(c->workspace,name,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600);
  if (fd<0) return 0;
  int ok=clear_acl(fd) && fchown(fd,c->leased_uid,c->leased_gid)==0 &&
    fchmod(fd,0600)==0 && durable(fd);
  if (!close_owned(&fd)) ok=0;
  return ok;
}
int ae_native_stage_namespace(ae_custody *c) {
  if (!c || c->unknown || c->state.phase!=AE_EMPTY || c->state.cutoff ||
      c->leased_uid==0 || c->leased_gid==0 || c->leased_uid==c->host_uid ||
      !root_directory(c->approved_parent) || !root_directory(c->lease_registry) ||
      !root_directory(c->journal)) return 0;
  struct stat parent,registry,journal;
  if (fstat(c->approved_parent,&parent)!=0 || fstat(c->lease_registry,&registry)!=0 ||
      fstat(c->journal,&journal)!=0 ||
      (parent.st_dev==registry.st_dev && parent.st_ino==registry.st_ino) ||
      (parent.st_dev==journal.st_dev && parent.st_ino==journal.st_ino)) return 0;
  /* The namespace is chosen before lease publication, so a crash after mkdir
   * can be reconciled to its permanently consumed slots without guessing. */
  unsigned char random[16];
  if (getentropy(random,sizeof(random))!=0) return 0;
  static const char digits[]="0123456789abcdef";
  memset(c->namespace_name,0,sizeof(c->namespace_name));
  memcpy(c->namespace_name,"attempt-",8);
  for (unsigned i=0;i<sizeof(random);i++) {
    c->namespace_name[8+2*i]=digits[random[i]>>4];
    c->namespace_name[9+2*i]=digits[random[i]&15];
  }
  c->uid_lease=-1; c->gid_lease=-1; c->envelope=-1; c->workspace=-1;
  if (!allocation_lock(c) || !retire_slot(c,"uid",(unsigned)c->leased_uid,&c->uid_lease) ||
      !retire_slot(c,"gid",(unsigned)c->leased_gid,&c->gid_lease)) return uncertain(c);
  ae_state next=c->state; next.phase=AE_RESERVED;
  if (ae_commit(&c->state,&next,ae_native_persist,c)!=AE_ACCEPTED) return 0;
  /* No provider process or material exists while inherited ACLs are cleared.
   * Root owns the envelope forever; provider chmod below it cannot let the
   * original Host traverse the root:exclusive-GID 0710 envelope. */
  c->envelope=fresh_directory(c->approved_parent,c->namespace_name,0,c->leased_gid,0710);
  if (c->envelope<0) return uncertain(c);
  int private_fd=fresh_directory(c->envelope,"private",c->leased_uid,c->leased_gid,0700);
  if (private_fd<0) return uncertain(c);
  struct stat private_stat;
  int ok=fstat(private_fd,&private_stat)==0;
  if (!close_owned(&private_fd)) ok=0;
  if (!ok) return uncertain(c);
  c->private_device=(uint64_t)private_stat.st_dev; c->private_inode=(uint64_t)private_stat.st_ino;
  c->workspace=fresh_directory(c->envelope,"workspace",c->leased_uid,c->leased_gid,0700);
  if (c->workspace<0) return uncertain(c);
  struct stat workspace_stat;
  if (fstat(c->workspace,&workspace_stat)!=0 || workspace_stat.st_dev!=private_stat.st_dev ||
      workspace_stat.st_ino==private_stat.st_ino || !empty_slot(c,AE_SLOT_0) ||
      !empty_slot(c,AE_SLOT_1) || !durable(c->workspace) || !durable(c->envelope)) return uncertain(c);
  c->device=(uint64_t)workspace_stat.st_dev; c->inode=(uint64_t)workspace_stat.st_ino;
  next=c->state; next.workspace_dev=c->device; next.workspace_ino=c->inode; next.phase=AE_STAGED;
  return ae_commit(&c->state,&next,ae_native_persist,c)==AE_ACCEPTED;
}
#endif
