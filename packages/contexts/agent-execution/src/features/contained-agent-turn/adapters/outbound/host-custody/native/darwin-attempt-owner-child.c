#include "darwin-attempt-owner-bootstrap.h"
#include "darwin-attempt-owner-material.h"
#ifdef __APPLE__
#include <sys/random.h>
#include <CommonCrypto/CommonDigest.h>
#include <sys/wait.h>
#include <sys/socket.h>
#include <sys/proc_info.h>
#include <sys/resource.h>
#include <libproc.h>
#include <grp.h>
#include <mach/mach.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <time.h>
#include <limits.h>

typedef struct {
  pid_t pid,ppid,pgid;
  uint64_t seconds,micros,dev,ino;
} birth;
typedef struct {
  ae_bootstrap *boot;
  birth owner,child;
  int input,output,error,ack,gate;
  int born,reaped,wait_lost,term_sent,stream_unknown,provider_seen,channel_lost;
  uint32_t serial,image;
  uint64_t started,term_at,stream_bytes,transfer_deadline;
  size_t input_used;
  uint8_t challenge[AE_PREEXEC_BYTES];
} owner;
static uint64_t now_ms(void) {
  struct timespec t;
  if (clock_gettime(CLOCK_MONOTONIC,&t)!=0) return 0;
  return (uint64_t)t.tv_sec*1000+(uint64_t)t.tv_nsec/1000000;
}
static int close_one(int *fd) {
  int old=*fd; *fd=-1; return old<0 || close(old)==0;
}
static int ready(int fd,short events,uint64_t deadline) {
  for (;;) {
    uint64_t now=now_ms();
    if (!now || now>=deadline) return 0;
    struct pollfd p={fd,events,0};
    int wait=(int)(deadline-now);
    if (wait>100) wait=100;
    int n=poll(&p,1,wait);
    if (n<0 && errno==EINTR) continue;
    if (n<0 || (n && (p.revents&(POLLERR|POLLNVAL)))) return 0;
    if (n && (p.revents&(events|POLLHUP))) return 1;
  }
}
static int transfer(int fd,void *buffer,size_t length,int writing,uint64_t deadline) {
  size_t used=0; uint8_t *bytes=buffer;
  while (used<length) {
    if (!ready(fd,writing ? POLLOUT : POLLIN,deadline)) return 0;
    ssize_t n=writing ? write(fd,bytes+used,length-used) : read(fd,bytes+used,length-used);
    if (n<0 && (errno==EINTR || errno==EAGAIN)) continue;
    if (n<=0) return 0;
    used+=(size_t)n;
  }
  return 1;
}
static void put32(uint8_t *b,uint32_t n) { b[0]=(uint8_t)(n>>24); b[1]=(uint8_t)(n>>16); b[2]=(uint8_t)(n>>8); b[3]=(uint8_t)n; }
static void put64(uint8_t *b,uint64_t n) { put32(b,(uint32_t)(n>>32)); put32(b+4,(uint32_t)n); }
static void birth_bytes(uint8_t *b,const birth *v,unsigned image) {
  put32(b,(uint32_t)v->pid); put32(b+4,(uint32_t)v->ppid); put32(b+8,(uint32_t)v->pgid);
  put32(b+12,image); put64(b+16,v->seconds); put64(b+24,v->micros);
  put64(b+32,v->dev); put64(b+40,v->ino);
}
static int observe(pid_t pid,ae_bootstrap *b,unsigned image,birth *out) {
  uint64_t seconds,micros; struct proc_bsdinfo info;
  if (!ae_image_identity(pid,b,image,&seconds,&micros) ||
      proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&info,sizeof(info))!=(int)sizeof(info) ||
      info.pbi_start_tvsec!=seconds || info.pbi_start_tvusec!=micros) return 0;
  out->pid=pid; out->ppid=(pid_t)info.pbi_ppid; out->pgid=(pid_t)info.pbi_pgid;
  out->seconds=seconds; out->micros=micros;
  out->dev=(uint64_t)b->identities[image].st_dev; out->ino=(uint64_t)b->identities[image].st_ino;
  return 1;
}
static int event(owner *o,uint32_t kind,uint32_t command,ae_result result,const ae_artifact *artifact,uint32_t slot,const uint8_t *payload,size_t size) {
  if (o->channel_lost || size>AE_EVENT_MAX_BYTES || o->serial==UINT32_MAX) return 0;
  uint8_t frame[AE_EVENT_BYTES]; memset(frame,0,sizeof(frame));
  ae_state *s=&o->boot->custody.state;
  put32(frame,AE_EVENT_MAGIC); put32(frame+4,AE_VERSION); put32(frame+8,kind); put32(frame+12,s->sequence);
  memcpy(frame+16,s->binding,32); memcpy(frame+48,s->launch,32);
  put32(frame+AE_EVENT_PHASE_OFFSET,(uint32_t)s->phase); put32(frame+AE_EVENT_WORKSPACE_OFFSET,(uint32_t)s->workspace);
  put32(frame+AE_EVENT_FLAGS_OFFSET,(uint32_t)((s->preexec_applied ? AE_FLAG_PREEXEC : 0)|(s->reaped ? AE_FLAG_REAPED : 0)|
    (s->streams_sealed ? AE_FLAG_STREAMS : 0)|(s->cutoff ? AE_FLAG_CUTOFF : 0)|(o->provider_seen ? AE_FLAG_PROVIDER : 0)));
  put32(frame+AE_EVENT_EXIT_CODE_OFFSET,(uint32_t)s->exit_code); put32(frame+AE_EVENT_EXIT_SIGNAL_OFFSET,(uint32_t)s->exit_signal);
  put32(frame+AE_EVENT_LENGTH_OFFSET,(uint32_t)size);
  birth_bytes(frame+AE_EVENT_OWNER_OFFSET,&o->owner,AE_IMAGE_HELPER);
  birth_bytes(frame+AE_EVENT_CHILD_OFFSET,&o->child,o->image);
  put32(frame+AE_EVENT_SLOT_OFFSET,slot);
  if (artifact) {
    put32(frame+AE_EVENT_MODE_OFFSET,artifact->mode); put64(frame+AE_EVENT_DEVICE_OFFSET,artifact->device);
    put64(frame+AE_EVENT_INODE_OFFSET,artifact->inode);
  }
  put64(frame+AE_EVENT_WORKSPACE_DEVICE_OFFSET,s->workspace_dev); put64(frame+AE_EVENT_WORKSPACE_INODE_OFFSET,s->workspace_ino);
  put32(frame+AE_EVENT_SERIAL_OFFSET,++o->serial); put32(frame+AE_EVENT_COMMAND_OFFSET,command);
  put32(frame+AE_EVENT_RESULT_OFFSET,(uint32_t)result); put32(frame+AE_EVENT_REVISION_OFFSET,s->revision);
  if (s->preexec_applied) memcpy(frame+AE_EVENT_ATTESTATION_OFFSET,o->boot->manifest.bindings[6],32);
  uint64_t deadline=now_ms()+1000;
  if (o->transfer_deadline && o->transfer_deadline<deadline) deadline=o->transfer_deadline;
  if (!transfer(o->boot->channel,frame,sizeof(frame),1,deadline) ||
      (size && !transfer(o->boot->channel,(void *)payload,size,1,deadline))) {
    o->channel_lost=1; return 0;
  }
  return 1;
}
static void quarantine(owner *o) {
  (void)ae_channel_lost(&o->boot->custody.state,ae_native_persist,&o->boot->custody);
  /* Direct wait/stop ownership is held independently from journal truth. A
   * persistence failure must not erase an unreaped child or redirect its PID. */
}
static int pair_pipe(int p[2]) {
  if (pipe(p)!=0) return 0;
  if (fcntl(p[0],F_SETFD,FD_CLOEXEC)==0 && fcntl(p[1],F_SETFD,FD_CLOEXEC)==0) return 1;
  (void)close_one(&p[0]); (void)close_one(&p[1]); return 0;
}
static int drop_and_reset(uid_t uid,gid_t gid) {
  struct sigaction action; memset(&action,0,sizeof(action)); action.sa_handler=SIG_DFL;
  if (sigemptyset(&action.sa_mask)!=0) return 0;
  for (int s=1;s<NSIG;s++) if (s!=SIGKILL && s!=SIGSTOP && sigaction(s,&action,NULL)!=0) return 0;
  sigset_t mask;
  struct rlimit core={0,0};
  if (sigemptyset(&mask)!=0 || sigprocmask(SIG_SETMASK,&mask,NULL)!=0 || setrlimit(RLIMIT_CORE,&core)!=0 ||
      task_set_bootstrap_port(mach_task_self(),MACH_PORT_NULL)!=KERN_SUCCESS ||
      mach_ports_register(mach_task_self(),NULL,0)!=KERN_SUCCESS ||
      task_set_exception_ports(mach_task_self(),EXC_MASK_ALL,MACH_PORT_NULL,EXCEPTION_DEFAULT,THREAD_STATE_NONE)!=KERN_SUCCESS ||
      setgroups(0,NULL)!=0 || setgid(gid)!=0 || setuid(uid)!=0) return 0;
  struct proc_bsdinfo self;
  return getuid()==uid && geteuid()==uid && getgid()==gid && getegid()==gid && getgroups(0,NULL)==0 &&
    proc_pidinfo(getpid(),PROC_PIDTBSDINFO,0,&self,sizeof(self))==(int)sizeof(self) &&
    self.pbi_uid==uid && self.pbi_ruid==uid && self.pbi_svuid==uid &&
    self.pbi_gid==gid && self.pbi_rgid==gid && self.pbi_svgid==gid;
}
static void spawn_child(owner *o,int input,int output,int error,int manifest,int ack,int gate) {
  ae_bootstrap *b=o->boot;
  int sources[]={input,output,error,b->route,manifest,ack,gate};
  /* First lift all sources above the target FD map; dup2 ordering cannot alias
   * a still-needed source. No root/namespace descriptor survives this map. */
  int copies[7];
  for (unsigned i=0;i<7;i++) {
    copies[i]=fcntl(sources[i],F_DUPFD_CLOEXEC,32);
    if (copies[i]<0) _exit(126);
  }
  char workspace[PATH_MAX],envelope[PATH_MAX],home[PATH_MAX],codex_home[PATH_MAX+16],tmp[PATH_MAX+16],private_arg[PATH_MAX+16],workspace_arg[PATH_MAX+16];
  if (fcntl(b->custody.workspace,F_GETPATH,workspace)!=0 || fcntl(b->custody.envelope,F_GETPATH,envelope)!=0 ||
      snprintf(home,sizeof(home),"HOME=%s/private",envelope)>=(int)sizeof(home) ||
      snprintf(codex_home,sizeof(codex_home),"CODEX_HOME=%s/private/codex-home",envelope)>=(int)sizeof(codex_home) ||
      snprintf(tmp,sizeof(tmp),"TMPDIR=%s/private/tmp",envelope)>=(int)sizeof(tmp) ||
      snprintf(private_arg,sizeof(private_arg),"PRIVATE=%s/private",envelope)>=(int)sizeof(private_arg) ||
      snprintf(workspace_arg,sizeof(workspace_arg),"WORKSPACE=%s",workspace)>=(int)sizeof(workspace_arg) ||
      fchdir(b->custody.workspace)!=0 || setpgid(0,0)!=0) _exit(126);
  for (int i=0;i<7;i++) if (dup2(copies[i],i)<0 || fcntl(i,F_SETFD,0)!=0) _exit(126);
  int max=getdtablesize();
  if (max<0 || max>1048576) _exit(126);
  for (int fd=7;fd<max;fd++) if (close(fd)!=0 && errno!=EBADF) _exit(126);
  if (!drop_and_reset((uid_t)b->manifest.uid,(gid_t)b->manifest.gid)) _exit(126);
  char *argv[]={b->manifest.images[AE_IMAGE_SANDBOX].path,"-f",b->manifest.images[AE_IMAGE_PROFILE].path,
    "-D",workspace_arg,"-D",private_arg,b->manifest.images[AE_IMAGE_HELPER].path,"--preexec",NULL};
  char *env[]={home,codex_home,tmp,"PATH=/usr/bin:/bin","LANG=C","LC_ALL=C",NULL};
  execve(argv[0],argv,env);
  _exit(126);
}
/* Entered ONLY as the exact helper image exec-replaced by admitted sandbox-exec
 * at the direct child's birth. Unprivileged standalone invocation has no owner
 * channel and cannot issue evidence. Parent checks its fresh challenge and this
 * helper image/birth before releasing the one-byte exec gate. */
int ae_native_preexec(void) {
  uint8_t bytes[AE_MANIFEST_BYTES],challenge[AE_PREEXEC_BYTES]; ae_manifest m;
  uint64_t deadline=now_ms()+5000;
  if (getuid()==0 || geteuid()==0 ||
      !transfer(AE_PREEXEC_MANIFEST_FD,bytes,sizeof(bytes),0,deadline) ||
      !transfer(AE_PREEXEC_MANIFEST_FD,challenge,sizeof(challenge),0,deadline) ||
      !ae_manifest_decode(bytes,sizeof(bytes),&m) || getuid()!=m.uid || geteuid()!=m.uid ||
      getgid()!=m.gid || getegid()!=m.gid || getgroups(0,NULL)!=0) return 126;
  int source=AE_PREEXEC_MANIFEST_FD;
  if (!close_one(&source) || fcntl(AE_PREEXEC_ACK_FD,F_SETFD,FD_CLOEXEC)!=0 ||
      fcntl(AE_PREEXEC_GATE_FD,F_SETFD,FD_CLOEXEC)!=0 ||
      !transfer(AE_PREEXEC_ACK_FD,challenge,sizeof(challenge),1,deadline)) return 126;
  uint8_t go=0;
  if (!transfer(AE_PREEXEC_GATE_FD,&go,1,0,deadline) || go!=1) return 126;
  int ack=AE_PREEXEC_ACK_FD,gate=AE_PREEXEC_GATE_FD;
  if (!close_one(&ack) || !close_one(&gate)) return 126;
  char *argv[AE_MANIFEST_ARGV_SLOTS+1];
  for (unsigned i=0;i<m.argc;i++) argv[i]=m.argv[i];
  argv[m.argc]=NULL;
  /* HOME comes from the root-generated envelope, never the provider's input.
   * The intermediate helper has inherited the already sanitized fixed env. */
  extern char **environ;
  execve(m.images[AE_IMAGE_PROVIDER].path,argv,environ);
  return 126;
}
static int start(owner *o) {
  ae_bootstrap *b=o->boot;
  int input[2]={-1,-1},output[2]={-1,-1},error[2]={-1,-1},manifest[2]={-1,-1},ack[2]={-1,-1},gate[2]={-1,-1};
  if (!pair_pipe(input) || !pair_pipe(output) || !pair_pipe(error) || !pair_pipe(manifest) || !pair_pipe(ack) || !pair_pipe(gate) ||
      getentropy(o->challenge,sizeof(o->challenge))!=0) goto failed;
  if (ae_begin_birth(&b->custody.state,ae_native_persist,&b->custody)!=AE_ACCEPTED) goto failed;
  o->started=now_ms();
  pid_t pid=fork();
  if (pid<0) goto failed; /* Never reinterpret consumed intent as no-start. */
  if (pid==0) spawn_child(o,input[0],output[1],error[1],manifest[0],ack[1],gate[0]);
  o->child.pid=pid; o->born=1;
  o->input=input[1]; input[1]=-1;
  o->output=output[0]; output[0]=-1; o->error=error[0]; error[0]=-1;
  o->ack=ack[0]; ack[0]=-1; o->gate=gate[1]; gate[1]=-1;
  if (!close_one(&input[0]) || fcntl(o->input,F_SETFL,O_NONBLOCK)!=0 || !close_one(&output[1]) || !close_one(&error[1]) || !close_one(&manifest[0]) ||
      !close_one(&ack[1]) || !close_one(&gate[0])) goto failed;
  if (ae_birth_observed(&b->custody.state,ae_native_persist,&b->custody)!=AE_ACCEPTED) goto failed;
  uint64_t deadline=now_ms()+5000;
  if (!transfer(manifest[1],b->manifest_bytes,sizeof(b->manifest_bytes),1,deadline) ||
      !transfer(manifest[1],o->challenge,sizeof(o->challenge),1,deadline) || !close_one(&manifest[1])) goto failed;
  return 1;
failed:
  for (unsigned i=0;i<2;i++) {
    (void)close_one(&input[i]); (void)close_one(&output[i]); (void)close_one(&error[i]); (void)close_one(&manifest[i]);
    (void)close_one(&ack[i]); (void)close_one(&gate[i]);
  }
  quarantine(o); return 0;
}
static void stop_owned(owner *o) {
  if (!o->born || o->reaped || o->wait_lost || o->term_sent) return;
  o->term_sent=1; o->term_at=now_ms();
  /* This owner is the only wait handler; the PID remains allocated through
   * zombie state until OUR waitpid. No caller PID and no post-reap signal. Only
   * one TERM is admitted. KILL escalation requires a later explicit contract. */
  if (kill(o->child.pid,SIGTERM)!=0) quarantine(o);
}
static void reap(owner *o) {
  if (!o->born || o->reaped || o->wait_lost) return;
  int status=0; pid_t pid=waitpid(o->child.pid,&status,WNOHANG);
  if (pid==0 || (pid<0 && errno==EINTR)) return;
  if (pid!=o->child.pid || (!WIFEXITED(status) && !WIFSIGNALED(status))) {
    /* ECHILD/unknown wait ownership is NOT an exit proof. In particular do not
     * signal that PID after an unexpected external/automatic reap. */
    o->wait_lost=1; quarantine(o); return;
  }
  o->reaped=1; /* Set before persistence/event: signaling is now impossible. */
  int code=WIFEXITED(status) ? WEXITSTATUS(status) : -1;
  int signal=WIFSIGNALED(status) ? WTERMSIG(status) : 0;
  if (ae_wait_observed(&o->boot->custody.state,code,signal,ae_native_persist,&o->boot->custody)!=AE_ACCEPTED) {
    quarantine(o); return;
  }
  (void)event(o,AE_EVENT_EXIT,0,AE_ACCEPTED,NULL,0,NULL,0);
}
static void feed_input(owner *o) {
  if (o->input<0) return;
  ae_bootstrap *b=o->boot;
  if (o->input_used<b->input_length) {
    size_t remaining=b->input_length-o->input_used;
    if (remaining>AE_STREAM_CHUNK_BYTES) remaining=AE_STREAM_CHUNK_BYTES;
    ssize_t n=write(o->input,b->input_bytes+o->input_used,remaining);
    if (n<0 && (errno==EINTR || errno==EAGAIN)) return;
    if (n<=0) { o->stream_unknown=1; quarantine(o); (void)close_one(&o->input); return; }
    o->input_used+=(size_t)n;
  }
  if (o->input_used==b->input_length) {
    if (!close_one(&o->input)) { o->stream_unknown=1; quarantine(o); }
    free(b->input_bytes); b->input_bytes=NULL;
  }
}
static void drain(owner *o,int *fd,uint32_t kind) {
  if (*fd<0) return;
  struct pollfd p={*fd,POLLIN,0};
  if (poll(&p,1,0)<=0) return;
  if (p.revents&(POLLERR|POLLNVAL)) { o->stream_unknown=1; quarantine(o); return; }
  if (!(p.revents&(POLLIN|POLLHUP))) return;
  uint8_t bytes[AE_STREAM_CHUNK_BYTES]; ssize_t n=read(*fd,bytes,sizeof(bytes));
  if (n<0 && (errno==EINTR || errno==EAGAIN)) return;
  if (n<0) { o->stream_unknown=1; quarantine(o); return; }
  if (n==0) { if (!close_one(fd)) { o->stream_unknown=1; quarantine(o); } return; }
  o->stream_bytes+=(uint64_t)n;
  if (o->stream_bytes>AE_STREAM_MAX_BYTES ||
      !event(o,kind,0,AE_ACCEPTED,NULL,0,bytes,(size_t)n)) {
    o->stream_unknown=1; quarantine(o);
  }
}
static void observe_exec(owner *o) {
  if (!o->born || o->reaped || o->wait_lost) return;
  ae_bootstrap *b=o->boot;
  if (!b->custody.state.preexec_applied && o->ack>=0) {
    struct pollfd p={o->ack,POLLIN,0};
    if (poll(&p,1,0)>0 && (p.revents&(POLLIN|POLLHUP))) {
      uint8_t ack[AE_PREEXEC_BYTES]; birth observed;
      if (!transfer(o->ack,ack,sizeof(ack),0,now_ms()+1000) || memcmp(ack,o->challenge,sizeof(ack)) ||
          !observe(o->child.pid,b,AE_IMAGE_HELPER,&observed) || observed.ppid!=o->owner.pid ||
          observed.pgid!=observed.pid ||
          (observed.seconds==o->owner.seconds && observed.micros==o->owner.micros) ||
          ae_preexec_observed(&b->custody.state,ae_native_persist,&b->custody)!=AE_ACCEPTED) {
        quarantine(o); return;
      }
      o->child=observed; o->image=AE_IMAGE_HELPER;
      uint8_t go=1;
      if (!event(o,AE_EVENT_PREEXEC,0,AE_ACCEPTED,NULL,0,NULL,0) ||
          !transfer(o->gate,&go,1,1,now_ms()+1000) || !close_one(&o->gate) || !close_one(&o->ack)) {
        quarantine(o); return;
      }
    }
  } else if (b->custody.state.preexec_applied && !o->provider_seen) {
    birth observed;
    if (observe(o->child.pid,b,AE_IMAGE_PROVIDER,&observed)) {
      if (observed.ppid!=o->owner.pid || observed.pgid!=o->child.pgid ||
          observed.seconds!=o->child.seconds || observed.micros!=o->child.micros) { quarantine(o); return; }
      o->provider_seen=1; o->image=AE_IMAGE_PROVIDER; o->child=observed;
      (void)event(o,AE_EVENT_IMAGE,0,AE_ACCEPTED,NULL,0,NULL,0);
    }
  }
}
static uint32_t tree_u32(const uint8_t *p) {
  return ((uint32_t)p[0]<<24)|((uint32_t)p[1]<<16)|((uint32_t)p[2]<<8)|p[3];
}
static int tree_entry_event(void *context,const ae_tree_observed_entry *entry) {
  owner *o=context;
  size_t length=strlen(entry->name);
  uint8_t payload[279];
  put32(payload,entry->ordinal); put32(payload+4,entry->parent);
  put32(payload+8,(uint32_t)entry->directory); put32(payload+12,entry->mode);
  put32(payload+16,entry->size); put32(payload+20,(uint32_t)length);
  memcpy(payload+24,entry->name,length);
  ae_artifact metadata={NULL,0,entry->device,entry->inode,entry->mode};
  return event(o,AE_EVENT_TREE_ENTRY,0,AE_ACCEPTED,&metadata,0,payload,24+length);
}
static int tree_chunk_event(void *context,uint32_t ordinal,uint32_t offset,const uint8_t *bytes,size_t count) {
  owner *o=context;
  uint8_t payload[AE_TREE_REQUEST_MAX_BYTES];
  put32(payload,ordinal); put32(payload+4,offset); memcpy(payload+8,bytes,count);
  return event(o,AE_EVENT_TREE_CHUNK,0,AE_ACCEPTED,NULL,0,payload,8+count);
}
static int materialize_entry(ae_custody *c,const uint8_t *payload,size_t size) {
  if (size<25 || size>279 || tree_u32(payload+20)!=size-24 || memchr(payload+24,0,size-24)) return 0;
  char name[256]; memcpy(name,payload+24,size-24); name[size-24]=0;
  uint32_t directory=tree_u32(payload+8);
  if (directory>1) return 0;
  return ae_tree_entry(c->materialization,tree_u32(payload),tree_u32(payload+4),name,
    (int)directory,tree_u32(payload+12),tree_u32(payload+16));
}
static int publish_attempt_data(ae_custody *c,const char *name,const uint8_t *bytes,size_t size) {
  int fd=openat(c->journal,name,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600);
  if (fd<0) return 0;
  size_t done=0; int ok=1;
  while (done<size) {
    ssize_t n=write(fd,bytes+done,size-done);
    if (n<0 && errno==EINTR) continue;
    if (n<=0) { ok=0; break; }
    done+=(size_t)n;
  }
  if (ok) ok=fsync(fd)==0 && fcntl(fd,F_FULLFSYNC)==0;
  if (!close_one(&fd)) ok=0;
  return ok && fsync(c->journal)==0 && fcntl(c->journal,F_FULLFSYNC)==0;
}
static int scope_matches_root(owner *o,const uint8_t *bytes,unsigned fields) {
  for (unsigned i=0;i<fields;i++) {
    const uint8_t *field=bytes+i*1028;
    uint32_t length=tree_u32(field);
    if (!length || length>1024 || memchr(field+4,0,length)) return 0;
    for (uint32_t j=length;j<1024;j++) if (field[4+j]) return 0;
  }
  uint8_t digest[32];
  CC_SHA256(bytes+4,tree_u32(bytes),digest);
  if (memcmp(digest,o->boot->manifest.bindings[0],32)) return 0;
  uint8_t scope[2049]; uint32_t tenant=tree_u32(bytes+1028),project=tree_u32(bytes+2056);
  memcpy(scope,bytes+1032,tenant); scope[tenant]=0; memcpy(scope+tenant+1,bytes+2060,project);
  CC_SHA256(scope,tenant+1+project,digest);
  return !memcmp(digest,o->boot->manifest.bindings[1],32);
}
static int tree_effect(owner *o,uint32_t kind,const uint8_t *payload,size_t size) {
  ae_custody *c=&o->boot->custody;
  int ok=0;
  switch (kind) {
    case AE_BIND_PREPARED:
      if (c->prepared_bound || !c->creation_committed || size!=AE_PREPARED_BYTES) return 0;
      c->prepared_bound=1; /* Burn before validation or durable publication. */
      if (!scope_matches_root(o,payload,9) || !publish_attempt_data(c,"prepared-attempt",payload,size)) return 0;
      memcpy(c->prepared,payload,size); ok=1; break;
    case AE_CONFIRM_CLAIM:
      if (!c->prepared_bound || c->claim_committed || size<=AE_PREPARED_BYTES || memcmp(payload,c->prepared,AE_PREPARED_BYTES)) return 0;
      c->claim_committed=1;
      ok=publish_attempt_data(c,"committed-claim",payload,size);
      if (ok) {memcpy(c->committed,payload,size); c->committed_length=size;}
      break;
    case AE_MATERIALIZE_BEGIN:
      if (c->materialization_consumed || size!=16) return 0;
      c->materialization_consumed=1; /* Burn before allocation or any syscall. */
      c->tree_limits=(ae_tree_limits){tree_u32(payload),tree_u32(payload+4),tree_u32(payload+8),tree_u32(payload+12)};
      c->materialization=ae_tree_begin(c->workspace,&c->tree_limits);
      ok=c->materialization!=NULL; break;
    case AE_MATERIALIZE_ENTRY:
      ok=materialize_entry(c,payload,size); break;
    case AE_MATERIALIZE_CHUNK:
      ok=size>8 && ae_tree_chunk(c->materialization,tree_u32(payload),tree_u32(payload+4),payload+8,size-8); break;
    case AE_MATERIALIZE_FINISH: {
      if (!c->materialization || !ae_tree_finish(c->materialization)) return 0;
      ae_tree_transaction *owned=c->materialization; c->materialization=NULL;
      if (!ae_tree_dispose(owned)) return 0;
      c->materialization_complete=1;
      ok=1; break;
    }
    case AE_COMMIT_CREATION:
      if (!c->materialization_complete || c->creation_committed || size!=AE_CREATION_BYTES) return 0;
      c->creation_committed=1;
      if (!scope_matches_root(o,payload+32,3) || !publish_attempt_data(c,"workspace-creation",payload,size)) return 0;
      memcpy(c->creation,payload,size); memcpy(c->materialization_digest,payload,32);
      memcpy(c->operation_id,payload+36,tree_u32(payload+32)); ok=1; break;
    case AE_READ_TREE: {
      o->transfer_deadline=now_ms()+5000;
      struct stat root;
      if (!c->materialization_complete || !ae_tree_observe(c->workspace,&c->tree_limits,tree_entry_event,tree_chunk_event,o) ||
          fstat(c->workspace,&root)!=0 || (uint64_t)root.st_dev!=c->device || (uint64_t)root.st_ino!=c->inode) return 0;
      uint8_t end[24]={0}; put32(end,(uint32_t)root.st_mode);
      put64(end+8,(uint64_t)root.st_ctimespec.tv_sec*1000000000u+(uint64_t)root.st_ctimespec.tv_nsec);
      put64(end+16,(uint64_t)root.st_mtimespec.tv_sec*1000000000u+(uint64_t)root.st_mtimespec.tv_nsec);
      ok=event(o,AE_EVENT_TREE_END,0,AE_ACCEPTED,NULL,0,end,sizeof(end));
      o->transfer_deadline=0; break;
    }
    default: return 0;
  }
  if (!ok) return 0;
  ae_state next=c->state; next.pending_effect=0; next.pending_argument=0;
  return ae_commit(&c->state,&next,ae_native_persist,c)==AE_ACCEPTED;
}
static int material_effect(owner *o,uint32_t kind,const uint8_t *payload,size_t size) {
  ae_custody *c=&o->boot->custody;
  uint8_t output[AE_MATERIAL_RESULT_BYTES]; size_t length=0; uint32_t response=0;
  int ok=0;
  switch (kind) {
    case AE_READ_OBSERVATION:
      ok=ae_native_observe_launch(c,output,c->state.revision+1);
      length=AE_OBSERVATION_BYTES; response=AE_EVENT_OBSERVATION; break;
    case AE_MATERIAL_BEGIN: ok=ae_native_material_begin(c,payload,size); break;
    case AE_MATERIAL_CHUNK: ok=ae_native_material_chunk(c,payload,size); break;
    case AE_MATERIAL_FINISH:
      ok=ae_native_material_finish(c,output,c->state.revision+1);
      length=AE_MATERIAL_RESULT_BYTES; response=AE_EVENT_MATERIAL_RESULT; break;
    default: return 0;
  }
  if (!ok) return 0;
  ae_state next=c->state; next.pending_effect=0; next.pending_argument=0;
  if (ae_commit(&c->state,&next,ae_native_persist,c)!=AE_ACCEPTED) return 0;
  return !response || event(o,response,kind,AE_ACCEPTED,NULL,0,output,length);
}
static int dispatch(owner *o,const ae_request *request,const uint8_t *payload,size_t size) {
  ae_custody *c=&o->boot->custody;
  if (!ae_host_identity(o->boot)) { quarantine(o); return 0; }
  if (request->kind==AE_START_ONCE && (!c->materialization_complete || !c->creation_committed ||
      !c->prepared_bound || !c->claim_committed || !c->material_ready))
    return event(o,AE_EVENT_REFUSED,request->kind,AE_REFUSED,NULL,0,NULL,0);
  ae_result result=ae_command(&c->state,request,ae_native_persist,c);
  if (result==AE_EFFECT_REQUIRED) {
    int ok=0;
    switch (request->kind) {
      case AE_START_ONCE: ok=ae_native_validate_launch(c) && start(o); break;
      case AE_READ_OBSERVATION: case AE_MATERIAL_BEGIN: case AE_MATERIAL_CHUNK: case AE_MATERIAL_FINISH:
        ok=material_effect(o,request->kind,payload,size); break;
      case AE_MATERIALIZE_BEGIN: case AE_MATERIALIZE_ENTRY: case AE_MATERIALIZE_CHUNK:
      case AE_MATERIALIZE_FINISH: case AE_COMMIT_CREATION: case AE_READ_TREE:
      case AE_BIND_PREPARED: case AE_CONFIRM_CLAIM:
        ok=tree_effect(o,request->kind,payload,size); break;
      case AE_WORKSPACE_FREEZE: ok=ae_native_workspace_move(c,AE_FROZEN); break;
      case AE_WORKSPACE_CLEANUP: ok=ae_native_workspace_move(c,AE_CLEANUP); break;
      case AE_WORKSPACE_CLOSE: ok=ae_native_workspace_move(c,AE_CLOSED); break;
      case AE_DISPOSE_ONCE: ok=ae_native_dispose_private(c); break;
      case AE_READ_CLOSED_WORKSPACE: ok=ae_native_read_closed(c); break;
      default: break;
    }
    if (!ok) { quarantine(o); result=AE_UNKNOWN; }
    else result=AE_ACCEPTED;
  }
  if (result==AE_ACCEPTED && (request->kind==AE_READ_OBSERVATION || request->kind==AE_MATERIAL_FINISH)) return 1;
  return event(o,result==AE_REFUSED ? AE_EVENT_REFUSED : AE_EVENT_STATUS,request->kind,result,NULL,0,NULL,0);
}
/* One retained read-only grant, captured before releasing live owner handles,
 * activated ONLY by the successful actual release below. No caller ticket,
 * path or active-root reopen is used. Grant resources close before readback is
 * acknowledged; timeout/disconnect/close uncertainty cannot claim success. */
static int close_reader(ae_custody *reader,int *image) {
  int ok=1;
  if (!close_one(&reader->workspace)) ok=0;
  if (!close_one(&reader->envelope)) ok=0;
  if (!close_one(&reader->journal)) ok=0;
  if (!close_one(image)) ok=0;
  return ok;
}
static int serve_closed_reader(owner *o,ae_custody *reader,int image,const uint8_t ticket[AE_CLOSED_RECORD_BYTES]) {
  ae_bootstrap *b=o->boot;
  uint8_t frame[AE_FRAME_BYTES]; ae_request request;
  b->images[AE_IMAGE_HOST]=image;
  o->transfer_deadline=now_ms()+6000;
  int ok=transfer(b->channel,frame,sizeof(frame),0,o->transfer_deadline) &&
    ae_decode(frame,sizeof(frame),&request) && request.kind==AE_READ_CLOSED_WORKSPACE &&
    request.sequence==reader->state.sequence+1 && !memcmp(request.binding,reader->state.binding,32) &&
    !memcmp(request.launch,reader->state.launch,32) && ae_host_identity(b) && ae_native_read_closed(reader);
  if (ok) {
    /* Original record sequence remains captured in reader; response sequence
     * belongs to this single fresh read transaction, not a journal mutation. */
    b->custody.state.sequence=request.sequence;
    ok=ae_tree_observe(reader->workspace,&reader->tree_limits,tree_entry_event,tree_chunk_event,o);
    struct stat root;
    if (ok) ok=fstat(reader->workspace,&root)==0;
    if (ok) {
      uint8_t end[24]={0}; put32(end,(uint32_t)root.st_mode);
      put64(end+8,(uint64_t)root.st_ctimespec.tv_sec*1000000000u+(uint64_t)root.st_ctimespec.tv_nsec);
      put64(end+16,(uint64_t)root.st_mtimespec.tv_sec*1000000000u+(uint64_t)root.st_mtimespec.tv_nsec);
      ok=event(o,AE_EVENT_TREE_END,0,AE_ACCEPTED,NULL,0,end,sizeof(end));
    }
    if (ok) ok=ae_native_read_closed(reader);
  }
  if (!close_reader(reader,&b->images[AE_IMAGE_HOST])) ok=0;
  if (ok) ok=event(o,AE_EVENT_CLOSED_READ,AE_READ_CLOSED_WORKSPACE,AE_ACCEPTED,NULL,0,ticket,AE_CLOSED_RECORD_BYTES);
  if (!close_one(&b->channel)) ok=0;
  return ok ? 0 : 75;
}
int ae_native_owner_loop(ae_bootstrap *b) {
  owner o; memset(&o,0,sizeof(o)); o.boot=b;
  o.input=-1; o.output=-1; o.error=-1; o.ack=-1; o.gate=-1;
  uint64_t admission_deadline=now_ms()+5000;
  while (!ae_host_identity(b)) {
    if (now_ms()>=admission_deadline) return 78;
    struct pollfd p={b->channel,0,0};
    if (poll(&p,1,10)<0 || (p.revents&(POLLHUP|POLLERR|POLLNVAL))) return 78;
  }
  if (!observe(getpid(),b,AE_IMAGE_HELPER,&o.owner) ||
      !ae_native_stage_namespace(&b->custody)) return 78;
  struct sigaction ignore; memset(&ignore,0,sizeof(ignore)); ignore.sa_handler=SIG_IGN;
  if (sigemptyset(&ignore.sa_mask)!=0 || sigaction(SIGPIPE,&ignore,NULL)!=0) return 78;
  uint8_t hello[AE_HELLO_BYTES];
  memcpy(hello,b->custody.namespace_name,40); memcpy(hello+40,b->manifest_bytes,AE_MANIFEST_BYTES);
  if (!event(&o,AE_EVENT_HELLO,0,AE_ACCEPTED,NULL,0,hello,sizeof(hello))) quarantine(&o);
  uint64_t owner_deadline=now_ms()+b->manifest.run_ms+b->manifest.term_ms+10000;
  uint8_t frame[AE_FRAME_BYTES]; size_t used=0; uint64_t partial_since=0;
  for (;;) {
    ae_state *s=&b->custody.state;
    uint64_t now=now_ms();
    if (!now) { quarantine(&o); now=1; }
    if (now>=owner_deadline || o.channel_lost || (used && now-partial_since>1000) ||
        (o.born && !o.reaped && now-o.started>b->manifest.run_ms)) quarantine(&o);
    if (s->cutoff || s->phase==AE_QUARANTINED) stop_owned(&o);
    observe_exec(&o);
    reap(&o);
    feed_input(&o);
    drain(&o,&o.output,AE_EVENT_STDOUT); drain(&o,&o.error,AE_EVENT_STDERR);
    if (!s->streams_sealed && !o.stream_unknown && o.input<0 && o.output<0 && o.error<0 &&
        (s->phase==AE_NO_START || (s->phase==AE_EXIT_PROVED && o.reaped))) {
      if (ae_streams_observed(s,ae_native_persist,&b->custody)==AE_ACCEPTED)
        (void)event(&o,AE_EVENT_STREAMS,0,AE_ACCEPTED,NULL,0,NULL,0);
    }
    if (s->phase==AE_QUARANTINED && (!o.born || o.reaped || o.wait_lost ||
        (o.term_sent && now-o.term_at>b->manifest.term_ms))) return 75;
    if (s->phase==AE_DISPOSED) {
      uint8_t ticket[AE_CLOSED_RECORD_BYTES]; int ok=1;
      ae_custody reader=b->custody;
      reader.workspace=fcntl(b->custody.workspace,F_DUPFD_CLOEXEC,0);
      reader.envelope=fcntl(b->custody.envelope,F_DUPFD_CLOEXEC,0);
      reader.journal=fcntl(b->custody.journal,F_DUPFD_CLOEXEC,0);
      int reader_image=fcntl(b->images[AE_IMAGE_HOST],F_DUPFD_CLOEXEC,0);
      if (reader.workspace<0 || reader.envelope<0 || reader.journal<0 || reader_image<0) ok=0;
      for (unsigned i=0;i<b->manifest.image_count;i++) if (!close_one(&b->images[i])) ok=0;
      if (!close_one(&b->input) || !close_one(&b->route) || !close_one(&o.ack) || !close_one(&o.gate)) ok=0;
      free(b->input_bytes); b->input_bytes=NULL;
      if (!ok || !ae_native_release(&b->custody,ticket)) {
        (void)close_reader(&reader,&reader_image); quarantine(&o); return 75;
      }
      reader.state=b->custody.state;
      if (!event(&o,AE_EVENT_RELEASED,0,AE_ACCEPTED,NULL,0,ticket,sizeof(ticket))) {
        (void)close_reader(&reader,&reader_image); return 75;
      }
      return serve_closed_reader(&o,&reader,reader_image,ticket);
    }
    struct pollfd p={b->channel,POLLIN,0};
    int n=poll(&p,1,10);
    if (n<0 && errno==EINTR) continue;
    if (n<0 || (n && (p.revents&(POLLERR|POLLNVAL)))) { o.channel_lost=1; continue; }
    if (!n || !(p.revents&(POLLIN|POLLHUP))) continue;
    ssize_t got=read(b->channel,frame+used,sizeof(frame)-used);
    if (got<0 && (errno==EINTR || errno==EAGAIN)) continue;
    if (got<=0) { o.channel_lost=1; continue; }
    if (!used) partial_since=now;
    used+=(size_t)got;
    if (used==sizeof(frame)) {
      ae_request request;
      uint8_t payload[AE_TREE_REQUEST_MAX_BYTES]; size_t size=0;
      if (!ae_decode(frame,sizeof(frame),&request)) { o.channel_lost=1; used=0; continue; }
      if (request.kind==AE_MATERIALIZE_BEGIN || request.kind==AE_MATERIALIZE_ENTRY ||
          request.kind==AE_MATERIALIZE_CHUNK || request.kind==AE_COMMIT_CREATION ||
          request.kind==AE_BIND_PREPARED || request.kind==AE_CONFIRM_CLAIM ||
          request.kind==AE_MATERIAL_BEGIN || request.kind==AE_MATERIAL_CHUNK) size=request.argument;
      if (size && !transfer(b->channel,payload,size,0,now_ms()+1000)) { o.channel_lost=1; used=0; continue; }
      uint8_t queued;
      ssize_t extra=recv(b->channel,&queued,1,MSG_PEEK|MSG_DONTWAIT);
      if (extra>=0 || (errno!=EAGAIN && errno!=EWOULDBLOCK)) { o.channel_lost=1; used=0; continue; }
      if (!dispatch(&o,&request,payload,size)) o.channel_lost=1;
      used=0; partial_since=0;
    }
  }
}
#endif
