#ifndef AE_DARWIN_ATTEMPT_OWNER_BOOTSTRAP_H
#define AE_DARWIN_ATTEMPT_OWNER_BOOTSTRAP_H
#include "darwin-attempt-owner-custody.h"
#ifdef __APPLE__
#include <sys/stat.h>
#include <mach/message.h>
/* Private native captures, never deserialized from Host command input. Root
 * creates the socketpair here and exec-replaces the launcher with the exact
 * admitted Host image. The other process is this owner, whose only child is
 * the bounded provider bootstrap. This interface has no install/elevation API. */
typedef struct {
  ae_manifest manifest;
  ae_grant grant;
  uint8_t manifest_bytes[AE_MANIFEST_BYTES], manifest_digest[32];
  int images[AE_MANIFEST_IMAGES];
  struct stat identities[AE_MANIFEST_IMAGES];
  ae_custody custody;
  int channel, input, route;
  int final_consumed, final_ready;
  uint8_t final_data[AE_FINAL_LAUNCH_BYTES];
  uint8_t *input_bytes;
  size_t input_length;
  /* Captured from both ends of THIS root-created pair before fork. Darwin
   * credentials name the creator, not the later owner child. Never serialized
   * from HELLO or accepted from a caller credential record. */
  uint8_t root_challenge[AE_ROOT_CHALLENGE_BYTES];
  audit_token_t creator_token;
  pid_t creator_epid;
  pid_t host_pid;
  uint64_t host_birth_seconds, host_birth_micros;
} ae_bootstrap;
int ae_verify_host_peer(const uint8_t *,size_t);
int ae_revalidate_root_images(ae_bootstrap *);
int ae_root_capture(ae_bootstrap *);
/* On success only the native owner returns; the root launcher exec-replaces
 * into the pinned Host after dropping all root authority and root descriptors.
 * A failed exec exits without becoming a second owner or restarting. */
int ae_root_isolate_host(ae_bootstrap *);
int ae_host_identity(const ae_bootstrap *);
int ae_image_identity(pid_t,const ae_bootstrap *,unsigned,uint64_t *,uint64_t *);
int ae_native_owner_loop(ae_bootstrap *);
int ae_native_preexec(void);
#endif
#endif
