#ifndef _POSIX_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#endif
#ifdef __APPLE__
#ifndef _DARWIN_C_SOURCE
#define _DARWIN_C_SOURCE
#endif
#endif
#include "darwin-attempt-owner-tree.h"
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <dirent.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <time.h>
#ifdef __APPLE__
#include <sys/acl.h>
#include <sys/xattr.h>
#endif

typedef struct {
  int fd, directory;
  uint32_t parent, depth, mode, size, written;
  dev_t dev;
  ino_t ino;
  char name[256];
} ae_tree_node;
struct ae_tree_transaction {
  int root, failed, finished;
  uint32_t count, total;
  dev_t dev;
  ino_t ino;
  uid_t uid;
  gid_t gid;
  ae_tree_limits limits;
  ae_tree_node nodes[AE_TREE_ENTRIES];
};
static int tree_sync(int fd) {
  if (fsync(fd)!=0) return 0;
#ifdef __APPLE__
  return fcntl(fd,F_FULLFSYNC)==0;
#else
  return 1;
#endif
}
static int fail(ae_tree_transaction *t) { if (t) t->failed=1; return 0; }
#ifdef __APPLE__
static int supported_xattrs(int fd) {
  static const char provenance[]="com.apple.provenance";
  char names[sizeof(provenance)];
  ssize_t length=flistxattr(fd,NULL,0,0);
  if (length==0) return 1;
  return length==(ssize_t)sizeof(provenance) && flistxattr(fd,names,sizeof(names),0)==length &&
    memcmp(names,provenance,sizeof(provenance))==0;
}
#endif
static int supported_metadata(int fd,const struct stat *st) {
#ifdef __APPLE__
  if (st->st_flags || !supported_xattrs(fd)) return 0;
  acl_t acl=acl_get_fd_np(fd,ACL_TYPE_EXTENDED);
  if (!acl) return errno==ENOENT;
  int empty=0;
  if (acl_valid(acl)==0) {
    acl_entry_t entry;
    errno=0;
    int status=acl_get_entry(acl,ACL_FIRST_ENTRY,&entry),saved_errno=errno;
    /* Darwin returns zero for an actual entry. On this valid ACL and fixed
     * first index, EINVAL is the observed empty-list result, not an ACE. */
    empty=status==-1 && saved_errno==EINVAL;
  }
  int released=acl_free(acl);
  return empty && released==0;
#else
  (void)fd; (void)st; return 1;
#endif
}
static int same_node(int fd,dev_t dev,ino_t ino,int directory) {
  struct stat st;
  return fstat(fd,&st)==0 && supported_metadata(fd,&st) && st.st_dev==dev && st.st_ino==ino &&
    (directory ? S_ISDIR(st.st_mode) : S_ISREG(st.st_mode) && st.st_nlink==1);
}
static int empty_root(int fd) {
  int copy=openat(fd,".",O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
  if (copy<0) return 0;
  DIR *d=fdopendir(copy);
  if (!d) { (void)close(copy); return 0; }
  int ok=1;
  struct dirent *entry;
  errno=0;
  while ((entry=readdir(d))) {
    if (strcmp(entry->d_name,".") && strcmp(entry->d_name,"..")) { ok=0; break; }
  }
  if (errno) ok=0;
  if (closedir(d)!=0) ok=0;
  return ok;
}
ae_tree_transaction *ae_tree_begin(int original,const ae_tree_limits *limits) {
  if (!limits || limits->depth>AE_TREE_DEPTH || limits->entries>AE_TREE_ENTRIES ||
      limits->file_bytes>AE_TREE_FILE_BYTES || limits->total_bytes>AE_TREE_TOTAL_BYTES ||
      limits->file_bytes>limits->total_bytes) return NULL;
  struct stat st;
  if (fstat(original,&st)!=0 || !S_ISDIR(st.st_mode) || !supported_metadata(original,&st) || !empty_root(original)) return NULL;
  ae_tree_transaction *t=calloc(1,sizeof(*t));
  if (!t) return NULL;
  t->root=fcntl(original,F_DUPFD_CLOEXEC,0);
  if (t->root<0) { free(t); return NULL; }
  t->limits=*limits; t->dev=st.st_dev; t->ino=st.st_ino; t->uid=st.st_uid; t->gid=st.st_gid;
  for (size_t i=0;i<AE_TREE_ENTRIES;i++) t->nodes[i].fd=-1;
  return t;
}
/* UTF-8/NFC and portable case collision validation is also performed on the
 * immutable TS inventory. Native independently prohibits path traversal and
 * ambiguous components; these bytes confer no filesystem authority. */
static int component(const char *name) {
  if (!name) return 0;
  size_t n=strnlen(name,256);
  if (!n || n>255 || name[n-1]=='.' || name[n-1]==' ') return 0;
  for (size_t i=0;i<n;i++) {
    unsigned char c=(unsigned char)name[i];
    if (c<32 || c==127 || strchr("<>:\"/\\|?*",c)) return 0;
  }
  return 1;
}
static int complete_previous(ae_tree_transaction *t) {
  if (!t->count) return 1;
  ae_tree_node *n=&t->nodes[t->count-1];
  if (n->directory || n->fd<0) return 1;
  if (n->written!=n->size || !same_node(n->fd,n->dev,n->ino,0) ||
      fchmod(n->fd,(mode_t)n->mode)!=0 || !tree_sync(n->fd)) return fail(t);
  int fd=n->fd; n->fd=-1;
  if (close(fd)!=0) return fail(t);
  return 1;
}
static int close_tree_handle(ae_tree_transaction *t,int *owned) {
  int fd=*owned; *owned=-1;
  return fd<0 || close(fd)==0 ? 1 : fail(t);
}
/* Reopen only the captured original ancestor chain from the retained root.
 * No caller path is resolved, and every component must still be its original
 * directory inode. Directory width costs inventory memory, not live FDs.
 * Parents stay at staging mode until reverse-order finalization below. */
static int open_directory(ae_tree_transaction *t,uint32_t ordinal) {
  if (!same_node(t->root,t->dev,t->ino,1)) { fail(t); return -1; }
  if (ordinal==AE_TREE_ROOT) {
    int fd=fcntl(t->root,F_DUPFD_CLOEXEC,0);
    if (fd<0) fail(t);
    return fd;
  }
  if (ordinal>=t->count || !t->nodes[ordinal].directory) { fail(t); return -1; }
  ae_tree_node *n=&t->nodes[ordinal];
  int parent=open_directory(t,n->parent);
  if (parent<0) return -1;
  int fd=openat(parent,n->name,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
  int ok=fd>=0 && same_node(fd,n->dev,n->ino,1);
  if (!close_tree_handle(t,&parent)) ok=0;
  if (!ok) { (void)close_tree_handle(t,&fd); fail(t); return -1; }
  return fd;
}
int ae_tree_entry(ae_tree_transaction *t,uint32_t ordinal,uint32_t parent,
                  const char *name,int directory,uint32_t mode,uint32_t size) {
  if (!t || t->failed || t->finished) return fail(t);
  if (ordinal!=t->count || ordinal>=t->limits.entries || !component(name) ||
      (directory!=0 && directory!=1) || mode>0777 || size>t->limits.file_bytes ||
      (directory && size) || size>t->limits.total_bytes-t->total ||
      (parent!=AE_TREE_ROOT && (parent>=ordinal || !t->nodes[parent].directory))) return fail(t);
  uint32_t depth=parent==AE_TREE_ROOT ? 0 : t->nodes[parent].depth;
  if (directory) depth++;
  if (depth>t->limits.depth || !complete_previous(t)) return fail(t);
  int p=open_directory(t,parent);
  if (p<0) return fail(t);
  if (directory && mkdirat(p,name,0700)!=0) { (void)close_tree_handle(t,&p); return fail(t); }
  int fd=directory ? openat(p,name,O_RDONLY|O_NOFOLLOW|O_CLOEXEC|O_DIRECTORY) :
    openat(p,name,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600);
  if (fd<0) { (void)close_tree_handle(t,&p); return fail(t); }
  ae_tree_node *n=&t->nodes[t->count++];
  n->fd=fd; n->directory=directory; n->parent=parent; n->depth=depth;
  n->mode=mode; n->size=size; memcpy(n->name,name,strlen(name)+1);
  if (!close_tree_handle(t,&p)) return fail(t);
  struct stat st;
  if (fchown(fd,t->uid,t->gid)!=0 || fstat(fd,&st)!=0 || st.st_dev!=t->dev ||
      (directory ? !S_ISDIR(st.st_mode) : !S_ISREG(st.st_mode) || st.st_nlink!=1 || st.st_size!=0)) return fail(t);
  n->dev=st.st_dev; n->ino=st.st_ino; t->total+=size;
  if (directory && !close_tree_handle(t,&n->fd)) return fail(t);
  return 1;
}
int ae_tree_chunk(ae_tree_transaction *t,uint32_t ordinal,uint32_t offset,const uint8_t *bytes,size_t count) {
  if (!t || t->failed || t->finished) return fail(t);
  if (!t->count || ordinal!=t->count-1 || !bytes || !count || count>AE_TREE_CHUNK_BYTES) return fail(t);
  ae_tree_node *n=&t->nodes[ordinal];
  if (n->directory || n->fd<0 || offset!=n->written || count>n->size-n->written) return fail(t);
  size_t done=0;
  while (done<count) {
    ssize_t wrote=write(n->fd,bytes+done,count-done);
    if (wrote<0 && errno==EINTR) continue;
    if (wrote<=0) return fail(t);
    done+=(size_t)wrote;
  }
  n->written+=(uint32_t)count;
  return 1;
}
int ae_tree_finish(ae_tree_transaction *t) {
  if (!t || t->failed || t->finished) return fail(t);
  if (!complete_previous(t)) return 0;
  for (uint32_t i=t->count;i>0;i--) {
    ae_tree_node *n=&t->nodes[i-1];
    int p=open_directory(t,n->parent);
    if (p<0) return fail(t);
    struct stat st;
    int ok=fstatat(p,n->name,&st,AT_SYMLINK_NOFOLLOW)==0 && st.st_dev==n->dev && st.st_ino==n->ino;
    if (ok && n->directory) {
      int fd=openat(p,n->name,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
      ok=fd>=0 && same_node(fd,n->dev,n->ino,1) && fchmod(fd,(mode_t)n->mode)==0 && tree_sync(fd);
      if (!close_tree_handle(t,&fd)) ok=0;
    }
    if (!close_tree_handle(t,&p)) ok=0;
    if (!ok) return fail(t);
  }
  if (!same_node(t->root,t->dev,t->ino,1) || !tree_sync(t->root)) return fail(t);
  /* Close materialization writers before reporting completion. Retained
   * directories are read-only but their close errors are still uncertainty. */
  for (uint32_t i=0;i<t->count;i++) {
    int fd=t->nodes[i].fd; t->nodes[i].fd=-1;
    if (fd>=0 && close(fd)!=0) return fail(t);
  }
  t->finished=1;
  return 1;
}
int ae_tree_dispose(ae_tree_transaction *t) {
  if (!t) return 0;
  int ok=!t->failed;
  for (uint32_t i=0;i<t->count;i++) if (t->nodes[i].fd>=0 && close(t->nodes[i].fd)!=0) ok=0;
  if (close(t->root)!=0) ok=0;
  free(t);
  return ok;
}

/* Observation keeps at most depth+1 directories and one file open. Files are
 * never followed through symlinks or read through special-device descriptors.
 * Names are data, not paths: every access is relative to a retained parent. */
typedef struct {
  ae_tree_limits limits;
  uint32_t count, total;
  dev_t device;
  ae_tree_emit_entry entry;
  ae_tree_emit_chunk chunk;
  void *context;
  uint64_t deadline;
} ae_tree_observer;
static uint64_t tree_now_ms(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC,&now)!=0) return 0;
  return (uint64_t)now.tv_sec*1000+(uint64_t)now.tv_nsec/1000000;
}
static int observing_within_budget(const ae_tree_observer *o) {
  uint64_t now=tree_now_ms(); return now && now<o->deadline;
}
static int stable(const struct stat *a,const struct stat *b) {
#ifdef __APPLE__
  int times=a->st_mtimespec.tv_sec==b->st_mtimespec.tv_sec &&
    a->st_mtimespec.tv_nsec==b->st_mtimespec.tv_nsec &&
    a->st_ctimespec.tv_sec==b->st_ctimespec.tv_sec &&
    a->st_ctimespec.tv_nsec==b->st_ctimespec.tv_nsec;
#else
  int times=a->st_mtim.tv_sec==b->st_mtim.tv_sec && a->st_mtim.tv_nsec==b->st_mtim.tv_nsec &&
    a->st_ctim.tv_sec==b->st_ctim.tv_sec && a->st_ctim.tv_nsec==b->st_ctim.tv_nsec;
#endif
  return times && a->st_dev==b->st_dev && a->st_ino==b->st_ino &&
    a->st_mode==b->st_mode && a->st_nlink==b->st_nlink &&
    a->st_uid==b->st_uid && a->st_gid==b->st_gid && a->st_size==b->st_size;
}
static int observe_file(ae_tree_observer *o,int fd,uint32_t ordinal,uint32_t size) {
  uint8_t bytes[AE_TREE_CHUNK_BYTES];
  uint32_t offset=0;
  while (offset<size) {
    if (!observing_within_budget(o)) return 0;
    size_t want=size-offset;
    if (want>sizeof(bytes)) want=sizeof(bytes);
    ssize_t n=read(fd,bytes,want);
    if (n<0 && errno==EINTR) continue;
    if (n<=0 || !o->chunk(o->context,ordinal,offset,bytes,(size_t)n)) return 0;
    offset+=(uint32_t)n;
  }
  ssize_t tail;
  do { tail=read(fd,bytes,1); } while (tail<0 && errno==EINTR);
  return tail==0 && observing_within_budget(o);
}
static int observe_directory(ae_tree_observer *,int,uint32_t,uint32_t);
static int observe_entry(ae_tree_observer *o,int parent,uint32_t parent_ordinal,uint32_t depth,const char *name) {
  struct stat named,before,after,final_name;
  if (!observing_within_budget(o) || !component(name) || o->count>=o->limits.entries ||
      fstatat(parent,name,&named,AT_SYMLINK_NOFOLLOW)!=0 || named.st_dev!=o->device ||
      (named.st_mode&07000) || (!S_ISDIR(named.st_mode) && !S_ISREG(named.st_mode))) return 0;
  int directory=S_ISDIR(named.st_mode);
  if (directory ? depth>=o->limits.depth : named.st_nlink!=1 || named.st_size<0 ||
      (uint64_t)named.st_size>o->limits.file_bytes || (uint64_t)named.st_size>o->limits.total_bytes-o->total) return 0;
  int fd=openat(parent,name,O_RDONLY|O_NOFOLLOW|O_CLOEXEC|O_NONBLOCK|(directory ? O_DIRECTORY : 0));
  if (fd<0) return 0;
  int ok=fstat(fd,&before)==0 && supported_metadata(fd,&before) && stable(&named,&before);
  uint32_t ordinal=o->count++;
  uint32_t size=directory ? 0 : (uint32_t)named.st_size;
  ae_tree_observed_entry entry={ordinal,parent_ordinal,(uint32_t)(named.st_mode&0777),size,
    (uint64_t)named.st_dev,(uint64_t)named.st_ino,directory,name};
  if (ok) ok=o->entry(o->context,&entry);
  o->total+=size;
  if (ok) ok=directory ? observe_directory(o,fd,ordinal,depth+1) : observe_file(o,fd,ordinal,size);
  if (ok) ok=fstat(fd,&after)==0 && supported_metadata(fd,&after) && stable(&before,&after) &&
    fstatat(parent,name,&final_name,AT_SYMLINK_NOFOLLOW)==0 && stable(&before,&final_name);
  if (close(fd)!=0) ok=0;
  return ok && observing_within_budget(o);
}
static int observe_directory(ae_tree_observer *o,int fd,uint32_t ordinal,uint32_t depth) {
  struct stat before,after;
  if (fstat(fd,&before)!=0 || !supported_metadata(fd,&before) || before.st_dev!=o->device || !S_ISDIR(before.st_mode)) return 0;
  int copy=openat(fd,".",O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
  if (copy<0) return 0;
  DIR *directory=fdopendir(copy);
  if (!directory) { (void)close(copy); return 0; }
  int ok=1;
  for (;;) {
    if (!observing_within_budget(o)) { ok=0; break; }
    errno=0;
    struct dirent *entry=readdir(directory);
    if (!entry) { if (errno) ok=0; break; }
    if (!strcmp(entry->d_name,".") || !strcmp(entry->d_name,"..")) continue;
    if (!observe_entry(o,fd,ordinal,depth,entry->d_name)) { ok=0; break; }
  }
  if (closedir(directory)!=0) ok=0;
  if (fstat(fd,&after)!=0 || !stable(&before,&after)) ok=0;
  return ok;
}
int ae_tree_observe(int root,const ae_tree_limits *limits,ae_tree_emit_entry entry,ae_tree_emit_chunk chunk,void *context) {
  if (!limits || !entry || !chunk || limits->depth>AE_TREE_DEPTH || limits->entries>AE_TREE_ENTRIES ||
      limits->file_bytes>AE_TREE_FILE_BYTES || limits->total_bytes>AE_TREE_TOTAL_BYTES ||
      limits->file_bytes>limits->total_bytes) return 0;
  struct stat before,after;
  if (fstat(root,&before)!=0 || !S_ISDIR(before.st_mode)) return 0;
  uint64_t now=tree_now_ms();
  if (!now) return 0;
  ae_tree_observer observer={*limits,0,0,before.st_dev,entry,chunk,context,now+5000};
  return observe_directory(&observer,root,AE_TREE_ROOT,0) && fstat(root,&after)==0 && stable(&before,&after) && observing_within_budget(&observer);
}
