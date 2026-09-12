---
type: feature
status: accepted
owner: "@agent-teams/filesystem-custody"
owner_document: ADR-0017
---

# Stable filesystem custody

One cohesive technical feature: descriptor-relative filesystem custody for the
runtime. It captures and compares path lineage, opens a path under a custody
boundary, resolves whether descriptor-relative mutation is supported on the
current platform, publishes a directory without replacing an existing one, and
serializes processes on a retained directory descriptor. On Darwin it also owns
the native Host descriptor primitives behind its acquisition guard.

The feature is deliberately undivided. Every one of those operations depends on
the same qualified native binding and the same descriptor identity rules, so
splitting them would create boundaries that cannot be tested or replaced apart
from each other.

## Layers

`contracts` holds only portable shapes: path lineage and component identity, the
custody boundary pair, the publication outcome, and the mutation-capability
disposition. They name no Node type. The platform union is spelled out here
rather than taken from the ambient Node namespace, and
`adapters/outbound/filesystem/stable-directory-capability.ts` asserts at compile
time that it stays equal to the runtime's own union. The public package entry can
therefore expose these contracts without requiring Node type definitions.

`adapters` holds the real Node and native implementation: the filesystem
adapters and the single module that resolves the qualified native artifact. The
Node-specific descriptor surface, `StableFilesystemHandle` and
`StableFilesystemStats`, lives here rather than in `contracts`, because a Node
`Buffer` and `BigIntStats` projection is an implementation surface and not a
portable contract. Consumers that need it import the package `./composition`
entry.

There is deliberately no `domain` or `application` layer. The feature carries no
invariant that is independent of the platform it mediates, and an empty layer
would be ceremony.

## Preserved behavior

Descriptor identity, path lineage comparison, close-once handling, publication
ambiguity reporting, and explicit platform refusal are unchanged by the move
into this layout. The qualified native artifact is still emitted to the package
`dist` root and loaded through one resolver.
