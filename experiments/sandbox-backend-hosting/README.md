# Sandbox backend hosting evidence harness

Status: isolated hosted evidence. It is not production code, a backend
selection, or a production-qualification claim.

The canonical ownership and containment decision is
`docs/decisions/0001-runtime-profile-and-activation-boundaries.md`. Results and
limitations are recorded in
`docs/spikes/sandbox-backend-hosting-qualification-results.md`.

The harness probes disposable resources only:

- lightweight Docker density and resource accounting;
- OpenSandbox lifecycle, reconnect, lost acknowledgement, recovery, fencing
  gaps, network policy, credential inheritance, and residue cleanup;
- Kubernetes Agent Sandbox direct and warm-pool lifecycle on a disposable Kind
  cluster.

Run only on a dedicated test host after reviewing the scripts and environment
guards. The default evidence directory is local to the current checkout. Every
created resource is labeled or namespaced by a caller-supplied unique
`SPIKE_RUN_ID` for narrow cleanup. The harness refuses to run without that ID.
It must not run against user projects, shared namespaces, ambient credentials,
or production clusters.

No result authorizes a backend. Exact production targets require retained
evidence and a matching Agent Runtime qualification-registry entry.

The retained OpenSandbox campaign versions are pinned by default to SDK
`0.1.15` and Server `0.2.2`. Overrides are explicit environment inputs and
produce a different evidence target. The disposable Alpine workload image is
pinned to its Linux AMD64 manifest digest. Kubernetes Agent Sandbox release
manifests are downloaded at the pinned release and verified against retained
SHA-256 digests before use. The Kind scenario refuses to reuse or delete a
cluster it did not create during the current run.
