#ifndef AE_DARWIN_ATTEMPT_OWNER_STATE_H
#define AE_DARWIN_ATTEMPT_OWNER_STATE_H
#include "darwin-attempt-owner-protocol.h"
/* These are private in-process facts, not a remotely registerable authority. */
typedef enum { AE_EMPTY, AE_RESERVED, AE_STAGED, AE_START_CONSUMED,
  AE_CHILD_OWNED, AE_EXIT_PROVED, AE_NO_START, AE_DISPOSED,
  AE_RELEASED, AE_QUARANTINED } ae_phase;
typedef enum { AE_ACTIVE, AE_FROZEN, AE_CLEANUP, AE_CLOSED } ae_workspace;
typedef struct {
  ae_phase phase;
  ae_workspace workspace;
  uint32_t sequence, revision, settlements, pending_effect, pending_argument;
  ae_request last_request;
  int has_last_request;
  uint8_t binding[32], launch[32];
  uint64_t workspace_dev, workspace_ino;
  int cutoff, streams_sealed, reaped, preexec_applied, birth_attempted;
  int exit_code, exit_signal;
} ae_state;
typedef enum { AE_REFUSED, AE_ACCEPTED, AE_EFFECT_REQUIRED, AE_UNKNOWN } ae_result;
/* Durable writer is internal native storage, injected only in pure unit tests.
 * A successful return requires atomic publication, file+directory sync AND close.
 * No persisted state is itself root bootstrap authorization. */
typedef int (*ae_persist)(void *, const ae_state *);
void ae_init(ae_state *, const uint8_t *, const uint8_t *);
ae_result ae_commit(ae_state *, const ae_state *, ae_persist, void *);
ae_result ae_command(ae_state *, const ae_request *, ae_persist, void *);
/* Native loop must claim this once immediately before a possible birth. This
 * consumes intent, not root admission; no caller command invokes a syscall. */
ae_result ae_begin_birth(ae_state *, ae_persist, void *);
/* Lost/partial control transport cannot be repaired into a new attempt. */
ae_result ae_channel_lost(ae_state *, ae_persist, void *);
int ae_writer_stopped(const ae_state *);
int ae_may_signal(const ae_state *);
int ae_identity_reusable(const ae_state *);
#endif
