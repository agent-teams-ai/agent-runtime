#include "darwin-attempt-owner-state.h"
#include <string.h>
#include <limits.h>
static uint32_t u32(const uint8_t *p) {
  return ((uint32_t)p[0]<<24)|((uint32_t)p[1]<<16)|((uint32_t)p[2]<<8)|p[3];
}
int ae_decode(const uint8_t *b, size_t n, ae_request *r) {
  if (!b || !r || n != AE_FRAME_BYTES || u32(b+AE_MAGIC_OFFSET)!=AE_MAGIC ||
      u32(b+AE_VERSION_OFFSET)!=AE_VERSION) return 0;
  uint32_t kind=u32(b+AE_KIND_OFFSET), arg=u32(b+AE_ARGUMENT_OFFSET);
  if (kind<AE_START_ONCE || kind>AE_READ_CLOSED_WORKSPACE ||
      u32(b+AE_SEQUENCE_OFFSET)==0) return 0;
  if (kind==AE_READ_ARTIFACT_SLOT ? arg>=AE_ARTIFACT_SLOTS : arg!=0) return 0;
  for (size_t i=AE_ARGUMENT_OFFSET+4; i<AE_FRAME_BYTES; i++) if (b[i]) return 0;
  memset(r,0,sizeof(*r));
  r->kind=kind; r->sequence=u32(b+AE_SEQUENCE_OFFSET); r->argument=arg;
  memcpy(r->binding,b+AE_BINDING_OFFSET,AE_DIGEST_BYTES);
  memcpy(r->launch,b+AE_LAUNCH_OFFSET,AE_DIGEST_BYTES);
  return 1;
}
void ae_init(ae_state *s, const uint8_t *binding, const uint8_t *launch) {
  memset(s,0,sizeof(*s)); memcpy(s->binding,binding,32); memcpy(s->launch,launch,32);
  s->exit_code=-1; s->exit_signal=0;
}
ae_result ae_commit(ae_state *s, const ae_state *next, ae_persist save, void *ctx) {
  if (s->phase==AE_QUARANTINED) return AE_UNKNOWN;
  ae_state committed=*next;
  if (s->revision==UINT32_MAX) { s->phase=AE_QUARANTINED; s->cutoff=1; return AE_UNKNOWN; }
  committed.revision=s->revision+1;
  if (!save || !save(ctx,&committed)) {
    /* Persistence may have happened: neither retry nor the old state is safe. */
    s->phase=AE_QUARANTINED; s->cutoff=1; return AE_UNKNOWN;
  }
  *s=committed; return AE_ACCEPTED;
}
int ae_writer_stopped(const ae_state *s) {
  return s->phase==AE_NO_START || (s->phase==AE_EXIT_PROVED && s->reaped && s->streams_sealed);
}
int ae_may_signal(const ae_state *s) {
  return s->phase==AE_CHILD_OWNED && !s->reaped;
}
int ae_identity_reusable(const ae_state *s) { (void)s; return 0; }
ae_result ae_begin_birth(ae_state *s, ae_persist save, void *ctx) {
  if (s->phase==AE_QUARANTINED) return AE_UNKNOWN;
  if (s->phase!=AE_START_CONSUMED || s->pending_effect!=AE_START_ONCE ||
      s->cutoff || s->birth_attempted) return AE_REFUSED;
  ae_state next=*s;
  next.birth_attempted=1;
  return ae_commit(s,&next,save,ctx);
}
ae_result ae_channel_lost(ae_state *s, ae_persist save, void *ctx) {
  if (s->phase==AE_QUARANTINED) return AE_UNKNOWN;
  ae_state next=*s;
  next.cutoff=1; next.phase=AE_QUARANTINED;
  /* Even successful durable publication records uncertainty, not settlement.
   * Native direct-child wait/stop custody must survive this protocol state;
   * this function does not claim to kill, reap, seal streams or close handles. */
  (void)ae_commit(s,&next,save,ctx);
  return AE_UNKNOWN;
}
ae_result ae_command(ae_state *s, const ae_request *r, ae_persist save, void *ctx) {
  if (s->phase==AE_QUARANTINED) return AE_UNKNOWN;
  if (s->has_last_request && r->sequence==s->sequence &&
      r->kind==s->last_request.kind && r->argument==s->last_request.argument &&
      !memcmp(r->binding,s->last_request.binding,32) && !memcmp(r->launch,s->last_request.launch,32) &&
      (r->kind==AE_CUTOFF || r->kind==AE_SETTLE_LAUNCH_ROUTE ||
       r->kind==AE_SETTLE_ARTIFACT_RESULT || r->kind==AE_SETTLE_WORKSPACE || r->kind==AE_SETTLE_PRIVATE))
    return AE_ACCEPTED; /* Informational duplicate; no persistence or new proof. */
  if (memcmp(s->binding,r->binding,32) || memcmp(s->launch,r->launch,32) ||
      s->sequence==UINT32_MAX || r->sequence!=s->sequence+1) return AE_REFUSED;
  if (s->pending_effect && r->kind!=AE_CUTOFF && r->kind!=AE_READ_STATUS) return AE_REFUSED;
  ae_state next=*s;
  next.sequence=r->sequence;
  next.last_request=*r; next.has_last_request=1;
  switch(r->kind) {
    case AE_START_ONCE:
      if (s->phase!=AE_STAGED || s->cutoff) return AE_REFUSED;
      next.phase=AE_START_CONSUMED; next.pending_effect=r->kind; break;
    case AE_CUTOFF:
      next.cutoff=1;
      if (s->phase==AE_RESERVED || s->phase==AE_STAGED) next.phase=AE_NO_START;
      break;
    case AE_READ_STATUS: break;
    case AE_SETTLE_LAUNCH_ROUTE:
      if (!ae_writer_stopped(s)) return AE_REFUSED;
      next.settlements|=1; break;
    case AE_SETTLE_ARTIFACT_RESULT:
      if (!ae_writer_stopped(s) || s->workspace!=AE_FROZEN) return AE_REFUSED;
      next.settlements|=2; break;
    case AE_SETTLE_WORKSPACE:
      if (!ae_writer_stopped(s) || s->workspace!=AE_CLOSED || !(s->settlements&2)) return AE_REFUSED;
      next.settlements|=4; break;
    case AE_SETTLE_PRIVATE:
      if (!ae_writer_stopped(s)) return AE_REFUSED;
      next.settlements|=8; break;
    case AE_WORKSPACE_FREEZE:
      if (!ae_writer_stopped(s) || s->workspace!=AE_ACTIVE) return AE_REFUSED;
      next.pending_effect=r->kind; break;
    case AE_WORKSPACE_CLEANUP:
      if (!ae_writer_stopped(s) || s->workspace!=AE_FROZEN || !(s->settlements&2)) return AE_REFUSED;
      next.pending_effect=r->kind; break;
    case AE_WORKSPACE_CLOSE:
      if (!ae_writer_stopped(s) || s->workspace!=AE_CLEANUP) return AE_REFUSED;
      next.pending_effect=r->kind; break;
    case AE_READ_ARTIFACT_SLOT:
      if (!ae_writer_stopped(s) || s->workspace!=AE_FROZEN || r->argument>=AE_ARTIFACT_SLOTS) return AE_REFUSED;
      next.pending_effect=r->kind; next.pending_argument=r->argument; break;
    case AE_READ_CLOSED_WORKSPACE:
      if (s->workspace!=AE_CLOSED || s->phase!=AE_RELEASED) return AE_REFUSED;
      return AE_EFFECT_REQUIRED; /* Readback never writes or advances state. */
    case AE_DISPOSE_ONCE:
      if (!ae_writer_stopped(s) || !s->streams_sealed ||
          s->settlements!=15 || s->workspace!=AE_CLOSED) return AE_REFUSED;
      next.pending_effect=r->kind; break;
    default: return AE_REFUSED;
  }
  ae_result result=ae_commit(s,&next,save,ctx);
  if (result!=AE_ACCEPTED) return result;
  /* These are requests for native work, NEVER acknowledgments of that work. */
  if (r->kind==AE_START_ONCE || r->kind==AE_WORKSPACE_FREEZE ||
      r->kind==AE_WORKSPACE_CLEANUP || r->kind==AE_WORKSPACE_CLOSE ||
      r->kind==AE_DISPOSE_ONCE || r->kind==AE_READ_ARTIFACT_SLOT ||
      r->kind==AE_READ_CLOSED_WORKSPACE) return AE_EFFECT_REQUIRED;
  return AE_ACCEPTED;
}

ae_result ae_birth_observed(ae_state *s,ae_persist save,void *ctx) {
  if (s->phase!=AE_START_CONSUMED || !s->birth_attempted ||
      s->pending_effect!=AE_START_ONCE || s->reaped) return AE_REFUSED;
  ae_state next=*s; next.phase=AE_CHILD_OWNED; next.pending_effect=0;
  return ae_commit(s,&next,save,ctx);
}
ae_result ae_preexec_observed(ae_state *s,ae_persist save,void *ctx) {
  if (s->phase!=AE_CHILD_OWNED || s->reaped || s->preexec_applied || s->cutoff) return AE_REFUSED;
  ae_state next=*s; next.preexec_applied=1;
  return ae_commit(s,&next,save,ctx);
}
ae_result ae_wait_observed(ae_state *s,int code,int signal,ae_persist save,void *ctx) {
  if (s->phase!=AE_CHILD_OWNED || s->reaped ||
      !((code>=0 && code<=255 && signal==0) || (code==-1 && signal>0 && signal<128))) return AE_REFUSED;
  ae_state next=*s; next.reaped=1; next.exit_code=code; next.exit_signal=signal;
  next.phase=AE_EXIT_PROVED;
  return ae_commit(s,&next,save,ctx);
}
ae_result ae_streams_observed(ae_state *s,ae_persist save,void *ctx) {
  if (s->streams_sealed || !((s->phase==AE_EXIT_PROVED && s->reaped) ||
      (s->phase==AE_NO_START && !s->birth_attempted && !s->reaped))) return AE_REFUSED;
  ae_state next=*s; next.streams_sealed=1;
  return ae_commit(s,&next,save,ctx);
}
