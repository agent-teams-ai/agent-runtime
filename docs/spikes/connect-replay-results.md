# Connect replay and timeout results

Status: accepted scoped experimental evidence

Date: 2026-07-28

Canonical decision:
`docs/decisions/0001-runtime-profile-and-activation-boundaries.md`

The v2 campaign passed an independent 55-of-55 read-only audit over Connect
HTTP/1.1 and HTTP/2 unary timeout, stream interruption, explicit cursor replay,
typed cursor errors, slow-consumer buffering, and HTTP/2 GOAWAY recovery. This
is a local Node adapter decision matrix, not production Connect readiness.

## Safety and versions

The campaign ran only on loopback with synthetic commands and events. It used
no user project, ambient credential, provider request, or MCP server.

Pinned current stable packages were:

```text
@connectrpc/connect       2.1.2
@connectrpc/connect-node  2.1.2
@bufbuild/protobuf        2.13.0
```

Buf STANDARD lint, TypeScript 7 typecheck, generated-schema reproducibility,
and the production dependency audit passed. The dependency audit reported zero
known vulnerabilities at every severity.

Connect's official Node documentation describes support for unary and
streaming RPCs and for the Connect protocol over HTTP/1.1 or HTTP/2:
[Node getting started](https://connectrpc.com/docs/node/getting-started/).
The tested Node adapter was pinned to the official
[connect-es v2.1.2 release](https://github.com/connectrpc/connect-es/releases/tag/v2.1.2).

## Confirmed behavior

### Timeout after commit

For both HTTP/1.1 and HTTP/2, the handler durably accepted the synthetic
command and then delayed its response. The client received
`DeadlineExceeded`; the server handler observed abort. Retrying with the same
command ID and semantic digest returned replay and left one command.

A transport timeout is therefore an unknown command outcome. Neither the
client error nor the handler abort proves rollback.

### Stream interruption and replay

The connection/session was destroyed after the client received events
`1,2,3` from a ten-event stream:

- HTTP/1.1 surfaced `Aborted`;
- HTTP/2 surfaced `Canceled`;
- neither call automatically resubscribed;
- an explicit new call using the last durable cursor returned exactly
  `4,5,6,7,8,9,10`.

When event 5 was delivered but its cursor was not checkpointed, reconnecting
from cursor 4 redelivered the same stable event ID. The public feed is
at-least-once across that failure window. A consumer must atomically persist
its projection/deduplication record and cursor.

### Cursor failures

Both protocols returned the expected Connect code plus typed
`CursorErrorDetail` for:

- expired cursor: `OutOfRange / EXPIRED`;
- forged signature: `InvalidArgument / INVALID_SIGNATURE`;
- cursor bound to another stream: `PermissionDenied / WRONG_STREAM`;
- cursor ahead of the stream: `OutOfRange / AHEAD`.

No case silently reset to latest or crossed stream ownership.

### Slow consumer counterexample

Each protocol streamed 128 events of 65,536 bytes. The client read one event
and paused for 300 ms. During that pause, the server generator produced all
128 events, about 8 MiB, on both HTTP/1.1 and HTTP/2. By the time the client
canceled, server production had completed and the handler did not observe an
abort.

This is a bounded counterexample, not a universal maximum-buffer measurement.
It proves that AR cannot use Connect/Node backpressure as its application
memory or fairness budget. Agent Execution must enforce per-subscriber queued
event/byte limits and terminate or spill a lagging feed according to policy.

### HTTP/2 GOAWAY

After an idle HTTP/2 session received GOAWAY and closed, the pinned `2.1.2`
client created a usable successor session and the next unary command
succeeded. Session recovery did not imply or perform command replay.

## Rejected revision

v1 was interrupted after 136 seconds because an HTTP/1.1 connection remained
in `CLOSE_WAIT/FIN_WAIT_2` and `server.close()` did not finish. It produced no
promotable runtime result. v2 added an explicit client/server connection
ledger, agent/session abort, `closeAllConnections`, and a two-stage cleanup
deadline. It completed without residue under a 120-second outer deadline.

This adds a transport-custody invariant: logical RPC completion is not proof
that every connection handle closed.

## Architecture consequences

- Submit commands carry a global durable command ID and semantic fingerprint.
  Timeout retry reuses both; it never generates a replacement command.
- The SDK owns explicit reconnect using the last durable opaque cursor.
- Feed delivery is at least once. Stable event IDs and consumer-owned
  projection/cursor transactions provide deduplication.
- Cursors bind tenant, stream, projection version, retention epoch, and
  sequence under a rotatable `KeyProvider`; forged or cross-stream cursors fail
  closed.
- Expired and ahead cursors are typed product states, not automatic jumps.
- Per-subscriber event/byte budgets, cancellation, and cleanup are application
  contracts independent from Connect transport buffering.
- HTTP/2 GOAWAY and connection recovery belong to the adapter. They do not own
  aggregate state or retry authority.

The `.proto`, generated TypeScript, and harness are evidence only. Production
contracts require their own API review and compatibility policy.

## Evidence identity

```text
harness
adf87a8f7771289cc2d1ba3d9c01a92257ddfea007d5ac644d8ee204699d8dd9

proto
3cb311ff4d0fec78b7912c99898e5c9ca9fa63d12892b85352dc4ddb49d79090

generated schema
420cd0b1100e2860cbd25e8274557522a0d79999e159af859736a2ffb39ccffc

package lock
085cc3c98afa5c4864f4331f4474b5b6b9576034819346a4452ce9dc86bd7813

v2 result
ee00ecb79bc3d7047e89bcd2734da6256d75e24e114884b6a0ef8f29e2ea4136

independent audit source
53208764b6856e8cc3c2806d706ff5de2681354c80775ded411556fff133ebf0

independent audit result, 55/55 GO
12c757cdfb9288b79885c1f3e288f0be09cfb272f78c27bc0c92d2381740d8a0

retained bundle
07a60c53161f9781911ef46b889e056d214054aa3648d85b365d9843894a1c68
```

The redacted machine-readable summary is
`experiments/runtime-profile-behavior/fixtures/connect-replay-summary.json`.

## Remaining production gates

- TLS termination, reverse proxy, load balancer, and service-mesh interruption;
- browser, mobile, and generated public SDK parity;
- multi-host Connect transport and deployment drain;
- production persistence, retention compaction, and cursor-key rotation;
- long-duration slow-consumer and resource-limit soak.
