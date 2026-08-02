# OpenCode Integration

Status: accepted architectural direction as amended by ADR-0001, ADR-0002,
ADR-0003, and ADR-0004; detailed state machines remain ADRs.

## Decision

OpenCode is a broad provider integration, but it is not a bounded context and
must not become a single `OpenCodeAdapter`.

The integration has four independent planes:

1. ACP execution for sessions, input, cancellation, streaming, permissions,
   session configuration, attachments, and session-scoped MCP.
2. Native OpenCode management for installation, health, profiles,
   authentication, provider/model catalog, and configuration.
3. Native observation and reconciliation for status, history, child sessions,
   pending interactions, diffs, usage, and recovery.
4. Host platform capabilities for processes, filesystem, secrets, network, and
   platform-specific custody.

OpenCode-specific code translates between external OpenCode or ACP models and
provider-neutral application capabilities. It does not own runtime aggregates
or persist directly into domain tables.

## Package direction

```text
packages/providers/opencode/
  src/
    features/
      acp-execution/
      native-session-reconciliation/
      runtime-instance/
      installation/
      managed-profile/
      credential-bridge/
      provider-catalog/
      permission-mapping/
      elicitation-mapping/
      mcp-reconciliation/
      observation-projection/
      usage-import/
      artifact-mapping/
      compatibility-profile/
    composition/
    testing/
```

Generic ACP support is separate:

```text
packages/protocols/acp-transport-stdio/
packages/protocols/acp-v1/
packages/protocols/acp-conformance/
```

ACP v2 is not created as a production package until an implementable official
schema and SDK exist. Draft behavior is isolated behind negotiation and
explicit experimental flags.

One OpenCode workspace package with strict feature entrypoints is preferred
initially. Splitting every adapter into a package would add release and
composition overhead without improving domain isolation.

## Capability authority

Each provider session binding persists a capability authority assignment.

Default OpenCode authority:

| Capability | Authority |
| --- | --- |
| session create/load/resume/list/close | ACP when negotiated |
| input, cancellation, and live updates | ACP |
| runtime permission interaction | ACP, with durable AR enforcement state |
| session configuration and MCP injection | ACP when supported |
| installation, host lifecycle, auth, catalog, profile | OpenCode native/host |
| history, children, pending interactions, exact reconciliation | OpenCode native |
| offline database inspection | diagnostic reconciliation only |
| unsupported provider-native actions | optional typed OpenCode extension |

Native and ACP paths must never both mutate the same capability for one
operation. A native fallback after an ACP timeout is prohibited until the
ambiguous operation is reconciled.

## Accepted invariants

### Runtime instance and process custody

- Every managed endpoint is authenticated with an app-owned credential.
- A random localhost port alone is not authentication.
- PID is diagnostic data, not process authority.
- POSIX uses process-group custody; Windows uses a process handle or Job
  Object equivalent.
- Stop and recovery verify process identity and the active custody fence.
- A corrupt registry is quarantined and reconciled, never silently replaced
  with an empty registry.
- Shared OpenCode hosts expose their shared blast radius. A consumer cannot
  restart a shared PID as if it belonged to one session.

### Installation

- Runtime versions are installed into immutable version directories.
- Archives are integrity-checked and protected against path traversal.
- Activation uses an authoritative atomic current-version pointer.
- Installation and activation are serialized across processes.
- Failed activation preserves the last known working version.
- An active version is not replaced in place.
- Auto-update is disabled unless the host explicitly grants update authority.

### Managed profiles and credentials

- Managed profile desired state is immutable and reproducibly materialized.
- User-owned OpenCode configuration is never mutated implicitly.
- Profile, launch, credential, tool binding, and compatibility revisions are
  separate values.
- Workspace paths are canonicalized with real-path and platform case rules.
- OAuth stages new credentials, verifies them, atomically activates a new
  generation, and reconciles replicas afterward.
- Existing credentials are not deleted before a replacement is proven.
- Raw credentials never enter fingerprints, logs, events, or domain state.

### ACP execution

- ACP is negotiated by protocol version and capabilities.
- Current stable ACP v1 is supported first.
- ACP v2 Draft does not influence domain vocabulary or persistence.
- ACP session updates are live observations, not a durable replay source.
- After reconnect or suspected gaps, native history/status reconciliation
  repairs the canonical AR feed.
- ACP client filesystem, terminal, tool, MCP, and permission callbacks pass
  through scoped Agent Execution capabilities backed by Runtime Security
  decisions where authorization is required.
- Unsupported content is rejected explicitly or preserved as a typed artifact;
  it is not silently dropped.

### Operations and reconciliation

- One caller input creates one `RuntimeOperation`.
- Provider calls occur only from durable dispatch intents after commit.
- Provider acceptance is distinct from operation completion.
- Timeout after dispatch produces an ambiguous outcome.
- Ambiguous input, cancel, permission, and configuration outcomes reconcile
  against provider identities before any retry.
- Provider session IDs and message IDs are opaque external references.
- Binding and capability revisions are checked immediately before dispatch.
- A provider session is never silently replaced during input submission.

### Runtime interactions

- Permission and elicitation are separate domain concepts.
- A permission decision stores revision, capability scope hash, expiry,
  authority evidence reference, public execution epoch, and authority
  revision. The internal generation identity and private execution fence
  remain inside Agent Execution and are revalidated there immediately before
  enforcement.
- Decision acceptance and provider enforcement are separate durable stages.
- An enforcement timeout becomes `uncertain`; trying several provider
  endpoints after timeout is prohibited.
- OpenCode questions map to runtime elicitation and cannot remain as
  diagnostic-only events.
- Child-session interactions are discovered and attached to their own provider
  bindings.

### Observation and artifacts

- SSE only wakes reconciliation readers; it does not provide durable ordering.
- Canonical feed entries are deduplicated by provider identity and source
  checkpoint.
- Unknown message parts are retained as redacted raw artifact references.
- Tool output, reasoning, logs, and attachments have explicit size limits.
- Attachments use MIME sniffing, decoded-byte limits, URI policy, workspace
  scope, and SSRF protection.
- Remote deployments transfer artifacts by reference, not unbounded base64 in
  commands or events.
- Usage observations carry source, quality, cumulative/delta semantics, and
  replacement identity.
- OpenCode SQLite is a version-gated read-only recovery source, never the
  runtime source of truth.

### MCP

- The consumer owns desired tool policy and orchestration meaning.
- Agent Runtime receives a typed tool server specification and owns safe
  materialization and technical readiness.
- Secrets use references; local environment variables use an allowlist.
- Remote MCP uses URL and SSRF policy.
- Local MCP processes belong to runtime process custody.
- Session creation success does not prove MCP readiness.
- Registration is reconciled by complete normalized configuration, not name
  alone.

## Legacy disposition

Existing OpenCode code is used as:

- a behavioral oracle for edge cases;
- a donor for narrow parsers and cross-platform algorithms;
- a source of characterization fixtures and failure scenarios.

It is not copied as:

- `OpenCodeSessionBridge`;
- `OpenCodeClientFactory`;
- team-aware session stores;
- delivery ledgers and team retry policy;
- orchestration prompts;
- product model recommendations;
- task, board, review, or merge behavior.

Expected reuse is primarily semantic: roughly 60-70% of valuable algorithms
and test scenarios may be adapted, while direct architectural code reuse should
remain limited.

## Provider conformance

The OpenCode conformance suite must cover:

- capability negotiation and version drift;
- host authentication, adoption, corrupt registry, PID reuse, and crash;
- installation concurrency, failed activation, and rollback;
- credential rotation, OAuth interruption, and stale replica recovery;
- session creation, stale binding, concurrent input, and ambiguous acceptance;
- cancel and permission enforcement uncertainty;
- SSE disconnect, replay gaps, duplicate events, and child sessions;
- unknown transcript parts, output limits, and redaction;
- MCP drift, duplicate names, environment restrictions, and SSRF;
- attachment validation and remote transfer;
- usage duplication, correction, child attribution, and database schema drift.

No conformance test may launch agents against a real user project.
