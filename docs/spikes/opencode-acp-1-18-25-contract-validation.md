---
id: evidence.opencode-acp-1-18-25-contract-validation
type: evidence
status: evidence-reference
owner: architecture/qualification
summary: Records deterministic OpenCode ACP 1.18.25 contract validation and deferred production gaps.
related:
  - ADR-0001
  - ADR-0010
  - runtime.architecture.opencode-integration
  - runtime.architecture.contained-agent-turn-v1-delivery-plan
---

# OpenCode ACP 1.18.25 contract validation

## Scope and authority

This evidence closes only the plan-authorized OpenCode contract-validation lane
at base `40ddaedd0da009a6611988e3a8e9eb00857b05be`. It does not create or qualify a
production OpenCode adapter. ADR-0001, ADR-0010, and the accepted OpenCode
integration architecture remain authoritative if this evidence conflicts with
them.

The retained implementation is an experiment under
`experiments/runtime-profile-behavior`. Its generic wire seam knows only
newline-delimited JSON-RPC/ACP messages, request IDs, timeouts, and typed
transport/protocol errors. OpenCode session, capability, permission, tool,
cancellation, and reconciliation interpretation stays in OpenCode-specific
validation code. Neither layer imports Contained Agent Turn domain or provider
port types, and no second operation oracle or TCK is introduced.

No network, credential, provider process, user project, or dependency install
was used for this validation. The fixtures are deterministic contract cases,
not captured OpenCode transcripts. They validate the seam against the supplied
contract shape and adversarial inputs; they do not independently prove that
OpenCode emits every represented result.

## Frozen ACP contract cases

The fixture set in
`experiments/runtime-profile-behavior/fixtures/acp-compatibility/` records these
contract cases:

| Case | Frozen validation input | Validation disposition |
| --- | --- | --- |
| initialize | an OpenCode `1.18.25` initialize result selects ACP protocol version `1` | accept only the explicitly supported version |
| v2 request | a version `2` initialize case negotiates version `1` | select the v1 validation path; do not infer v2 behavior |
| `session/new` | successful result carries an opaque `sessionId` | sufficient for a fresh-session routing observation only |
| `session/list` | successful result carries session observations | never treat listing or possession of an ID as authorization |
| `session/resume` | successful result is retained | resume continuity and ownership remain Agent Execution concerns |
| `session/close` | successful result is retained | RPC success is not process-custody or terminal-operation proof |
| unknown capability | unknown names remain visible in sorted validation output | no silent drop and no inferred support |
| unsupported capability | a false or absent result stays unsupported | typed refusal; no native or CLI fallback |
| malformed line/envelope | invalid JSON and invalid JSON-RPC are distinct protocol errors | reject without disturbing unrelated request correlation |
| duplicate/late response | duplicate completed IDs and never-pending IDs are distinct errors | retain as evidence; never reopen completed correlation state |
| permission callback | `session/request_permission` is not auto-approved | defer to runtime authority or return explicit cancellation |
| tool update | `session/update` with `tool_call` is an observation | no tool authority is inferred from the update |
| timeout | a pending request expires at its configured bound | typed `request_timeout`; outcome may require reconciliation |
| process exit | pending requests fail with exit code/signal evidence | typed `process_exit`; not provider rejection proof |
| cancel ambiguity | cancel RPC success with unknown provider acceptance and no terminal update | `ambiguous_requires_reconciliation`; no retry or fallback |

The generic seam provides framing across split chunks, initialize result
validation, capability/version negotiation, request correlation, a bounded
timeout, inbound request/notification routing, and typed errors. The replay
suite also proves a response arriving after timeout is classified rather than
accepted as the original request result.

## Request timeout

OpenCode validation reads `AR_OPENCODE_ACP_REQUEST_TIMEOUT_MS`. Its default is
`15000`; the inclusive allowed range is `1000..120000`. Missing and empty values
use the default. Non-integers and values outside the range fail closed with a
configuration error. The generic wire seam receives only the validated number
and therefore does not acquire an OpenCode environment contract.

## Neutral Contained Agent Turn gap map

| Neutral need | Exact OpenCode 1.18.25 observation supplied to this lane | Production gap/disposition |
| --- | --- | --- |
| provider activation and exact binding | exact binary SHA-256 and ACP v1 are supplied; no raw initialize response is retained here | binary custody, adapter revision binding, credential binding, and capability-manifest activation are deferred |
| fresh contained turn | one real `opencode/big-pickle` fixed prompt produced the exact marker and digest in an empty sandbox | no production dispatch adapter, containment receipt, or effect acceptance projection exists |
| streaming output | only the final output marker and digest are supplied; no exact update sequence is retained | canonical cursoring, size limits, drain barrier, late-output policy, and durable publication are deferred |
| permissions and tools | no permission or tool request occurred in the one supplied run | this absence does not qualify callback behavior; runtime enforcement and durable interaction state are deferred |
| cancellation | no live cancellation observation was supplied; only the ambiguity policy fixture exists | ambiguous cancellation must enter reconciliation; blind retry and fallback remain prohibited |
| session continuity | no raw 1.18.25 new/list/resume/close transcript was supplied; result-shape fixtures validate only translation | tenant/session/workspace authorization, continuity, and binding revision checks remain unqualified |
| timeout and transport failure | no live timeout or exit was supplied; deterministic seam cases distinguish them | durable acceptance, effect resolution, custody closure, and recovery are deferred |
| terminal outcome | the supplied prompt produced the fixed output; no complete drain trace or terminal receipt exists | ACP completion is not canonical output, a drain barrier, or a ContainmentExecutionReceipt |
| reconciliation | no native 1.18.25 history/status reconciliation result was supplied | native OpenCode observation and exact reconciliation are explicitly deferred |
| unsupported behavior | no live unknown/unsupported capability response was supplied; adversarial fixtures preserve exact input truth | no emulation, CLI fallback, native mutation fallback, or second command writer is authorized |

The current production Contained Agent Turn contract does not advertise
OpenCode as a provider. This validation does not change that contract. A later
production slice must propose any neutral contract change to its owning lane and
qualify it against the sole operation oracle before composition.

## Separately supplied hosted characterization

A separately supplied hosted live result is recorded without replaying or
independently verifying it here:

- OpenCode `1.18.25`, SHA-256
  `d91e0d33676d0839f7cde87924cd4127ea88c9d6784eea9f009a7d08bdc60eeb`;
- ACP v1 over stdio;
- real `opencode/big-pickle` route;
- fixed prompt output `runtime-profile-acp-ok`, output SHA-256
  `dc5d87f627deedda40c795c8435536e04764761fee5dbe2fb29e7e4e90484e74`;
- zero USD reported;
- no permission or tool request observed;
- disposable empty sandbox.

This is revision-scoped characterization only. It does not establish process
custody, filesystem or network containment, authorization, durable acceptance,
complete output drain, cancellation semantics, reconciliation, credential
handling, production composition, or general OpenCode qualification.

## Explicit deferrals

- production OpenCode ACP adapter and composition;
- native OpenCode observation and reconciliation;
- provider acceptance and effect-resolution projection;
- durable output cursoring, artifact sealing, and terminal receipt production;
- Host Custody, credential, workspace, egress, and descendant-process gates;
- runtime permission/tool enforcement and elicitation integration;
- behavior qualification beyond the one supplied hosted characterization;
- ACP v2 behavior beyond explicit negotiation to v1.

## Model-split metrics

This implementation lane used one implementation worker. Time to the first
patch was approximately 20 minutes from activation. The first executable test
run failed before test discovery because Node strip-only mode rejected a
TypeScript parameter property (0/9 cases executed); the first discovered run
passed 8/9 cases. Two implementation iterations were required before the
focused suite reached a stable pass. Eleven focused tests and ten fixtures were
added. No independent review defects were supplied in this lane; that metric
remains `not_measured`, not zero.

## Limitations

The deterministic fixtures validate translation and failure handling, not
provider implementation correctness. The hosted result was supplied out of
band and is intentionally not promoted into a containment claim. Exact
production behavior remains unqualified until the deferred adapter,
reconciliation, custody, security, persistence, and disposable E2E gates are
implemented and pass at an exact head.
