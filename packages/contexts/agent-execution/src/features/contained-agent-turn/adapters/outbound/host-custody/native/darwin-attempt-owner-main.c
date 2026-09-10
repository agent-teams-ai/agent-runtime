#include "darwin-attempt-owner-bootstrap.h"
#include <stdio.h>
#include <string.h>
int main(int argc,char **argv) {
#ifdef __APPLE__
  if (argc==2 && !strcmp(argv[1],"--preexec")) return ae_native_preexec();
  /* No elevation, pathname/UID/command options or provider activation from
   * ordinary input. Root supplies the exact fixed descriptor packet already
   * approved for this binary and attempt. Capture and isolation precede staging
   * and START; incomplete/deployment-unqualified packets perform no launch. */
  if (argc==1) {
    ae_bootstrap bootstrap;
    if (ae_root_capture(&bootstrap) && ae_root_isolate_host(&bootstrap))
      return ae_native_owner_loop(&bootstrap);
  }
#else
  (void)argc; (void)argv;
#endif
  fputs("darwin-attempt-owner: root admission capture unavailable or refused\n",stderr);
  return 78;
}
