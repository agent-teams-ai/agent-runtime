#ifndef AE_DARWIN_ATTEMPT_OWNER_CUSTODY_H
#define AE_DARWIN_ATTEMPT_OWNER_CUSTODY_H
#include "darwin-attempt-owner-state.h"
#ifdef __APPLE__
#include <sys/types.h>
/* Native-only captured descriptors. None may cross the Host/provider wire.
 * Bootstrap must establish root/ancestor/ACL/loader/channel/range authority
 * before constructing this object. There is deliberately no public constructor. */
typedef struct {
  int envelope, workspace, journal;
  int approved_parent, lease_registry, allocation_lock, uid_lease, gid_lease;
  uid_t host_uid, leased_uid;
  gid_t leased_gid;
  char namespace_name[41];
  uint64_t device, inode;
  uint64_t private_device, private_inode;
  ae_state state;
  int unknown;
} ae_custody;
typedef struct {
  uint8_t *bytes;
  size_t length;
  uint64_t device, inode;
  uint32_t mode;
} ae_artifact;
/* Internal effect implementation only; root bootstrap captures the exact
 * descriptors and the immutable reserved-range grant before staging. */
int ae_native_stage_namespace(ae_custody *);
int ae_native_persist(void *, const ae_state *);
int ae_native_workspace_move(ae_custody *, ae_workspace);
int ae_native_artifact(ae_custody *, uint32_t, ae_artifact *);
int ae_native_dispose_private(ae_custody *);
/* Readback requires a separately retained, known-successful closed-state
 * authority. It never reconstructs success from an ambiguous active journal. */
int ae_native_read_closed(ae_custody *);
int ae_native_restore_closed(ae_custody *, const uint8_t [AE_CLOSED_RECORD_BYTES]);
int ae_native_release(ae_custody *, uint8_t [AE_CLOSED_RECORD_BYTES]);
#endif
#endif
