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
/* Root bootstrap is a separate, fixed FD-only interface; it is never accepted
 * on the Host command channel. Each fixed-width string has one terminating NUL
 * and zero tail. All unused image/argv entries and all reserved bytes are zero.
 * A root-controlled grant authorizes the exact captured manifest SHA-256, range,
 * Host image/isolation and qualification closure. Hashes identify that grant;
 * possession of caller-created bytes does not authorize anything. */
#define AE_MANIFEST_MAGIC 1095060785
#define AE_MANIFEST_BYTES 8192
#define AE_MANIFEST_IDS_OFFSET 16
#define AE_MANIFEST_BINDINGS_OFFSET 48
#define AE_MANIFEST_IMAGES_OFFSET 304
#define AE_MANIFEST_IMAGE_BYTES 288
#define AE_MANIFEST_IMAGES 16
#define AE_MANIFEST_ARGV_OFFSET 4912
#define AE_MANIFEST_ARGV_SLOTS 8
#define AE_MANIFEST_STRING_BYTES 256
#define AE_MANIFEST_FDS_OFFSET 6960
#define AE_MANIFEST_FD_COUNT 5
#define AE_MANIFEST_FD_BYTES 32
#define AE_MANIFEST_END_OFFSET 7120
#define AE_GRANT_MAGIC 1095067441
#define AE_GRANT_BYTES 256
#define AE_BOOT_MANIFEST_FD 3
#define AE_BOOT_GRANT_FD 4
#define AE_BOOT_PARENT_FD 5
#define AE_BOOT_LEASE_FD 6
#define AE_BOOT_JOURNAL_FD 7
#define AE_BOOT_CHANNEL_FD 8
#define AE_BOOT_INPUT_FD 9
#define AE_BOOT_ROUTE_FD 10
#define AE_IMAGE_HELPER 0
#define AE_IMAGE_SANDBOX 1
#define AE_IMAGE_PROVIDER 2
#define AE_IMAGE_HOST 3
#define AE_IMAGE_PROFILE 4
#define AE_IMAGE_FIRST_LOADER 5
#define AE_MANIFEST_BINDINGS 8
/* Bindings, in order: operation, attempt, Host boot, Host generation, route,
 * frozen retained consumer set, policy qualification, allowed image chain.
 * The last two identify root-reviewed qualification evidence, not booleans. */
typedef struct {
  char path[AE_MANIFEST_STRING_BYTES];
  uint8_t digest[AE_DIGEST_BYTES];
} ae_manifest_image;
typedef struct {
  uint32_t host_uid, host_gid, uid, gid, image_count, argc, term_ms, run_ms;
  uint8_t bindings[AE_MANIFEST_BINDINGS][AE_DIGEST_BYTES];
  ae_manifest_image images[AE_MANIFEST_IMAGES];
  uint64_t fd_devices[AE_MANIFEST_FD_COUNT], fd_inodes[AE_MANIFEST_FD_COUNT];
  char argv[AE_MANIFEST_ARGV_SLOTS][AE_MANIFEST_STRING_BYTES];
} ae_manifest;
typedef struct {
  uint32_t uid_first, uid_last, gid_first, gid_last;
  uint8_t manifest_digest[AE_DIGEST_BYTES];
  uint8_t qualification[AE_DIGEST_BYTES], isolation[AE_DIGEST_BYTES];
} ae_grant;
int ae_manifest_decode(const uint8_t *, size_t, ae_manifest *);
int ae_grant_decode(const uint8_t *, size_t, ae_grant *);
int ae_manifest_in_range(const ae_manifest *, const ae_grant *);
#define AE_PHASE_EMPTY 0
#define AE_PHASE_RESERVED 1
#define AE_PHASE_STAGED 2
#define AE_PHASE_START_CONSUMED 3
#define AE_PHASE_CHILD_OWNED 4
#define AE_PHASE_EXIT_PROVED 5
#define AE_PHASE_NO_START 6
#define AE_PHASE_DISPOSED 7
#define AE_PHASE_RELEASED 8
#define AE_PHASE_QUARANTINED 9
#define AE_WORKSPACE_ACTIVE 0
#define AE_WORKSPACE_FROZEN 1
#define AE_WORKSPACE_CLEANING 2
#define AE_WORKSPACE_CLOSED 3
#define AE_RESULT_REFUSED 0
#define AE_RESULT_ACCEPTED 1
#define AE_RESULT_EFFECT_REQUIRED 2
#define AE_RESULT_UNKNOWN 3
#define AE_FLAG_PREEXEC 1
#define AE_FLAG_REAPED 2
#define AE_FLAG_STREAMS 4
#define AE_FLAG_CUTOFF 8
#define AE_FLAG_PROVIDER 16
/* Native events have one fixed header followed by exactly payload_length
 * bytes. There is no arbitrary reader, receipt issuer or guardian-exit event. */
#define AE_EVENT_MAGIC 1095058737
#define AE_EVENT_BYTES 288
#define AE_EVENT_STATUS 1
#define AE_EVENT_PREEXEC 2
#define AE_EVENT_IMAGE 3
#define AE_EVENT_EXIT 4
#define AE_EVENT_STREAMS 5
#define AE_EVENT_ARTIFACT 6
#define AE_EVENT_STDOUT 7
#define AE_EVENT_STDERR 8
#define AE_EVENT_REFUSED 9
#define AE_EVENT_HELLO 10
#define AE_HELLO_BYTES 8232
#define AE_EVENT_RELEASED 11
#define AE_CLOSED_RECORD_BYTES 192
#define AE_RECORD_MAGIC "ae-owner-intent-v1"
#define AE_RECORD_MAGIC_BYTES 18
#define AE_RECORD_BINDING_OFFSET 24
#define AE_RECORD_LAUNCH_OFFSET 56
#define AE_RECORD_PHASE_OFFSET 88
#define AE_RECORD_WORKSPACE_OFFSET 92
#define AE_RECORD_SEQUENCE_OFFSET 96
#define AE_RECORD_SETTLEMENTS_OFFSET 100
#define AE_RECORD_WORKSPACE_DEVICE_OFFSET 104
#define AE_RECORD_WORKSPACE_INODE_OFFSET 112
#define AE_RECORD_CUTOFF_OFFSET 120
#define AE_RECORD_STREAMS_OFFSET 124
#define AE_RECORD_REAPED_OFFSET 128
#define AE_RECORD_PREEXEC_OFFSET 132
#define AE_RECORD_EXIT_CODE_OFFSET 136
#define AE_RECORD_EXIT_SIGNAL_OFFSET 140
#define AE_RECORD_REVISION_OFFSET 144
#define AE_RECORD_PENDING_OFFSET 148
#define AE_RECORD_ARGUMENT_OFFSET 152
#define AE_RECORD_BIRTH_ATTEMPTED_OFFSET 156
#define AE_RECORD_HASH_OFFSET 160

#define AE_READBACK_GRANT_MAGIC 1095062065
#define AE_READBACK_GRANT_BYTES 256
#define AE_EVENT_PHASE_OFFSET 80
#define AE_EVENT_WORKSPACE_OFFSET 84
#define AE_EVENT_FLAGS_OFFSET 88
#define AE_EVENT_EXIT_CODE_OFFSET 92
#define AE_EVENT_EXIT_SIGNAL_OFFSET 96
#define AE_EVENT_LENGTH_OFFSET 100
#define AE_EVENT_OWNER_OFFSET 104
#define AE_EVENT_CHILD_OFFSET 152
#define AE_EVENT_SLOT_OFFSET 200
#define AE_EVENT_MODE_OFFSET 204
#define AE_EVENT_DEVICE_OFFSET 208
#define AE_EVENT_INODE_OFFSET 216
#define AE_EVENT_WORKSPACE_DEVICE_OFFSET 224
#define AE_EVENT_WORKSPACE_INODE_OFFSET 232
#define AE_EVENT_SERIAL_OFFSET 240
#define AE_EVENT_COMMAND_OFFSET 244
#define AE_EVENT_RESULT_OFFSET 248
#define AE_EVENT_REVISION_OFFSET 252
#define AE_EVENT_ATTESTATION_OFFSET 256
#define AE_STREAM_CHUNK_BYTES 16384
#define AE_STREAM_MAX_BYTES 8388608
#define AE_INPUT_MAX_BYTES 1048576
#define AE_PREEXEC_BYTES 64
#define AE_PREEXEC_MANIFEST_FD 4
#define AE_PREEXEC_ACK_FD 5
#define AE_PREEXEC_GATE_FD 6
#define AE_PROVIDER_ROUTE_FD 3
typedef struct {
  uint32_t kind, sequence, argument;
  uint8_t binding[AE_DIGEST_BYTES], launch[AE_DIGEST_BYTES];
} ae_request;
int ae_decode(const uint8_t *, size_t, ae_request *);
#endif
