#ifndef AE_DARWIN_ATTEMPT_OWNER_PROTOCOL_H
#define AE_DARWIN_ATTEMPT_OWNER_PROTOCOL_H
#include <stddef.h>
#include <stdint.h>
/* Sole wire definition. TS reads these literal definitions; no JSON parser and
 * therefore no duplicate-key ambiguity. All integers unsigned big-endian.
 * Binding is the root-captured digest of operation/attempt/boot/generation,
 * namespace/lease/consumer set. Digests identify; they NEVER grant authority.
 * Exactly one frame per request; EOF with a partial frame is channel loss.
 * No paths, PIDs, UID/GID, arbitrary receipt IDs or argv appear on this wire. */
#define AE_MAGIC 1095053105
#define AE_VERSION 1
#define AE_FRAME_BYTES 112
#define AE_MAGIC_OFFSET 0
#define AE_VERSION_OFFSET 4
#define AE_KIND_OFFSET 8
#define AE_SEQUENCE_OFFSET 12
#define AE_BINDING_OFFSET 16
#define AE_LAUNCH_OFFSET 48
#define AE_ARGUMENT_OFFSET 80
#define AE_DIGEST_BYTES 32
#define AE_START_ONCE 1
#define AE_CUTOFF 2
#define AE_READ_STATUS 3
#define AE_SETTLE_LAUNCH_ROUTE 4
#define AE_SETTLE_ARTIFACT_RESULT 5
#define AE_WORKSPACE_FREEZE 6
#define AE_WORKSPACE_CLEANUP 7
#define AE_WORKSPACE_CLOSE 8
#define AE_SETTLE_WORKSPACE 9
#define AE_SETTLE_PRIVATE 10
#define AE_READ_ARTIFACT_SLOT 11
#define AE_DISPOSE_ONCE 12
#define AE_READ_CLOSED_WORKSPACE 13
#define AE_ARTIFACT_SLOTS 2
#define AE_ARTIFACT_MAX_BYTES 1048576
/* The entire admitted writable workspace is these two regular files. Empty
 * or richer trees require a separately reviewed manifest, never truncation. */
#define AE_SLOT_0 "analysis.txt"
#define AE_SLOT_1 "result.json"
typedef struct {
  uint32_t kind, sequence, argument;
  uint8_t binding[AE_DIGEST_BYTES], launch[AE_DIGEST_BYTES];
} ae_request;
int ae_decode(const uint8_t *, size_t, ae_request *);
#endif
