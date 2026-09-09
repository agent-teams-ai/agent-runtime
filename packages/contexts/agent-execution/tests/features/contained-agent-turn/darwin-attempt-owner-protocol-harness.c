#include "darwin-attempt-owner-state.h"
#include "vectors.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

typedef struct { unsigned writes; int fail; ae_state saved; } storage;
static int persist(void *p,const ae_state *s) {
  storage *store=p; store->writes++; store->saved=*s; return !store->fail;
}
static ae_request request(const ae_state *s,uint32_t kind) {
  ae_request r={0}; r.kind=kind; r.sequence=s->sequence+1;
  memcpy(r.binding,s->binding,32); memcpy(r.launch,s->launch,32); return r;
}
static ae_result command(ae_state *s, uint32_t kind,storage *store) {
  ae_request r=request(s,kind); return ae_command(s,&r,persist,store);
}
static void frames(void) {
  ae_request r;
  for (unsigned i=0;i<sizeof(vectors)/sizeof(vectors[0]);i++) {
    assert(ae_decode(vectors[i],AE_FRAME_BYTES,&r));
    assert(r.kind==i+1 && r.sequence==1);
    for (size_t n=0;n<AE_FRAME_BYTES;n++) assert(!ae_decode(vectors[i],n,&r));
  }
  unsigned char b[AE_FRAME_BYTES+1]; memcpy(b,vectors[0],AE_FRAME_BYTES);
  assert(!ae_decode(b,sizeof(b),&r));
  for (unsigned i=0;i<AE_FRAME_BYTES;i++) {
    memcpy(b,vectors[0],AE_FRAME_BYTES); b[i]^=128;
    if (i<12 || i>=AE_ARGUMENT_OFFSET) assert(!ae_decode(b,AE_FRAME_BYTES,&r));
  }
  memcpy(b,vectors[0],AE_FRAME_BYTES); memset(b+AE_SEQUENCE_OFFSET,0,4);
  assert(!ae_decode(b,AE_FRAME_BYTES,&r));
  memcpy(b,vectors[0],AE_FRAME_BYTES); b[AE_KIND_OFFSET+3]=255;
  assert(!ae_decode(b,AE_FRAME_BYTES,&r));
  puts("C: exact TS vectors, all partial lengths, oversize/header/kind/reserved/argument rejection");
}
static void lifecycle(void) {
  uint8_t binding[32]={1},launch[32]={2};
  ae_state s; storage store={0}; ae_init(&s,binding,launch);
  assert(command(&s,AE_START_ONCE,&store)==AE_REFUSED && store.writes==0);
  /* Synthetic native effects only. These assignments are NOT authority evidence. */
  ae_state next=s; next.phase=AE_RESERVED;
  assert(ae_commit(&s,&next,persist,&store)==AE_ACCEPTED);
  next=s; next.phase=AE_STAGED;
  assert(ae_commit(&s,&next,persist,&store)==AE_ACCEPTED);
  assert(command(&s,AE_START_ONCE,&store)==AE_EFFECT_REQUIRED);
  assert(s.phase==AE_START_CONSUMED && store.saved.phase==AE_START_CONSUMED);
  assert(command(&s,AE_START_ONCE,&store)==AE_REFUSED);
  assert(!ae_writer_stopped(&s));
  assert(ae_begin_birth(&s,persist,&store)==AE_ACCEPTED && store.saved.birth_attempted);
  assert(ae_begin_birth(&s,persist,&store)==AE_REFUSED);
  next=s; next.phase=AE_CHILD_OWNED; next.pending_effect=0;
  assert(ae_commit(&s,&next,persist,&store)==AE_ACCEPTED);
  assert(ae_may_signal(&s));
  assert(command(&s,AE_READ_ARTIFACT_SLOT,&store)==AE_REFUSED);
  assert(command(&s,AE_DISPOSE_ONCE,&store)==AE_REFUSED);
  assert(command(&s,AE_SETTLE_PRIVATE,&store)==AE_REFUSED);
  next=s; next.phase=AE_EXIT_PROVED; next.reaped=1; next.exit_code=17;
  assert(ae_commit(&s,&next,persist,&store)==AE_ACCEPTED);
  assert(!ae_may_signal(&s) && !ae_writer_stopped(&s));
  next=s; next.streams_sealed=1;
  assert(ae_commit(&s,&next,persist,&store)==AE_ACCEPTED);
  assert(ae_writer_stopped(&s) && s.exit_code==17 && s.exit_signal==0);
  /* Physical stage has no artifact/workspace settlement prerequisite. */
  assert(s.settlements==0);
  assert(command(&s,AE_WORKSPACE_FREEZE,&store)==AE_EFFECT_REQUIRED);
  assert(s.workspace==AE_ACTIVE); /* Command is not a fictional rename ack. */
  next=s; next.workspace=AE_FROZEN; next.pending_effect=0;
  assert(ae_commit(&s,&next,persist,&store)==AE_ACCEPTED);
  assert(command(&s,AE_READ_ARTIFACT_SLOT,&store)==AE_EFFECT_REQUIRED);
  next=s; next.pending_effect=0;
  assert(ae_commit(&s,&next,persist,&store)==AE_ACCEPTED);
  assert(command(&s,AE_WORKSPACE_CLEANUP,&store)==AE_REFUSED);
  assert(command(&s,AE_SETTLE_ARTIFACT_RESULT,&store)==AE_ACCEPTED);
  unsigned writes=store.writes;
  assert(ae_command(&s,&s.last_request,persist,&store)==AE_ACCEPTED && writes==store.writes);
  assert(command(&s,AE_WORKSPACE_CLEANUP,&store)==AE_EFFECT_REQUIRED);
  next=s; next.workspace=AE_CLEANUP; next.pending_effect=0;
  assert(ae_commit(&s,&next,persist,&store)==AE_ACCEPTED);
  assert(command(&s,AE_WORKSPACE_CLOSE,&store)==AE_EFFECT_REQUIRED);
  next=s; next.workspace=AE_CLOSED; next.pending_effect=0;
  assert(ae_commit(&s,&next,persist,&store)==AE_ACCEPTED);
  assert(command(&s,AE_SETTLE_WORKSPACE,&store)==AE_ACCEPTED);
  assert(command(&s,AE_DISPOSE_ONCE,&store)==AE_REFUSED);
  assert(command(&s,AE_SETTLE_LAUNCH_ROUTE,&store)==AE_ACCEPTED);
  assert(command(&s,AE_SETTLE_PRIVATE,&store)==AE_ACCEPTED);
  assert(command(&s,AE_DISPOSE_ONCE,&store)==AE_EFFECT_REQUIRED);
  assert(s.phase==AE_EXIT_PROVED && s.workspace==AE_CLOSED);
  assert(command(&s,AE_READ_CLOSED_WORKSPACE,&store)==AE_REFUSED);
  next=s; next.phase=AE_RELEASED; next.pending_effect=0;
  assert(ae_commit(&s,&next,persist,&store)==AE_ACCEPTED);
  writes=store.writes;
  assert(command(&s,AE_READ_CLOSED_WORKSPACE,&store)==AE_EFFECT_REQUIRED && store.writes==writes);
  assert(!ae_identity_reusable(&s));
  puts("C: separate writer/streams/helper, finite settlements, no artifact cycle, retained workspace effects");
}
static void faults(void) {
  uint8_t binding[32]={1},launch[32]={2};
  for (int phase=AE_EMPTY;phase<=AE_RELEASED;phase++) {
    ae_state s; storage store={0}; ae_init(&s,binding,launch); s.phase=(ae_phase)phase;
    assert(!ae_identity_reusable(&s));
    ae_state next=s; store.fail=1;
    assert(ae_commit(&s,&next,persist,&store)==AE_UNKNOWN && s.phase==AE_QUARANTINED);
    unsigned writes=store.writes;
    assert(command(&s,AE_START_ONCE,&store)==AE_UNKNOWN && writes==store.writes);
    assert(!ae_identity_reusable(&s));
  }
  ae_state s; storage store={0}; ae_init(&s,binding,launch); s.phase=AE_STAGED;
  ae_request wrong=request(&s,AE_START_ONCE); wrong.binding[0]++;
  assert(ae_command(&s,&wrong,persist,&store)==AE_REFUSED);
  wrong=request(&s,AE_START_ONCE); wrong.launch[0]++;
  assert(ae_command(&s,&wrong,persist,&store)==AE_REFUSED);
  wrong=request(&s,AE_START_ONCE); wrong.sequence++;
  assert(ae_command(&s,&wrong,persist,&store)==AE_REFUSED && store.writes==0);
  assert(command(&s,AE_CUTOFF,&store)==AE_ACCEPTED && s.phase==AE_NO_START && s.cutoff);
  assert(command(&s,AE_START_ONCE,&store)==AE_REFUSED && !s.reaped);
  assert(ae_writer_stopped(&s) && !ae_may_signal(&s));
  ae_request repeated=s.last_request;
  unsigned writes=store.writes;
  assert(ae_command(&s,&repeated,persist,&store)==AE_ACCEPTED && writes==store.writes);
  repeated.launch[0]++;
  assert(ae_command(&s,&repeated,persist,&store)==AE_REFUSED);
  ae_init(&s,binding,launch); s.phase=AE_STAGED;
  assert(command(&s,AE_START_ONCE,&store)==AE_EFFECT_REQUIRED);
  assert(command(&s,AE_CUTOFF,&store)==AE_ACCEPTED && s.phase==AE_START_CONSUMED);
  assert(ae_begin_birth(&s,persist,&store)==AE_REFUSED && !s.birth_attempted);
  assert(!ae_writer_stopped(&s)); /* Post-intent ambiguity cannot become no-start. */
  assert(command(&s,AE_START_ONCE,&store)==AE_REFUSED);
  s.revision=UINT32_MAX;
  assert(command(&s,AE_READ_STATUS,&store)==AE_UNKNOWN);
  puts("C: every-phase persistence fault quarantines, no UID/GID reuse, foreign binding/sequence, cutoff ordering");
}
static void pending_effects(void) {
  uint8_t binding[32]={1},launch[32]={2};
  ae_state s; storage store={0}; ae_init(&s,binding,launch);
  s.phase=AE_EXIT_PROVED; s.reaped=1; s.streams_sealed=1; s.workspace=AE_FROZEN;
  ae_request r=request(&s,AE_READ_ARTIFACT_SLOT); r.argument=1;
  assert(ae_command(&s,&r,persist,&store)==AE_EFFECT_REQUIRED);
  assert(s.pending_argument==1 && store.saved.pending_argument==1);
  assert(command(&s,AE_READ_STATUS,&store)==AE_ACCEPTED);
  assert(s.last_request.argument==0 && s.pending_argument==1);
  assert(command(&s,AE_CUTOFF,&store)==AE_ACCEPTED);
  assert(s.pending_effect==AE_READ_ARTIFACT_SLOT && s.pending_argument==1);
  assert(command(&s,AE_READ_ARTIFACT_SLOT,&store)==AE_REFUSED);
  ae_init(&s,binding,launch); s.phase=AE_STAGED;
  assert(command(&s,AE_START_ONCE,&store)==AE_EFFECT_REQUIRED);
  store.fail=1;
  assert(ae_begin_birth(&s,persist,&store)==AE_UNKNOWN);
  assert(s.phase==AE_QUARANTINED && s.cutoff && store.saved.birth_attempted);
  unsigned writes=store.writes;
  assert(ae_begin_birth(&s,persist,&store)==AE_UNKNOWN && writes==store.writes);
  puts("C: pending slot survives status/cutoff; birth claim durable, single-use and failure-quarantined");
}
static void channel_and_no_start(void) {
  uint8_t binding[32]={1},launch[32]={2};
  for (int phase=AE_EMPTY;phase<=AE_RELEASED;phase++) {
    for (int fail=0;fail<=1;fail++) {
      ae_state s; storage store={0}; ae_init(&s,binding,launch);
      s.phase=(ae_phase)phase; store.fail=fail;
      assert(ae_channel_lost(&s,persist,&store)==AE_UNKNOWN);
      assert(s.phase==AE_QUARANTINED && s.cutoff && !s.reaped && !s.streams_sealed);
      assert(store.saved.phase==AE_QUARANTINED && store.saved.cutoff);
      unsigned writes=store.writes;
      assert(ae_channel_lost(&s,persist,&store)==AE_UNKNOWN && writes==store.writes);
      assert(command(&s,AE_START_ONCE,&store)==AE_UNKNOWN);
      assert(command(&s,AE_SETTLE_PRIVATE,&store)==AE_UNKNOWN);
      assert(command(&s,AE_DISPOSE_ONCE,&store)==AE_UNKNOWN);
      assert(!ae_identity_reusable(&s));
    }
  }
  ae_state s; storage store={0}; ae_init(&s,binding,launch); s.phase=AE_STAGED;
  assert(command(&s,AE_CUTOFF,&store)==AE_ACCEPTED && s.phase==AE_NO_START);
  /* Synthetic later owner completion cannot replace native stream closure. */
  s.workspace=AE_CLOSED; s.settlements=15;
  assert(ae_writer_stopped(&s) && !s.reaped && !s.streams_sealed);
  assert(command(&s,AE_DISPOSE_ONCE,&store)==AE_REFUSED);
  ae_state next=s; next.streams_sealed=1;
  assert(ae_commit(&s,&next,persist,&store)==AE_ACCEPTED);
  assert(command(&s,AE_DISPOSE_ONCE,&store)==AE_EFFECT_REQUIRED && !s.reaped);
  puts("C: channel loss quarantines every phase without fictional exit; no-start still requires native stream closure");
}
int main(void) { frames(); lifecycle(); faults(); pending_effects(); channel_and_no_start(); return 0; }
