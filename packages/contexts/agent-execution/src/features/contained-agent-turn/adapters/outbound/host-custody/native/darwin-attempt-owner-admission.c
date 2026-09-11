#include "darwin-attempt-owner-protocol.h"
#include <string.h>
static uint32_t word(const uint8_t *b) {
  return ((uint32_t)b[0]<<24)|((uint32_t)b[1]<<16)|((uint32_t)b[2]<<8)|b[3];
}
static int zero(const uint8_t *b,size_t n) {
  for (size_t i=0;i<n;i++) if (b[i]) return 0;
  return 1;
}
static int text_slot(const uint8_t *b,char *out,int path) {
  size_t n=0;
  while (n<AE_MANIFEST_STRING_BYTES && b[n]) {
    if (b[n]<32 || b[n]>126) return 0;
    n++;
  }
  if (!n || n==AE_MANIFEST_STRING_BYTES ||
      !zero(b+n,AE_MANIFEST_STRING_BYTES-n)) return 0;
  if (path && (b[0]!='/' || b[n-1]=='/')) return 0;
  memcpy(out,b,AE_MANIFEST_STRING_BYTES);
  if (path && (strstr(out,"//") || strstr(out,"/./") || strstr(out,"/../") ||
      (n>=2 && !strcmp(out+n-2,"/.")) || (n>=3 && !strcmp(out+n-3,"/..")))) return 0;
  return 1;
}
int ae_manifest_decode(const uint8_t *b,size_t n,ae_manifest *out) {
  if (!b || !out || n!=AE_MANIFEST_BYTES || word(b)!=AE_MANIFEST_MAGIC ||
      word(b+4)!=AE_VERSION || word(b+8)!=AE_MANIFEST_BYTES || word(b+12)!=0 ||
      !zero(b+AE_MANIFEST_END_OFFSET,n-AE_MANIFEST_END_OFFSET)) return 0;
  ae_manifest m; memset(&m,0,sizeof(m));
  m.host_uid=word(b+16); m.host_gid=word(b+20); m.uid=word(b+24); m.gid=word(b+28);
  m.image_count=word(b+32); m.argc=word(b+36); m.term_ms=word(b+40); m.run_ms=word(b+44);
  if (!m.host_uid || !m.host_gid || !m.uid || !m.gid || m.uid==m.host_uid || m.gid==m.host_gid ||
      m.image_count<=AE_IMAGE_FIRST_LOADER || m.image_count>AE_MANIFEST_IMAGES ||
      !m.argc || m.argc>AE_MANIFEST_ARGV_SLOTS ||
      !m.term_ms || m.term_ms>10000 || !m.run_ms || m.run_ms>300000) return 0;
  for (unsigned i=0;i<AE_MANIFEST_BINDINGS;i++) {
    const uint8_t *binding=b+AE_MANIFEST_BINDINGS_OFFSET+i*AE_DIGEST_BYTES;
    if (zero(binding,AE_DIGEST_BYTES)) return 0;
    memcpy(m.bindings[i],binding,AE_DIGEST_BYTES);
  }
  for (unsigned i=0;i<AE_MANIFEST_IMAGES;i++) {
    const uint8_t *entry=b+AE_MANIFEST_IMAGES_OFFSET+i*AE_MANIFEST_IMAGE_BYTES;
    if (i>=m.image_count) { if (!zero(entry,AE_MANIFEST_IMAGE_BYTES)) return 0; continue; }
    if (!text_slot(entry,m.images[i].path,1) ||
        zero(entry+AE_MANIFEST_STRING_BYTES,AE_DIGEST_BYTES)) return 0;
    memcpy(m.images[i].digest,entry+AE_MANIFEST_STRING_BYTES,AE_DIGEST_BYTES);
    for (unsigned j=0;j<i;j++) if (!strcmp(m.images[i].path,m.images[j].path)) return 0;
  }
  for (unsigned i=0;i<AE_MANIFEST_ARGV_SLOTS;i++) {
    const uint8_t *entry=b+AE_MANIFEST_ARGV_OFFSET+i*AE_MANIFEST_STRING_BYTES;
    if (i>=m.argc) { if (!zero(entry,AE_MANIFEST_STRING_BYTES)) return 0; }
    else if (!text_slot(entry,m.argv[i],0)) return 0;
  }
  if (strcmp(m.argv[0],m.images[AE_IMAGE_PROVIDER].path)) return 0;
  for (unsigned i=0;i<AE_MANIFEST_FD_COUNT;i++) {
    const uint8_t *entry=b+AE_MANIFEST_FDS_OFFSET+i*AE_MANIFEST_FD_BYTES;
    m.fd_devices[i]=((uint64_t)word(entry)<<32)|word(entry+4);
    m.fd_inodes[i]=((uint64_t)word(entry+8)<<32)|word(entry+12);
    if (!m.fd_inodes[i] || word(entry+16)!=(i<3 ? 1u : i==3 ? 2u : 3u) ||
        !zero(entry+20,12)) return 0;
    for (unsigned j=0;j<i;j++) if (m.fd_devices[j]==m.fd_devices[i] && m.fd_inodes[j]==m.fd_inodes[i]) return 0;
  }
  *out=m; return 1;
}
int ae_grant_decode(const uint8_t *b,size_t n,ae_grant *out) {
  if (!b || !out || n!=AE_GRANT_BYTES || word(b)!=AE_GRANT_MAGIC ||
      word(b+4)!=AE_VERSION || word(b+8)!=AE_GRANT_BYTES || word(b+12)!=0 ||
      !zero(b+128,n-128)) return 0;
  ae_grant g; memset(&g,0,sizeof(g));
  g.uid_first=word(b+16); g.uid_last=word(b+20); g.gid_first=word(b+24); g.gid_last=word(b+28);
  /* Reservation is an explicit root-administered interval, not account vacancy.
   * Permanent lease files narrow this grant further; no automatic reclamation. */
  if (!g.uid_first || !g.gid_first || g.uid_first>g.uid_last || g.gid_first>g.gid_last ||
      g.uid_last-g.uid_first>4095 || g.gid_last-g.gid_first>4095) return 0;
  if (zero(b+32,32) || zero(b+64,32) || zero(b+96,32)) return 0;
  memcpy(g.manifest_digest,b+32,32); memcpy(g.qualification,b+64,32); memcpy(g.isolation,b+96,32);
  *out=g; return 1;
}
int ae_manifest_in_range(const ae_manifest *m,const ae_grant *g) {
  return m && g && m->uid>=g->uid_first && m->uid<=g->uid_last &&
    m->gid>=g->gid_first && m->gid<=g->gid_last &&
    (m->host_uid<g->uid_first || m->host_uid>g->uid_last) &&
    (m->host_gid<g->gid_first || m->host_gid>g->gid_last) &&
    !memcmp(m->bindings[6],g->qualification,32);
}
#ifdef __APPLE__
#include "darwin-attempt-owner-bootstrap.h"
#include <CommonCrypto/CommonDigest.h>
#include <sys/acl.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/random.h>
#include <sys/proc_info.h>
#include <sys/sysctl.h>
#include <sys/param.h>
#include <sys/resource.h>
#include <libproc.h>
#include <pwd.h>
#include <grp.h>
#include <fcntl.h>
#include <limits.h>
#include <stdlib.h>
#include <unistd.h>
#include <errno.h>
#include <signal.h>
#include <poll.h>
#include <time.h>
#include <mach/mach.h>

static int close_capture(int *fd) {
  int old=*fd; *fd=-1; return old<0 || close(old)==0;
}
static int empty_acl(int fd) {
  errno=0;
  acl_t acl=acl_get_fd_np(fd,ACL_TYPE_EXTENDED);
  /* The overwhelmingly common case -- a file that has never had an ACL set --
   * reports back as a NULL acl_t with ENOENT ("the ACL does not exist"), not
   * a valid zero-entry list; that is trivially empty, not a failure. */
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
}
static int protected_stat(int fd,struct stat *st,int directory) {
  return fstat(fd,st)==0 && st->st_uid==0 && !(st->st_mode&0022) &&
    empty_acl(fd) && (directory ? S_ISDIR(st->st_mode) :
      (S_ISREG(st->st_mode) && st->st_nlink==1 && !(st->st_mode&07000)));
}
/* Resolve EVERY ancestor from / by retained no-follow descriptors, never
 * realpath/string-prefix trust. The root administrator is outside the threat
 * boundary; no original Host/provider identity may mutate an ancestor. */
static int protected_open(const char *path,struct stat *st,int directory) {
  if (!path || path[0]!='/' || strlen(path)>=PATH_MAX) return -1;
  int parent=open("/",O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
  struct stat ancestor;
  if (parent<0 || !protected_stat(parent,&ancestor,1)) {
    (void)close_capture(&parent); return -1;
  }
  if (!strcmp(path,"/")) {
    if (directory) { *st=ancestor; return parent; }
    (void)close_capture(&parent); return -1;
  }
  char rest[PATH_MAX]; memcpy(rest,path+1,strlen(path));
  char *cursor=rest;
  for (;;) {
    char *slash=strchr(cursor,'/');
    if (slash) *slash=0;
    if (!*cursor || !strcmp(cursor,".") || !strcmp(cursor,"..")) {
      (void)close_capture(&parent); return -1;
    }
    int next=openat(parent,cursor,O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC|
      ((slash || directory) ? O_DIRECTORY : 0));
    int ok=next>=0 && protected_stat(next,st,slash || directory);
    if (!close_capture(&parent)) ok=0;
    if (!ok) { (void)close_capture(&next); return -1; }
    if (!slash) return next;
    parent=next; cursor=slash+1;
  }
}
static int protected_fd(int fd,int directory,int immutable) {
  char path[PATH_MAX]; struct stat held,named;
  if (!protected_stat(fd,&held,directory) || fcntl(fd,F_GETPATH,path)!=0 ||
      (immutable && !(held.st_flags&(UF_IMMUTABLE|SF_IMMUTABLE)))) return 0;
  int copy=protected_open(path,&named,directory);
  int ok=copy>=0 && held.st_dev==named.st_dev && held.st_ino==named.st_ino;
  if (!close_capture(&copy)) ok=0;
  return ok;
}
static int capture_record(int fd,uint8_t *out,size_t n,const uint8_t *expected) {
  struct stat before,after;
  int mode=fcntl(fd,F_GETFL);
  int ok=mode>=0 && (mode&O_ACCMODE)==O_RDONLY && protected_fd(fd,0,1) &&
    fstat(fd,&before)==0 && before.st_size==(off_t)n;
  size_t used=0;
  while (ok && used<n) {
    ssize_t got=pread(fd,out+used,n-used,(off_t)used);
    if (got<=0) { ok=0; break; }
    used+=(size_t)got;
  }
  if (ok) ok=fstat(fd,&after)==0 && before.st_dev==after.st_dev && before.st_ino==after.st_ino &&
    before.st_size==after.st_size && before.st_flags==after.st_flags &&
    before.st_ctimespec.tv_sec==after.st_ctimespec.tv_sec &&
    before.st_ctimespec.tv_nsec==after.st_ctimespec.tv_nsec;
  if (ok && expected) {
    uint8_t digest[32]; CC_SHA256(out,(CC_LONG)n,digest);
    ok=!memcmp(digest,expected,32);
  }
  if (!close_capture(&fd)) ok=0;
  return ok;
}
static int digest_image(int fd,uint8_t digest[32]) {
  struct stat st;
  if (fstat(fd,&st)!=0 || st.st_size<=0 || st.st_size>268435456) return 0;
  CC_SHA256_CTX sha; CC_SHA256_Init(&sha);
  uint8_t chunk[16384]; off_t used=0;
  while (used<st.st_size) {
    size_t size=(size_t)(st.st_size-used);
    if (size>sizeof(chunk)) size=sizeof(chunk);
    ssize_t n=pread(fd,chunk,size,used);
    if (n<=0) return 0;
    CC_SHA256_Update(&sha,chunk,(CC_LONG)n); used+=n;
  }
  CC_SHA256_Final(digest,&sha); return 1;
}
int ae_image_identity(pid_t pid,const ae_bootstrap *b,unsigned image,uint64_t *seconds,uint64_t *micros) {
  struct proc_bsdinfo before,after; char path[PROC_PIDPATHINFO_MAXSIZE];
  if (image>=b->manifest.image_count ||
      proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&before,sizeof(before))!=(int)sizeof(before) ||
      proc_pidpath(pid,path,sizeof(path))<=0 || strcmp(path,b->manifest.images[image].path) ||
      proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&after,sizeof(after))!=(int)sizeof(after) ||
      before.pbi_start_tvsec!=after.pbi_start_tvsec || before.pbi_start_tvusec!=after.pbi_start_tvusec)
    return 0;
  struct stat held,named;
  if (fstat(b->images[image],&held)!=0 || lstat(path,&named)!=0 ||
      !S_ISREG(named.st_mode) || held.st_dev!=named.st_dev || held.st_ino!=named.st_ino ||
      held.st_dev!=b->identities[image].st_dev || held.st_ino!=b->identities[image].st_ino) return 0;
  *seconds=before.pbi_start_tvsec; *micros=before.pbi_start_tvusec; return 1;
}
static int socket_creator(int fd,pid_t *pid,pid_t *epid,audit_token_t *token) {
  uid_t uid; gid_t gid;
  socklen_t pid_length=sizeof(*pid),epid_length=sizeof(*epid),token_length=sizeof(*token);
  memset(token,0,sizeof(*token));
  return getsockopt(fd,SOL_LOCAL,LOCAL_PEERPID,pid,&pid_length)==0 && pid_length==sizeof(*pid) &&
    getsockopt(fd,SOL_LOCAL,LOCAL_PEEREPID,epid,&epid_length)==0 && epid_length==sizeof(*epid) &&
    getsockopt(fd,SOL_LOCAL,LOCAL_PEERTOKEN,token,&token_length)==0 && token_length==sizeof(*token) &&
    getpeereid(fd,&uid,&gid)==0 && uid==0 && gid==0;
}
static int capture_creator(ae_bootstrap *b,const int pair[2]) {
  pid_t first,second,first_epid,second_epid; audit_token_t first_token,second_token;
  if (!socket_creator(pair[0],&first,&first_epid,&first_token) ||
      !socket_creator(pair[1],&second,&second_epid,&second_token) || first!=getpid() || second!=first ||
      first_epid!=first || second_epid!=first_epid || memcmp(&first_token,&second_token,sizeof(first_token))) return 0;
  b->creator_token=first_token; b->creator_epid=first_epid;
  return 1;
}
int ae_host_identity(const ae_bootstrap *b) {
  uint64_t seconds,micros;
  struct proc_bsdinfo info;
  pid_t peer=0,epid=0; audit_token_t token;
  /* Peer credentials are a necessary consistency check, not the admission
   * mechanism. Provenance is the exclusive socketpair created by THIS root
   * launcher, plus its captured Host birth/image and immutable isolation grant.
   * Socket credentials describe root creation before Host exec/drop. */
  if (b->channel<0 || !socket_creator(b->channel,&peer,&epid,&token) ||
      peer!=b->host_pid || epid!=b->creator_epid || memcmp(&token,&b->creator_token,sizeof(token))) return 0;
  return ae_image_identity(b->host_pid,b,AE_IMAGE_HOST,&seconds,&micros) &&
    seconds==b->host_birth_seconds && micros==b->host_birth_micros &&
    proc_pidinfo(b->host_pid,PROC_PIDTBSDINFO,0,&info,sizeof(info))==(int)sizeof(info) &&
    info.pbi_uid==b->manifest.host_uid && info.pbi_ruid==b->manifest.host_uid &&
    info.pbi_svuid==b->manifest.host_uid && info.pbi_gid==b->manifest.host_gid &&
    info.pbi_rgid==b->manifest.host_gid && info.pbi_svgid==b->manifest.host_gid;
}
static uint64_t peer_quad(const uint8_t *bytes) {
  return ((uint64_t)word(bytes)<<32)|word(bytes+4);
}
/* Called synchronously inside the selected Host by the fixed native addon.
 * Arguments are evidence to match, never authority: peer credentials come from
 * FD8 and birth/image/UID from the kernel. FD11 is consumed even on failure. */
int ae_verify_host_peer(const uint8_t *input,size_t size) {
  static int consumed=0;
  if (consumed) return 0;
  consumed=1;
  uint8_t packet[AE_HOST_PEER_PACKET_BYTES],challenge[AE_ROOT_CHALLENGE_RECORD_BYTES+1];
  int challenge_fd=AE_HOST_CHALLENGE_FD;
  struct stat pipe_stat;
  int ok=input && size==sizeof(packet) && getuid()!=0 && geteuid()==getuid() &&
    fstat(challenge_fd,&pipe_stat)==0 && S_ISFIFO(pipe_stat.st_mode) &&
    fcntl(challenge_fd,F_SETFL,O_NONBLOCK)==0;
  if (ok) memcpy(packet,input,sizeof(packet));
  ssize_t got=ok ? read(challenge_fd,challenge,sizeof(challenge)) : -1;
  uint8_t extra;
  if (got!=AE_ROOT_CHALLENGE_RECORD_BYTES || read(challenge_fd,&extra,1)!=0) ok=0;
  if (!close_capture(&challenge_fd)) ok=0;
  if (!ok || zero(challenge,AE_ROOT_CHALLENGE_BYTES) || memcmp(packet+48,challenge,AE_ROOT_CHALLENGE_BYTES)) return 0;
  pid_t creator,epid; audit_token_t token;
  _Static_assert(sizeof(audit_token_t)==32,"fixed Darwin audit token size");
  if (!socket_creator(AE_BOOT_CHANNEL_FD,&creator,&epid,&token) || creator!=getpid() || epid!=creator ||
      memcmp(&token,challenge+48,sizeof(token))) return 0;
  ae_bootstrap b; memset(&b,0,sizeof(b));
  for (unsigned i=0;i<AE_MANIFEST_IMAGES;i++) b.images[i]=-1;
  if (!ae_manifest_decode(packet+80,AE_MANIFEST_BYTES,&b.manifest) ||
      b.manifest.host_uid!=getuid() || b.manifest.host_gid!=getgid()) return 0;
  const unsigned images[]={AE_IMAGE_HELPER,AE_IMAGE_HOST};
  for (unsigned i=0;i<2;i++) {
    unsigned index=images[i]; uint8_t digest[32];
    b.images[index]=protected_open(b.manifest.images[index].path,&b.identities[index],0);
    if (b.images[index]<0 || !(b.identities[index].st_flags&(UF_IMMUTABLE|SF_IMMUTABLE)) ||
        !digest_image(b.images[index],digest) || memcmp(digest,b.manifest.images[index].digest,32)) ok=0;
  }
  pid_t child=(pid_t)word(packet);
  uint64_t seconds=0,micros=0,host_seconds=0,host_micros=0;
  struct proc_bsdinfo child_info,host_info;
  if (!ok || child<=0 || word(packet+4)!=(uint32_t)getpid() || word(packet+12)!=AE_IMAGE_HELPER ||
      !ae_image_identity(child,&b,AE_IMAGE_HELPER,&seconds,&micros) ||
      seconds!=peer_quad(packet+16) || micros!=peer_quad(packet+24) ||
      peer_quad(packet+32)!=(uint64_t)b.identities[AE_IMAGE_HELPER].st_dev ||
      peer_quad(packet+40)!=(uint64_t)b.identities[AE_IMAGE_HELPER].st_ino ||
      proc_pidinfo(child,PROC_PIDTBSDINFO,0,&child_info,sizeof(child_info))!=(int)sizeof(child_info) ||
      child_info.pbi_ppid!=(uint32_t)getpid() || child_info.pbi_pgid!=word(packet+8) ||
      child_info.pbi_start_tvsec!=seconds || child_info.pbi_start_tvusec!=micros ||
      child_info.pbi_uid || child_info.pbi_ruid || child_info.pbi_svuid ||
      child_info.pbi_gid || child_info.pbi_rgid || child_info.pbi_svgid ||
      !ae_image_identity(getpid(),&b,AE_IMAGE_HOST,&host_seconds,&host_micros) ||
      proc_pidinfo(getpid(),PROC_PIDTBSDINFO,0,&host_info,sizeof(host_info))!=(int)sizeof(host_info) ||
      host_info.pbi_start_tvsec!=host_seconds || host_info.pbi_start_tvusec!=host_micros ||
      host_seconds!=peer_quad(challenge+32) || host_micros!=peer_quad(challenge+40) ||
      host_info.pbi_uid!=b.manifest.host_uid || host_info.pbi_ruid!=b.manifest.host_uid || host_info.pbi_svuid!=b.manifest.host_uid ||
      host_info.pbi_gid!=b.manifest.host_gid || host_info.pbi_rgid!=b.manifest.host_gid || host_info.pbi_svgid!=b.manifest.host_gid) ok=0;
  for (unsigned i=0;i<2;i++) if (!close_capture(&b.images[images[i]])) ok=0;
  return ok;
}
/* Reject registered identities/membership and observed use in addition to the
 * root grant. These observations are NOT themselves range authority. The grant
 * explicitly excludes independent privileged allocators from the leased range. */
static int unused_identity(const ae_manifest *m) {
  errno=0;
  if (getpwuid((uid_t)m->uid) || errno) return 0;
  errno=0;
  if (getgrgid((gid_t)m->gid) || errno) return 0;
  int ok=1; struct passwd *pw;
  setpwent(); errno=0;
  while ((pw=getpwent())!=NULL) if (pw->pw_gid==(gid_t)m->gid) { ok=0; break; }
  if (errno) ok=0;
  endpwent();
  /* Only a bounded complete process snapshot can support admission. Saturation
   * and a disappearing/unreadable entry refuse; there is no skip-on-error. */
  pid_t pids[8192];
  int bytes=proc_listpids(PROC_ALL_PIDS,0,pids,sizeof(pids));
  if (!ok || bytes<=0 || bytes>=(int)sizeof(pids) || bytes%(int)sizeof(pid_t)) return 0;
  for (int i=0;i<bytes/(int)sizeof(pid_t);i++) {
    if (pids[i]<=0) continue;
    struct proc_bsdinfo info;
    if (proc_pidinfo(pids[i],PROC_PIDTBSDINFO,0,&info,sizeof(info))!=(int)sizeof(info)) return 0;
    if (info.pbi_uid==m->uid || info.pbi_ruid==m->uid || info.pbi_svuid==m->uid ||
        info.pbi_gid==m->gid || info.pbi_rgid==m->gid || info.pbi_svgid==m->gid) return 0;
    struct kinfo_proc process; size_t length=sizeof(process);
    int mib[]={CTL_KERN,KERN_PROC,KERN_PROC_PID,pids[i]};
    if (sysctl(mib,4,&process,&length,NULL,0)!=0 || length!=sizeof(process) ||
        process.kp_eproc.e_ucred.cr_ngroups<0 || process.kp_eproc.e_ucred.cr_ngroups>NGROUPS) return 0;
    for (int group=0;group<process.kp_eproc.e_ucred.cr_ngroups;group++)
      if (process.kp_eproc.e_ucred.cr_groups[group]==m->gid) return 0;
  }
  return 1;
}
static int capture_input(ae_bootstrap *b) {
  struct timespec start;
  if (clock_gettime(CLOCK_MONOTONIC,&start)!=0) return 0;
  uint8_t size[4]; size_t used=0,target=4; uint8_t *bytes=size;
  for (;;) {
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC,&now)!=0 || now.tv_sec-start.tv_sec>=5) return 0;
    struct pollfd p={b->input,POLLIN,0};
    int n=poll(&p,1,50);
    if (n<0 && errno==EINTR) continue;
    if (n<0 || (n && (p.revents&(POLLERR|POLLNVAL)))) return 0;
    if (!n) continue;
    if (used==target) {
      if (bytes==size) {
        b->input_length=word(size);
        if (b->input_length>AE_INPUT_MAX_BYTES) return 0;
        b->input_bytes=malloc(b->input_length+1);
        if (!b->input_bytes) return 0;
        bytes=b->input_bytes; target=b->input_length; used=0;
        continue;
      }
      uint8_t surplus;
      ssize_t end=read(b->input,&surplus,1);
      if (end<0 && errno==EINTR) continue;
      return end==0 && close_capture(&b->input);
    }
    ssize_t got=read(b->input,bytes+used,target-used);
    if (got<0 && errno==EINTR) continue;
    if (got<=0) return 0;
    used+=(size_t)got;
  }
}
int ae_revalidate_root_images(ae_bootstrap *b) {
  for (unsigned i=0;i<b->manifest.image_count;i++) {
    struct stat current; uint8_t digest[32];
    int fd=protected_open(b->manifest.images[i].path,&current,0);
    int ok=fd>=0 && (current.st_flags&(UF_IMMUTABLE|SF_IMMUTABLE)) &&
      current.st_dev==b->identities[i].st_dev && current.st_ino==b->identities[i].st_ino &&
      digest_image(fd,digest) && !memcmp(digest,b->manifest.images[i].digest,32);
    if (!close_capture(&fd)) ok=0;
    if (!ok) return 0;
  }
  return 1;
}
int ae_root_capture(ae_bootstrap *b) {
  if (!b || getuid()!=0 || geteuid()!=0 || getgid()!=0 || getegid()!=0) return 0;
  memset(b,0,sizeof(*b));
  b->channel=-1;
  for (unsigned i=0;i<AE_MANIFEST_IMAGES;i++) b->images[i]=-1;
  uint8_t grant[AE_GRANT_BYTES];
  if (!capture_record(AE_BOOT_GRANT_FD,grant,sizeof(grant),NULL) ||
      !ae_grant_decode(grant,sizeof(grant),&b->grant) ||
      !capture_record(AE_BOOT_MANIFEST_FD,b->manifest_bytes,sizeof(b->manifest_bytes),b->grant.manifest_digest) ||
      !ae_manifest_decode(b->manifest_bytes,sizeof(b->manifest_bytes),&b->manifest) ||
      !ae_manifest_in_range(&b->manifest,&b->grant)) return 0;
  CC_SHA256(b->manifest_bytes,sizeof(b->manifest_bytes),b->manifest_digest);
  if (memcmp(b->manifest_digest,b->grant.manifest_digest,32)) return 0;
  for (unsigned i=0;i<b->manifest.image_count;i++) {
    b->images[i]=protected_open(b->manifest.images[i].path,&b->identities[i],0);
    uint8_t digest[32];
    if (b->images[i]<0 || !(b->identities[i].st_flags&(UF_IMMUTABLE|SF_IMMUTABLE)) ||
        !digest_image(b->images[i],digest) || memcmp(digest,b->manifest.images[i].digest,32)) return 0;
  }
  /* The only admitted exec chain is sandbox-exec -> this trusted preexec
   * helper -> provider. Its digest binds these exact captured image entries in
   * that order, with the fixed tag; an arbitrary known hash is not a chain. */
  CC_SHA256_CTX chain; uint8_t chain_digest[32]; CC_SHA256_Init(&chain);
  static const char chain_tag[]="ae-darwin-exec-chain/v1";
  CC_SHA256_Update(&chain,chain_tag,(CC_LONG)(sizeof(chain_tag)-1));
  const unsigned chain_images[]={AE_IMAGE_SANDBOX,AE_IMAGE_HELPER,AE_IMAGE_PROVIDER};
  for (unsigned i=0;i<3;i++) CC_SHA256_Update(&chain,
    b->manifest_bytes+AE_MANIFEST_IMAGES_OFFSET+chain_images[i]*AE_MANIFEST_IMAGE_BYTES,AE_MANIFEST_IMAGE_BYTES);
  CC_SHA256_Final(chain_digest,&chain);
  if (memcmp(chain_digest,b->manifest.bindings[7],32)) return 0;
  uint64_t seconds,micros;
  if (!ae_image_identity(getpid(),b,AE_IMAGE_HELPER,&seconds,&micros) || !unused_identity(&b->manifest) ||
      !protected_fd(AE_BOOT_PARENT_FD,1,0) || !protected_fd(AE_BOOT_LEASE_FD,1,0) ||
      !protected_fd(AE_BOOT_JOURNAL_FD,1,0)) return 0;
  /* Root grant bytes attesting policy and Host-debug/channel isolation were
   * captured from the protected immutable root authority, not from the wire.
   * Loader list completeness and policy semantics are exact qualification
   * obligations of that grant; this verifies every listed immutable input. */
  b->custody.approved_parent=AE_BOOT_PARENT_FD;
  b->custody.lease_registry=AE_BOOT_LEASE_FD;
  b->custody.journal=AE_BOOT_JOURNAL_FD;
  b->custody.host_uid=(uid_t)b->manifest.host_uid;
  b->custody.leased_uid=(uid_t)b->manifest.uid;
  b->custody.leased_gid=(gid_t)b->manifest.gid;
  b->input=AE_BOOT_INPUT_FD; b->route=AE_BOOT_ROUTE_FD;
  struct stat input; int type=0; socklen_t length=sizeof(type);
  if (fstat(b->input,&input)!=0 || !S_ISFIFO(input.st_mode) ||
      getsockopt(b->route,SOL_SOCKET,SO_TYPE,&type,&length)!=0 || type!=SOCK_STREAM) return 0;
  const int captured[]={AE_BOOT_PARENT_FD,AE_BOOT_LEASE_FD,AE_BOOT_JOURNAL_FD,AE_BOOT_INPUT_FD,AE_BOOT_ROUTE_FD};
  for (unsigned i=0;i<AE_MANIFEST_FD_COUNT;i++) {
    struct stat held;
    if (fstat(captured[i],&held)!=0 || (uint64_t)held.st_dev!=b->manifest.fd_devices[i] ||
        (uint64_t)held.st_ino!=b->manifest.fd_inodes[i]) return 0;
  }
  if (!capture_input(b)) return 0;
  uint8_t binding[32]; CC_SHA256(b->manifest.bindings,sizeof(b->manifest.bindings),binding);
  ae_init(&b->custody.state,binding,b->manifest_digest);
  return 1;
}
static int clear_process_authority(void) {
  struct sigaction action; memset(&action,0,sizeof(action)); action.sa_handler=SIG_DFL;
  if (sigemptyset(&action.sa_mask)!=0) return 0;
  for (int s=1;s<NSIG;s++) if (s!=SIGKILL && s!=SIGSTOP && sigaction(s,&action,NULL)!=0) return 0;
  sigset_t mask;
  if (sigemptyset(&mask)!=0 || sigprocmask(SIG_SETMASK,&mask,NULL)!=0) return 0;
  struct rlimit core={0,0};
  return setrlimit(RLIMIT_CORE,&core)==0 &&
    task_set_bootstrap_port(mach_task_self(),MACH_PORT_NULL)==KERN_SUCCESS &&
    mach_ports_register(mach_task_self(),NULL,0)==KERN_SUCCESS &&
    task_set_exception_ports(mach_task_self(),EXC_MASK_ALL,MACH_PORT_NULL,EXCEPTION_DEFAULT,THREAD_STATE_NONE)==KERN_SUCCESS;
}
int ae_root_isolate_host(ae_bootstrap *b) {
  int pair[2]; struct proc_bsdinfo host;
  if (proc_pidinfo(getpid(),PROC_PIDTBSDINFO,0,&host,sizeof(host))!=(int)sizeof(host) ||
      socketpair(AF_UNIX,SOCK_STREAM,0,pair)!=0) return 0;
  b->host_pid=getpid(); b->host_birth_seconds=host.pbi_start_tvsec; b->host_birth_micros=host.pbi_start_tvusec;
  /* Created here, never accepted from a caller. There are exactly these two
   * references, neither endpoint is published through a file or public API. */
  if (getentropy(b->root_challenge,sizeof(b->root_challenge))!=0 || !capture_creator(b,pair) || fcntl(pair[0],F_SETFD,FD_CLOEXEC)!=0 || fcntl(pair[1],F_SETFD,FD_CLOEXEC)!=0) {
    (void)close_capture(&pair[0]); (void)close_capture(&pair[1]); return 0;
  }
  pid_t owner=fork();
  if (owner<0) { (void)close_capture(&pair[0]); (void)close_capture(&pair[1]); return 0; }
  if (owner==0) {
    if (!close_capture(&pair[0])) return 0;
    b->channel=pair[1];
    return clear_process_authority();
  }
  /* Original root launcher becomes the admitted Host, at its captured birth.
   * No provider is created on this side. FD 8 is the only bridge capability. */
  if (!close_capture(&pair[1]) || dup2(pair[0],AE_BOOT_CHANNEL_FD)<0) _exit(78);
  if (pair[0]!=AE_BOOT_CHANNEL_FD && !close_capture(&pair[0])) _exit(78);
  if (fcntl(AE_BOOT_CHANNEL_FD,F_SETFD,0)!=0) _exit(78);
  /* One root-created secret, shared only with the retained owner child and
   * selected Host. This pipe carries challenge data, never caller authority. */
  uint8_t challenge_record[AE_ROOT_CHALLENGE_RECORD_BYTES];
  memcpy(challenge_record,b->root_challenge,AE_ROOT_CHALLENGE_BYTES);
  for (unsigned i=0;i<8;i++) {
    challenge_record[32+i]=(uint8_t)(b->host_birth_seconds>>(56-8*i));
    challenge_record[40+i]=(uint8_t)(b->host_birth_micros>>(56-8*i));
  }
  memcpy(challenge_record+48,&b->creator_token,sizeof(b->creator_token));
  int challenge[2];
  if (pipe(challenge)!=0 || write(challenge[1],challenge_record,sizeof(challenge_record))!=(ssize_t)sizeof(challenge_record) ||
      !close_capture(&challenge[1]) || dup2(challenge[0],AE_HOST_CHALLENGE_FD)<0) _exit(78);
  if (challenge[0]!=AE_HOST_CHALLENGE_FD && !close_capture(&challenge[0])) _exit(78);
  if (fcntl(AE_HOST_CHALLENGE_FD,F_SETFD,0)!=0) _exit(78);
  int max=getdtablesize();
  if (max<0 || max>1048576) _exit(78);
  for (int fd=3;fd<max;fd++) if (fd!=AE_BOOT_CHANNEL_FD && fd!=AE_HOST_CHALLENGE_FD) {
    if (close(fd)!=0 && errno!=EBADF) _exit(78);
  }
  /* Never export the operator's root-open log/stdin files or current directory
   * into the unprivileged Host. Its result owners use their existing stores. */
  int null_fd=open("/dev/null",O_RDWR|O_NOFOLLOW|O_CLOEXEC);
  struct stat null_stat;
  if (null_fd<0 || fstat(null_fd,&null_stat)!=0 || !S_ISCHR(null_stat.st_mode) || chdir("/")!=0) _exit(78);
  for (int fd=0;fd<3;fd++) if (dup2(null_fd,fd)<0) _exit(78);
  if (null_fd>2 && !close_capture(&null_fd)) _exit(78);
  if (!clear_process_authority() || setgroups(0,NULL)!=0 ||
      setgid((gid_t)b->manifest.host_gid)!=0 || setuid((uid_t)b->manifest.host_uid)!=0 ||
      getuid()!=b->manifest.host_uid || geteuid()!=b->manifest.host_uid ||
      getgid()!=b->manifest.host_gid || getegid()!=b->manifest.host_gid || getgroups(0,NULL)!=0) _exit(78);
  char *argv[]={b->manifest.images[AE_IMAGE_HOST].path,b->manifest.images[AE_IMAGE_HOST_ENTRYPOINT].path,"--darwin-attempt-owner-bridge",NULL};
  char *env[]={"PATH=/usr/bin:/bin","LANG=C","LC_ALL=C",NULL};
  execve(argv[0],argv,env);
  _exit(78);
}
#endif
