# Stage I streaming egress and backpressure results

Status: accepted scoped experimental evidence

Date: 2026-07-28

Canonical decision:
`docs/decisions/0001-runtime-profile-and-activation-boundaries.md`

Stage I exercised an HTTP/1 streaming gateway and synthetic upstream on the
hosted Linux worker. Both listened only on loopback. The campaign did not open
a user project, read a credential, start an agent/provider/MCP process, make a
provider request, or use an external network.

## Scope

The frozen v3 campaign covered:

- complete small response forwarding;
- request-byte rejection before upstream dispatch;
- response-byte rejection before and after response headers;
- total timeout after response headers;
- downstream disconnect cancellation;
- incomplete upstream response;
- slow-consumer backpressure over a 4 MiB stream;
- 24 concurrent isolated streams and receipts.

This is synthetic loopback Node HTTP/1 evidence. It does not qualify TLS,
public DNS, HTTP/2, an external proxy/load balancer, a real provider SDK, or a
production gateway.

## Rejected calibrations

V1 destroyed the upstream response before storing the terminal byte-budget
decision. The synchronous abort path won the race and misclassified the same
request as `upstream_incomplete_after_headers`. V2 reversed the order so the
canonical decision is written before the abort side effect.

V2 then exposed two harness assumptions. It hard-coded a 16 KiB writable
high-water mark although the tested runtime reported 64 KiB, and it sampled
socket cleanup before asynchronous close events completed. V3 reads the actual
runtime high-water mark, slices writes to that bound, and waits for socket
closure. The rejected evidence remains retained.

## Accepted facts

- A 128 KiB request exceeded the 64 KiB request budget, returned `413`, and
  caused zero upstream dispatches. Request buffering therefore prevented a
  partial provider-side effect in this scope.
- A declared response length above 128 KiB was rejected before downstream
  headers with a complete `502` response.
- A chunked response exceeded 128 KiB after downstream `200` headers. The
  gateway forwarded exactly 128 KiB, then aborted the stream. The client saw
  an incomplete/errored `200`; the durable receipt carried
  `response_budget_exceeded_after_headers`.
- A total timeout after `200` likewise aborted the stream and produced the
  typed `postheader_timeout` receipt.
- Client disconnect closed the upstream response and produced one
  `client_disconnect` decision.
- Upstream disconnect after a partial body produced an incomplete client
  stream and `upstream_incomplete_after_headers`.
- The 4 MiB slow-consumer flow completed. Backpressure engaged 63 times and
  maximum queued writable bytes stayed within the audited bound derived from
  the runtime high-water mark.
- All 24 concurrent small streams completed with 24 distinct receipt IDs.
- Final cleanup left zero tracked sockets and no listening servers.

## Repeatability and audit

Calibration and both final campaigns passed a 37-of-37 independent read-only
verifier. Final raw results differed while their canonical facts shared
digest:

```text
07bc78bf97f290d72c932d08694b387412c752a549481a26b5c50e17306232fd
```

## Architecture consequence

- Request bodies are bounded and completed before provider dispatch whenever
  the product requires proof that rejection caused no partial upstream effect.
- Before downstream headers, a gateway can return a typed HTTP error. After
  headers, it can only abort/truncate the stream; the original `200` is not a
  terminal success fact.
- The AR-owned receipt and output-drain barrier are canonical terminal truth.
  Provider/HTTP status remains an observation.
- A terminal budget/timeout decision is durably selected before cancellation
  or socket destruction can produce competing error events.
- Transport chunk size is not a trusted memory bound. The gateway slices
  writes against its actual configured/runtime bound and propagates
  backpressure and cancellation in both directions.

This strengthens the existing Agent Execution gateway port and receipt
contracts. It does not create a new bounded context or service.

## Evidence identity

```text
rejected v1 source / result
1d61d70d0be2e288c5e0f5aef8936582dc81f42265901823b75899b68169db6c
12df52b683f235cf53ac0fd23498de37b7459739349a8617d0de157d391b3ac0

rejected v2 source / result
cb4b5971e90a7a38b070699a0a8ec903b54148aa68f43249df23670ead4e9309
89502cd7310784c81ba8386d5a91642a9d66e9d4ba5156b49fd546fc82c323bd

accepted v3 source / verifier
45adece42dc9d235f220a942ccdfe6bb9383c63673cee64d9a0e81ae21ac19fe
fe462d591e6d619cbfb0dc7b72b009006211a7b584f816df8095c036ec7015bf

calibration result / audit
44a281407bfb0273a6c8223b0e0e510f15ed59539a43f0414cd9c6fefb38d730
fb26f5c32a13068982ba5b72e89723dfe5a5df93a37fcb03984a65a53f3817

final A result / audit
8af0a2c4979523674394073e45bef450f8ea6d4651fc0d4e55785c0776d5667f
2cf00aa6e3e12d50429d90431565ebc56c75617a07f39f70cdf1b4ce1ed5a996

final B result / audit
9001be92489f3301d88c32f4175c255fca85c6055f6e99167100954be6a93273
0173cd8df26a807e87e8de3e1553a91b50f66720f6622e8085394363d7cc9ac9

final comparison
735878ee64eedc3aca2e072aa7091be2276a1d91bcb9ca392c6a2d77266e56f9
```

The redacted machine-readable summary is
`experiments/runtime-profile-behavior/fixtures/stage-i-streaming-egress-summary.json`.

## Remaining gates

- production signed-policy and receipt implementation;
- public-PKI TLS, DNS/rebinding, private-address, and IP-rotation conformance;
- external proxy, load balancer, HTTP/2, GOAWAY, and retry behavior;
- real provider streaming and SDK buffering/cancellation behavior;
- multi-tenant long-duration memory, fairness, and slow-consumer soak;
- worker crash and reconnect during partial streams.
