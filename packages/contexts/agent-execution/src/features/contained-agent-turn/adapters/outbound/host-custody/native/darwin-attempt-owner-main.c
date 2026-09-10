#include "darwin-attempt-owner-bootstrap.h"
#include <stdio.h>
#include <string.h>
#ifdef AE_HOST_PEER_ADDON
#include <node_api.h>
static napi_value verify_peer(napi_env env,napi_callback_info info) {
  size_t argc=1,size=0; napi_value argv[1]; void *bytes=NULL; bool buffer=false;
  int ok=napi_get_cb_info(env,info,&argc,argv,NULL,NULL)==napi_ok && argc==1 &&
    napi_is_buffer(env,argv[0],&buffer)==napi_ok && buffer &&
    napi_get_buffer_info(env,argv[0],&bytes,&size)==napi_ok;
#ifdef __APPLE__
  ok=ok && ae_verify_host_peer(bytes,size);
#else
  (void)bytes; (void)size; ok=0;
#endif
  if (!ok) {napi_throw_error(env,NULL,"native root peer verification refused"); return NULL;}
  napi_value result;
  if (napi_get_boolean(env,true,&result)!=napi_ok) return NULL;
  return result;
}
static napi_value initialize_peer(napi_env env,napi_value exports) {
  napi_value function;
  if (napi_create_function(env,"verifyRootPeer",NAPI_AUTO_LENGTH,verify_peer,NULL,&function)!=napi_ok ||
      napi_set_named_property(env,exports,"verifyRootPeer",function)!=napi_ok) return NULL;
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME,initialize_peer)
#else
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

#endif
