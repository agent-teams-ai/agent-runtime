#include "darwin-attempt-owner-material.h"
#include <string.h>
int ae_material_uuid_valid(const uint8_t *uuid,size_t size) {
  if (!uuid || size!=36 || uuid[14]!='4' || !strchr("89ab",uuid[19]) || !uuid[19]) return 0;
  for (size_t i=0;i<size;i++) {
    if (i==8 || i==13 || i==18 || i==23) { if (uuid[i]!='-') return 0; }
    else if (!((uuid[i]>='0' && uuid[i]<='9') || (uuid[i]>='a' && uuid[i]<='f'))) return 0;
  }
  return 1;
}
#ifdef __APPLE__
#include <CommonCrypto/CommonDigest.h>
#include <sys/stat.h>
#include <sys/acl.h>
#include <sys/xattr.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <dirent.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

static uint64_t milliseconds(void) {
  struct timespec value;
  if (clock_gettime(CLOCK_MONOTONIC,&value)!=0) return UINT64_MAX;
  return (uint64_t)value.tv_sec*1000u+(uint64_t)value.tv_nsec/1000000u;
}

static uint32_t word(const uint8_t *p) {return ((uint32_t)p[0]<<24)|((uint32_t)p[1]<<16)|((uint32_t)p[2]<<8)|p[3];}
static void put32(uint8_t *p,uint32_t n) {p[0]=(uint8_t)(n>>24);p[1]=(uint8_t)(n>>16);p[2]=(uint8_t)(n>>8);p[3]=(uint8_t)n;}
static void put64(uint8_t *p,uint64_t n) {put32(p,(uint32_t)(n>>32));put32(p+4,(uint32_t)n);}
static int close_once(int *fd) {int owned=*fd;*fd=-1;return owned<0 || close(owned)==0;}
static int metadata(int fd,const struct stat *st) {
  if (st->st_flags || flistxattr(fd,NULL,0,0)!=0) return 0;
  acl_t acl=acl_get_fd_np(fd,ACL_TYPE_EXTENDED); if (!acl) return 0;
  acl_entry_t entry; int result=acl_get_entry(acl,ACL_FIRST_ENTRY,&entry),released=acl_free(acl);
  return result==0 && released==0;
}
static int same(const struct stat *a,const struct stat *b) {
  return a->st_dev==b->st_dev && a->st_ino==b->st_ino && a->st_uid==b->st_uid && a->st_gid==b->st_gid &&
    a->st_mode==b->st_mode && a->st_nlink==b->st_nlink && a->st_size==b->st_size &&
    a->st_mtimespec.tv_sec==b->st_mtimespec.tv_sec && a->st_mtimespec.tv_nsec==b->st_mtimespec.tv_nsec &&
    a->st_ctimespec.tv_sec==b->st_ctimespec.tv_sec && a->st_ctimespec.tv_nsec==b->st_ctimespec.tv_nsec;
}
static int directory(ae_custody *c,int fd,uint64_t inode) {
  struct stat st;
  return fstat(fd,&st)==0 && S_ISDIR(st.st_mode) && (uint64_t)st.st_dev==c->device &&
    (uint64_t)st.st_ino==inode && st.st_uid==c->leased_uid && st.st_gid==c->leased_gid &&
    (st.st_mode&07777)==0700 && metadata(fd,&st);
}
static int open_directory(ae_custody *c,int parent,const char *name,uint64_t inode) {
  int fd=openat(parent,name,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
  struct stat held,named;
  if (fd>=0 && directory(c,fd,inode) && fstat(fd,&held)==0 &&
      fstatat(parent,name,&named,AT_SYMLINK_NOFOLLOW)==0 && same(&held,&named)) return fd;
  if (!close_once(&fd)) c->unknown=1;
  return -1;
}
static int home(ae_custody *c) {
  int parent=open_directory(c,c->envelope,"private",c->private_inode);
  if (parent<0) return -1;
  int fd=open_directory(c,parent,"codex-home",c->codex_home_inode);
  if (!close_once(&parent)) {c->unknown=1;(void)close_once(&fd);return -1;}
  return fd;
}
static int fact(int fd,uint8_t *out) {
  struct stat before,after; char path[1024];
  if (fstat(fd,&before)!=0 || fcntl(fd,F_GETPATH,path)!=0 || !metadata(fd,&before)) return 0;
  size_t length=strnlen(path,sizeof(path));
  if (!length || length>=sizeof(path) || path[0]!='/') return 0;
  memset(out,0,AE_DIRECTORY_FACT_BYTES); put32(out,(uint32_t)length);memcpy(out+4,path,length);
  put64(out+1028,(uint64_t)before.st_dev);put64(out+1036,(uint64_t)before.st_ino);
  put32(out+1044,before.st_uid);put32(out+1048,(uint32_t)(before.st_mode&07777));
  return fstat(fd,&after)==0 && same(&before,&after);
}
int ae_native_observe_launch(ae_custody *c,uint8_t out[AE_OBSERVATION_BYTES],uint32_t generation) {
  if (!c || c->unknown || !c->creation_committed || !c->operation_id[0] || c->state.workspace!=AE_ACTIVE ||
      !directory(c,c->workspace,c->inode) || !ae_native_validate_journal(c)) return 0;
  int parent=open_directory(c,c->envelope,"private",c->private_inode);
  if (parent<0) return 0;
  int codex=open_directory(c,parent,"codex-home",c->codex_home_inode),tmp=open_directory(c,parent,"tmp",c->tmp_inode);
  memset(out,0,AE_OBSERVATION_BYTES);size_t length=strlen(c->operation_id);
  put32(out,(uint32_t)length);memcpy(out+4,c->operation_id,length);
  put32(out+1028,c->leased_uid);put32(out+1032,generation);
  int ok=codex>=0 && tmp>=0 && fact(parent,out+1036) && fact(codex,out+1036+AE_DIRECTORY_FACT_BYTES) &&
    fact(tmp,out+1036+2*AE_DIRECTORY_FACT_BYTES) && fact(c->workspace,out+1036+3*AE_DIRECTORY_FACT_BYTES);
  struct stat named;
  if (ok) ok=fstatat(parent,"codex-home",&named,AT_SYMLINK_NOFOLLOW)==0 && (uint64_t)named.st_ino==c->codex_home_inode &&
    fstatat(parent,"tmp",&named,AT_SYMLINK_NOFOLLOW)==0 && (uint64_t)named.st_ino==c->tmp_inode &&
    fstatat(c->envelope,"private",&named,AT_SYMLINK_NOFOLLOW)==0 && (uint64_t)named.st_ino==c->private_inode;
  if (!close_once(&codex)) ok=0;
  if (!close_once(&tmp)) ok=0;
  if (!close_once(&parent)) ok=0;
  return ok && directory(c,c->workspace,c->inode) && ae_native_validate_journal(c);
}
int ae_native_material_begin(ae_custody *c,const uint8_t *data,size_t size) {
  if (!c || c->material_consumed || !c->claim_committed || c->unknown || size!=44) return 0;
  c->material_consumed=1;
  c->config_size=word(data);c->catalog_size=word(data+4);
  if (!c->config_size || c->config_size>AE_CONFIG_MAX_BYTES || c->catalog_size!=AE_CATALOG_BYTES ||
      !ae_material_uuid_valid(data+8,36) || !ae_native_validate_journal(c)) return 0;
  memcpy(c->installation_id,data+8,36);c->material_root=home(c);
  if (c->material_root<0) return 0;
  ae_tree_limits limits={0,3,AE_CATALOG_BYTES,AE_CONFIG_MAX_BYTES+AE_CATALOG_BYTES+36};
  c->material_transaction=ae_tree_begin(c->material_root,&limits);
  return c->material_transaction && ae_tree_entry(c->material_transaction,0,AE_TREE_ROOT,"config.toml",0,0600,c->config_size);
}
int ae_native_material_chunk(ae_custody *c,const uint8_t *data,size_t size) {
  if (!c || !c->material_transaction || c->material_file>1 || size<=8 || size>AE_TREE_REQUEST_MAX_BYTES ||
      word(data)!=c->material_file || word(data+4)!=c->material_offset) return 0;
  if (!ae_tree_chunk(c->material_transaction,c->material_file,c->material_offset,data+8,size-8)) return 0;
  c->material_offset+=(uint32_t)(size-8);
  uint32_t expected=c->material_file==0 ? c->config_size : c->catalog_size;
  if (c->material_offset!=expected) return 1;
  c->material_offset=0;c->material_file++;
  if (c->material_file==1) return ae_tree_entry(c->material_transaction,1,AE_TREE_ROOT,"models.json",0,0600,c->catalog_size);
  return ae_tree_entry(c->material_transaction,2,AE_TREE_ROOT,"installation_id",0,0644,36) &&
    ae_tree_chunk(c->material_transaction,2,0,c->installation_id,36);
}
static int inventory(int fd) {
  int copy=openat(fd,".",O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC); if (copy<0) return 0;
  DIR *dir=fdopendir(copy);if (!dir) {(void)close_once(&copy);return 0;}
  unsigned seen=0;int ok=1;
  for (;;) {
    errno=0;struct dirent *entry=readdir(dir);if (!entry) {if (errno) ok=0;break;}
    if (!strcmp(entry->d_name,".") || !strcmp(entry->d_name,"..")) continue;
    unsigned bit=!strcmp(entry->d_name,"config.toml") ? 1 : !strcmp(entry->d_name,"models.json") ? 2 : !strcmp(entry->d_name,"installation_id") ? 4 : 0;
    if (!bit || (seen&bit)) {ok=0;break;}seen|=bit;
  }
  if (closedir(dir)!=0) ok=0;
  return ok && seen==7;
}
static int file_fact(ae_custody *c,int root,const char *name,uint32_t mode,uint32_t size,uint8_t *out,uint64_t deadline) {
  int fd=openat(root,name,O_RDONLY|O_NOFOLLOW|O_CLOEXEC|O_NONBLOCK);if (fd<0) return 0;
  struct stat before,after,named;CC_SHA256_CTX hash;CC_SHA256_Init(&hash);
  int ok=fstat(fd,&before)==0 && S_ISREG(before.st_mode) && before.st_nlink==1 && before.st_uid==c->leased_uid &&
    before.st_gid==c->leased_gid && (before.st_mode&07777)==mode && before.st_size==(off_t)size &&
    (uint64_t)before.st_dev==c->device && metadata(fd,&before) && fact(fd,out);
  uint8_t chunk[AE_TREE_CHUNK_BYTES];uint32_t offset=0;
  while (ok && offset<size) {
    if (milliseconds()>=deadline) {ok=0;break;}
    size_t count=size-offset;if (count>sizeof(chunk)) count=sizeof(chunk);
    ssize_t n=read(fd,chunk,count);if (n<0 && errno==EINTR) continue;
    if (n<=0) {ok=0;break;}CC_SHA256_Update(&hash,chunk,(CC_LONG)n);offset+=(uint32_t)n;
  }
  uint8_t extra;
  if (ok) ok=read(fd,&extra,1)==0 && fstat(fd,&after)==0 && same(&before,&after) &&
    fstatat(root,name,&named,AT_SYMLINK_NOFOLLOW)==0 && same(&before,&named);
  if (ok) {put32(out+AE_DIRECTORY_FACT_BYTES,1);put32(out+AE_DIRECTORY_FACT_BYTES+4,size);CC_SHA256_Final(out+AE_DIRECTORY_FACT_BYTES+8,&hash);}
  if (!close_once(&fd)) ok=0;
  return ok;
}
static int files(ae_custody *c,int root,uint8_t *out) {
  uint64_t start=milliseconds(); if (start==UINT64_MAX) return 0;
  uint64_t deadline=start+5000;
  if (!directory(c,root,c->codex_home_inode) || !inventory(root) ||
      !file_fact(c,root,"config.toml",0600,c->config_size,out,deadline) ||
      !file_fact(c,root,"models.json",0600,c->catalog_size,out+AE_FILE_FACT_BYTES,deadline) ||
      !file_fact(c,root,"installation_id",0644,36,out+2*AE_FILE_FACT_BYTES,deadline)) return 0;
  static const char alphabet[]="0123456789abcdef";
  const uint8_t *digest=out+AE_FILE_FACT_BYTES+AE_DIRECTORY_FACT_BYTES+8;
  char hex[65];for (size_t i=0;i<32;i++) {hex[2*i]=alphabet[digest[i]>>4];hex[2*i+1]=alphabet[digest[i]&15];}hex[64]=0;
  uint8_t uuid_digest[32];CC_SHA256(c->installation_id,36,uuid_digest);
  return !strcmp(hex,AE_CATALOG_SHA256) && !memcmp(uuid_digest,out+2*AE_FILE_FACT_BYTES+AE_DIRECTORY_FACT_BYTES+8,32) &&
    directory(c,root,c->codex_home_inode) && inventory(root) && milliseconds()<deadline;
}
int ae_native_material_finish(ae_custody *c,uint8_t out[AE_MATERIAL_RESULT_BYTES],uint32_t generation) {
  if (!c || !c->material_transaction || c->material_file!=2 || !ae_tree_finish(c->material_transaction)) return 0;
  ae_tree_transaction *owned=c->material_transaction;c->material_transaction=NULL;
  if (!ae_tree_dispose(owned)) return 0;
  int ok=files(c,c->material_root,c->material_facts);
  if (!close_once(&c->material_root)) ok=0;
  if (!ok || !ae_native_observe_launch(c,out,generation)) return 0;
  memcpy(out+AE_OBSERVATION_BYTES,c->material_facts,sizeof(c->material_facts));c->material_ready=1;return 1;
}
int ae_native_validate_launch(ae_custody *c) {
  if (!c || !c->material_ready || !c->claim_committed || c->unknown || c->material_transaction || c->material_root>=0) return 0;
  uint8_t observation[AE_OBSERVATION_BYTES],current[3*AE_FILE_FACT_BYTES];
  if (!ae_native_observe_launch(c,observation,c->state.revision)) return 0;
  int fd=home(c);if (fd<0) return 0;
  int ok=files(c,fd,current) && !memcmp(current,c->material_facts,sizeof(current));
  if (!close_once(&fd)) ok=0;
  return ok;
}
#endif
