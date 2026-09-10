/* Separate finite rejecting probe image, NEVER part of the production owner.
 * Root may later compile with AE_REJECTING_PROBE_MAIN and capture this exact
 * image in a disposable admitted launch. No result issues qualification.
 * A complete exact policy/loader/FD/IPC review is still required. */
#include <stdio.h>
#include <string.h>
#ifdef __APPLE__
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <mach/mach.h>
#include <errno.h>
#include <signal.h>
#include <unistd.h>

static int denied(int result,int error) {return result<0 && (error==EPERM || error==EACCES);}
static int no_delegated_bootstrap(void) {
  mach_port_t port=MACH_PORT_NULL;
  kern_return_t result=task_get_bootstrap_port(mach_task_self(),&port);
  int ok=result==KERN_SUCCESS && port==MACH_PORT_NULL;
  if (port!=MACH_PORT_NULL && mach_port_deallocate(mach_task_self(),port)!=KERN_SUCCESS) return 0;
  return ok;
}
static int reject_mapping_descendant(void) {
  void *mapping=mmap(NULL,4096,PROT_READ|PROT_WRITE,MAP_ANON|MAP_SHARED,-1,0);
  if (mapping==MAP_FAILED) return 0; /* Can't claim the fork probe ran. */
  errno=0;pid_t child=fork();int error=errno,ok=denied((int)child,error);
  if (child==0) {*(volatile unsigned char *)mapping=1;_exit(90);}
  if (child>0) {
    int status;
    while (waitpid(child,&status,0)<0 && errno==EINTR) {}
    ok=0; /* A descendant inherited a writable mapping: never qualify. */
  }
  if (munmap(mapping,4096)!=0) ok=0;
  return ok;
}
static int reject_unix_transfer_channel(void) {
  int pair[2]={-1,-1};
  errno=0;int result=socketpair(AF_UNIX,SOCK_STREAM,0,pair),error=errno;
  int ok=denied(result,error);
  /* Success demonstrates an unqualified local descriptor-transfer channel.
   * No external peer, pathname or real workspace descriptor is supplied. */
  for (unsigned i=0;i<2;i++) if (pair[i]>=0 && close(pair[i])!=0) ok=0;
  return ok;
}
#endif

int ae_rejecting_probe_main(int argc,char **argv) {
  if (argc!=2 || strcmp(argv[1],"--restricted-singleton-probe")) return 78;
#ifdef __APPLE__
  if (!getuid() || getuid()!=geteuid() || getgid()!=getegid() || getgroups(0,NULL)!=0) return 78;
  /* Independent root harness also imposes an outer deadline and records exact
   * native child birth/wait/EOF. Timeout is failure, never a passed probe. */
  if (signal(SIGALRM,SIG_DFL)==SIG_ERR) return 78;
  alarm(5);
  int ipc=no_delegated_bootstrap();
  int mapping=reject_mapping_descendant();
  int transfer=reject_unix_transfer_channel();
  alarm(0);
  printf("{\"bootstrapAbsent\":%d,\"mappingDescendantRejected\":%d,\"unixTransferChannelRejected\":%d,\"qualificationIssued\":false}\n",
    ipc,mapping,transfer);
  return ipc && mapping && transfer ? 0 : 1;
#else
  fputs("rejecting probes require separately authorized exact Mac admission; no probes executed\n",stderr);
  return 78;
#endif
}
#ifdef AE_REJECTING_PROBE_MAIN
int main(int argc,char **argv) {return ae_rejecting_probe_main(argc,argv);}
#endif
