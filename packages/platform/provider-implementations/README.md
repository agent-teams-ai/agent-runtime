# Provider implementations

Private ordinary workspace library of Claude SDK, Codex app-server and selected
OpenCode V1/V2 session implementations. Agent Execution owns the canonical
interactive SPI; this package implements it through erased type-only imports.
Callers own selected configuration, private checkpoint persistence, process
custody, product tool authority and provider qualification.

Import concrete APIs from `./claude`, `./codex`, `./opencode`, or `./session-io`.
The root exports portable owned types only; `./composition` exports factories.
There is no provider invocation on import and no automatic provider selection.

`pnpm --filter @agent-teams/provider-implementations check` builds the workspace
package and checks its source, native protocol fixtures and isolated consumer.
All fixtures use disposable state without provider credentials or user projects.

ADR-0092 admits this package's location and active feature scope. The exact
standalone source checkpoint and file relocation map live in
`provenance/materialization.json`. That extraction checkout is a historical
input; this workspace package is the sole editable implementation after delivery.
Its prior qualification does not certify this layout or real provider access.

The current extracted mechanisms remain a partial donor migration. Profile and
credential handling, native materialization/custody, remaining donor behavior and
complete team parity retain their existing owners and outstanding gates. B's
experimental driver retirement is a separate integration change.
