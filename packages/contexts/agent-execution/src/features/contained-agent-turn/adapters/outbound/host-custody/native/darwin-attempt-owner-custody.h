#ifndef AE_DARWIN_ATTEMPT_OWNER_CUSTODY_H
#define AE_DARWIN_ATTEMPT_OWNER_CUSTODY_H
#include "darwin-attempt-owner-state.h"
#include "darwin-attempt-owner-tree.h"
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
  uint64_t private_device, private_inode, codex_home_inode, tmp_inode;
  char operation_id[1025];
  ae_tree_transaction *material_transaction;
  int material_root, material_consumed, material_ready;
  uint32_t material_file, material_offset, config_size, catalog_size;
  uint8_t installation_id[36];
  uint8_t material_facts[3*AE_FILE_FACT_BYTES];
  ae_state state;
  int unknown;
  ae_tree_transaction *materialization;
  ae_tree_limits tree_limits;
  int materialization_consumed, materialization_complete, creation_committed;
  int prepared_bound, claim_committed;
  uint8_t prepared[AE_PREPARED_BYTES];
  uint8_t committed[AE_TREE_REQUEST_MAX_BYTES];
  size_t committed_length;
  uint8_t materialization_digest[32];
  uint8_t creation[AE_CREATION_BYTES];
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
int ae_native_dispose_private(ae_custody *);
/* Private cutoff only; settles native transactions without erasing replay debt. */
int ae_native_abort_transactions(ae_custody *);
/* Readback requires a separately retained, known-successful closed-state
 * authority. It never reconstructs success from an ambiguous active journal. */
int ae_native_read_closed(ae_custody *);
/* Fresh original-inode query before release; never a resource-release grant. */
int ae_native_query_closed(ae_custody *);
int ae_native_validate_journal(ae_custody *);
int ae_native_release(ae_custody *, uint8_t [AE_CLOSED_RECORD_BYTES]);
#endif
#endif
