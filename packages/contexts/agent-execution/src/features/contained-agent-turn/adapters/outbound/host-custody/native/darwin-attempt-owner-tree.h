#ifndef AE_DARWIN_ATTEMPT_OWNER_TREE_H
#define AE_DARWIN_ATTEMPT_OWNER_TREE_H
#include <stddef.h>
#include <stdint.h>
/* Internal native transaction, never a caller-selectable root command. The
 * custody owner supplies its retained original FD before admitting a writer.
 * Any rejected/partial operation burns the transaction. No reset or replay. */
#define AE_TREE_ENTRIES 4096
#define AE_TREE_DEPTH 32
#define AE_TREE_FILE_BYTES 8388608
#define AE_TREE_TOTAL_BYTES 33554432
#define AE_TREE_CHUNK_BYTES 16384
#define AE_TREE_ROOT UINT32_MAX
typedef struct ae_tree_transaction ae_tree_transaction;
typedef struct {
  uint32_t depth, entries, file_bytes, total_bytes;
} ae_tree_limits;
ae_tree_transaction *ae_tree_begin(int, const ae_tree_limits *);
int ae_tree_entry(ae_tree_transaction *, uint32_t, uint32_t, const char *, int, uint32_t, uint32_t);
int ae_tree_chunk(ae_tree_transaction *, uint32_t, uint32_t, const uint8_t *, size_t);
int ae_tree_finish(ae_tree_transaction *);
/* Closes every retained descriptor, reports close uncertainty, frees memory.
 * Does not remove any entries or the original root. */
int ae_tree_dispose(ae_tree_transaction *);
/* Complete observed data stream. Only native custody supplies root and the
 * output transport; callbacks consume data and never establish authority.
 * begin/entry/chunk/end are implicit in this finite traversal: a successful
 * return is the sole completion indication, after all observation/close checks.
 * A caller MUST NOT publish partial data or retry after a failed observation. */
typedef struct {
  uint32_t ordinal, parent, mode, size;
  uint64_t device, inode;
  int directory;
  const char *name;
} ae_tree_observed_entry;
typedef int (*ae_tree_emit_entry)(void *, const ae_tree_observed_entry *);
typedef int (*ae_tree_emit_chunk)(void *, uint32_t, uint32_t, const uint8_t *, size_t);
int ae_tree_observe(int, const ae_tree_limits *, ae_tree_emit_entry, ae_tree_emit_chunk, void *);
#endif
