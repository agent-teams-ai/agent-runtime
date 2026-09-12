#define _POSIX_C_SOURCE 200809L
#ifdef __APPLE__
#define _DARWIN_C_SOURCE
#endif
#include "darwin-attempt-owner-tree.h"
#include <assert.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <errno.h>
#include <sys/resource.h>
typedef struct {
  unsigned entries, directories, chunks, bytes;
  int reject, mutate, root;
} observation;
static int observed_entry(void *context,const ae_tree_observed_entry *entry) {
  observation *o=context;
  assert(entry->ordinal==o->entries++);
  assert(entry->device!=0 && entry->inode!=0);
  if (entry->directory) o->directories++;
  if (!strcmp(entry->name,"main.txt")) {
    assert(!entry->directory && entry->size==5 && entry->mode==0640);
    if (o->mutate) {
      int fd=openat(o->root,"src/main.txt",O_WRONLY|O_NOFOLLOW);
      assert(fd>=0 && write(fd,"changed",7)==7 && close(fd)==0);
    }
  }
  return !o->reject;
}
static int observed_chunk(void *context,uint32_t ordinal,uint32_t offset,const uint8_t *bytes,size_t count) {
  observation *o=context;
  assert(ordinal<o->entries && offset==o->bytes && count<=AE_TREE_CHUNK_BYTES);
  assert(count==5 && (o->mutate || !memcmp(bytes,"hello",5)));
  o->bytes+=(unsigned)count; o->chunks++;
  return 1;
}
static void bounded_width(int parent) {
  assert(mkdirat(parent,"wide",0700)==0);
  int root=openat(parent,"wide",O_RDONLY|O_DIRECTORY|O_NOFOLLOW); assert(root>=0);
  struct rlimit saved,bounded; assert(getrlimit(RLIMIT_NOFILE,&saved)==0);
  bounded=saved; if (bounded.rlim_cur>64) bounded.rlim_cur=64;
  assert(setrlimit(RLIMIT_NOFILE,&bounded)==0);
  ae_tree_limits limits={32,4096,8388608,33554432};
  ae_tree_transaction *t=ae_tree_begin(root,&limits); assert(t);
  for (unsigned i=0;i<4096;i++) {
    char name[16]; assert(snprintf(name,sizeof(name),"d%05u",i)>0);
    assert(ae_tree_entry(t,i,AE_TREE_ROOT,name,1,0750,0));
  }
  assert(ae_tree_finish(t) && ae_tree_dispose(t));
  struct stat st; assert(fstatat(root,"d04095",&st,AT_SYMLINK_NOFOLLOW)==0 && (st.st_mode&0777)==0750);
  assert(close(root)==0 && setrlimit(RLIMIT_NOFILE,&saved)==0);
}
static void retained_parent(int parent) {
  assert(mkdirat(parent,"swapped",0700)==0);
  int root=openat(parent,"swapped",O_RDONLY|O_DIRECTORY|O_NOFOLLOW); assert(root>=0);
  ae_tree_limits limits={32,4096,8388608,33554432};
  ae_tree_transaction *t=ae_tree_begin(root,&limits); assert(t);
  assert(ae_tree_entry(t,0,AE_TREE_ROOT,"parent",1,0750,0));
  assert(renameat(root,"parent",root,"original")==0 && mkdirat(root,"parent",0700)==0);
  assert(!ae_tree_entry(t,1,0,"foreign",0,0600,0));
  assert(!ae_tree_finish(t) && !ae_tree_dispose(t));
  struct stat st; assert(fstatat(root,"parent/foreign",&st,AT_SYMLINK_NOFOLLOW)<0 && errno==ENOENT);
  assert(close(root)==0);
}
static void bounded_depth(int parent) {
  assert(mkdirat(parent,"depth",0700)==0);
  int root=openat(parent,"depth",O_RDONLY|O_DIRECTORY|O_NOFOLLOW); assert(root>=0);
  struct rlimit saved,bounded; assert(getrlimit(RLIMIT_NOFILE,&saved)==0);
  bounded=saved; if (bounded.rlim_cur>64) bounded.rlim_cur=64;
  assert(setrlimit(RLIMIT_NOFILE,&bounded)==0);
  ae_tree_limits limits={32,4096,8388608,33554432};
  ae_tree_transaction *t=ae_tree_begin(root,&limits); assert(t);
  for (unsigned i=0;i<32;i++) assert(ae_tree_entry(t,i,i ? i-1 : AE_TREE_ROOT,"child",1,0750,0));
  assert(ae_tree_entry(t,32,31,"leaf",0,0640,1));
  assert(ae_tree_chunk(t,32,0,(const uint8_t *)"x",1));
  assert(ae_tree_finish(t) && ae_tree_dispose(t));
  int current=fcntl(root,F_DUPFD_CLOEXEC,0); assert(current>=0);
  for (unsigned i=0;i<32;i++) {
    int next=openat(current,"child",O_RDONLY|O_DIRECTORY|O_NOFOLLOW); assert(next>=0);
    assert(close(current)==0); current=next;
  }
  struct stat st; assert(fstatat(current,"leaf",&st,AT_SYMLINK_NOFOLLOW)==0 && st.st_size==1 && (st.st_mode&0777)==0640);
  assert(close(current)==0 && close(root)==0 && setrlimit(RLIMIT_NOFILE,&saved)==0);
}
int main(int argc,char **argv) {
  assert(argc==2);
  int root=open(argv[1],O_RDONLY|O_DIRECTORY|O_NOFOLLOW);
  assert(root>=0);
  struct stat before,after;
  assert(fstat(root,&before)==0);
  ae_tree_limits limits={32,4096,8388608,33554432};
  ae_tree_transaction *t=ae_tree_begin(root,&limits);
  assert(t);
  assert(ae_tree_entry(t,0,AE_TREE_ROOT,"empty",1,0700,0));
  assert(ae_tree_entry(t,1,AE_TREE_ROOT,"src",1,0750,0));
  assert(ae_tree_entry(t,2,1,"main.txt",0,0640,5));
  assert(ae_tree_chunk(t,2,0,(const uint8_t *)"he",2));
  assert(ae_tree_chunk(t,2,2,(const uint8_t *)"llo",3));
  assert(ae_tree_entry(t,3,AE_TREE_ROOT,"zero",0,0600,0));
  assert(ae_tree_finish(t));
  assert(ae_tree_dispose(t));
  assert(fstat(root,&after)==0 && before.st_dev==after.st_dev && before.st_ino==after.st_ino);
  assert(!ae_tree_begin(root,&limits));
  int file=openat(root,"src/main.txt",O_RDONLY|O_NOFOLLOW);
  char bytes[6]={0};
  assert(file>=0 && read(file,bytes,6)==5 && !strcmp(bytes,"hello"));
  assert(fstat(file,&after)==0 && (after.st_mode&0777)==0640);
  assert(close(file)==0);
  observation observed={0,0,0,0,0,0,root};
  assert(ae_tree_observe(root,&limits,observed_entry,observed_chunk,&observed));
  assert(observed.entries==4 && observed.directories==2 && observed.chunks==1 && observed.bytes==5);
  observation rejected={0,0,0,0,1,0,root};
  assert(!ae_tree_observe(root,&limits,observed_entry,observed_chunk,&rejected));
  assert(rejected.entries==1);
  ae_tree_limits small=limits; small.entries=0;
  assert(!ae_tree_observe(root,&small,observed_entry,observed_chunk,&observed));
  assert(symlinkat("src/main.txt",root,"link")==0);
  observation symlinked={0,0,0,0,0,0,root};
  assert(!ae_tree_observe(root,&limits,observed_entry,observed_chunk,&symlinked));
  assert(unlinkat(root,"link",0)==0);
  assert(linkat(root,"src/main.txt",root,"hardlink",0)==0);
  observation hardlinked={0,0,0,0,0,0,root};
  assert(!ae_tree_observe(root,&limits,observed_entry,observed_chunk,&hardlinked));
  assert(unlinkat(root,"hardlink",0)==0);
  observation mutated={0,0,0,0,0,1,root};
  /* Mutation occurs after inventory publication. The exporter must not emit
   * a successful completion, even when some entries already crossed the wire. */
  assert(!ae_tree_observe(root,&limits,observed_entry,observed_chunk,&mutated));
  int empty=openat(root,"empty",O_RDONLY|O_DIRECTORY|O_NOFOLLOW);
  assert(empty>=0);
  t=ae_tree_begin(empty,&limits); assert(t);
  assert(!ae_tree_entry(t,0,AE_TREE_ROOT,"../escape",0,0600,0));
  assert(!ae_tree_entry(t,0,AE_TREE_ROOT,"retry",0,0600,0));
  assert(!ae_tree_finish(t)); assert(!ae_tree_dispose(t));
  t=ae_tree_begin(empty,&limits); assert(t);
  assert(ae_tree_entry(t,0,AE_TREE_ROOT,"partial",0,0600,2));
  assert(!ae_tree_chunk(t,0,1,(const uint8_t *)"x",1));
  assert(!ae_tree_chunk(t,0,0,(const uint8_t *)"xx",2));
  assert(!ae_tree_finish(t)); assert(!ae_tree_dispose(t));
  assert(fstatat(empty,"partial",&after,AT_SYMLINK_NOFOLLOW)==0 && after.st_size==0);
  assert(close(empty)==0);
  bounded_width(root); bounded_depth(root); retained_parent(root);
  assert(close(root)==0);
  return 0;
}
