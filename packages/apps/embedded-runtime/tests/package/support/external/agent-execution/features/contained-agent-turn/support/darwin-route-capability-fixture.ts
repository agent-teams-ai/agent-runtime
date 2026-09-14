import { NodeProviderProcessCustodyCore,CODEX_APP_SERVER_DARWIN_ARM64_TUPLE as tuple,createDarwinCodexRouteEnforcement,type DarwinCodexRouteEnforcementInput } from "@agent-teams/agent-execution/composition";
import { createEgressFixture } from "../http-egress-test-fixture.ts";

/** Explicitly synthetic owners; minting performs no filesystem/native/provider work. */
export const darwinRouteFixture = () => {
  const egress = createEgressFixture();
  let resolves = 0; let acquisitions = 0;
  const hostCustody = new NodeProviderProcessCustodyCore({launchPlans: {resolve: async () => {throw new Error("no launch");}}}, {
    platform: "darwin", containmentProfile: tuple.containmentProfile,
    residueAuthorityFactory: {create: async () => {throw new Error("no residue allocation");}},
  });
  const input: DarwinCodexRouteEnforcementInput = {
    sessionOwner: {acquire() {acquisitions++; throw new Error("synthetic: no acknowledged claim");}},
    qualificationTarget: {provider: "openai-codex", providerAdapter: tuple.adapterRevision, binaryClosure: tuple.binaryRevision,
      platform: "darwin-arm64", credentialRoute: "synthetic-pa", storageTopology: "synthetic-durable-host",
      transportTopology: "synthetic-seatbelt-http", failureDomain: "synthetic-single-host"},
    owner: {hostCustody, hostBootId: "host-boot:synthetic", hostInstanceId: "host-instance:synthetic",
      platformTarget: {platform: "darwin", architecture: "arm64"},
      effectCustody: {admit() {throw new Error("no effects");}},
      workspaceOwner: {async withLaunchAuthority() {throw new Error("no workspace");}},
      launchRecords: {async resolve() {resolves++; return;}},
    },
    preparation: {hostCustody, durableRoot: {path: "/synthetic-absent-durable", dev: "1", ino: "2"},
      // Boundary is opaque during construction; real preparation validates it after claim.
      boundary: Object.freeze({synthetic: true}) as never,
      executable: {path: "/synthetic-absent-codex", sha256: tuple.binarySha256},
      observer: {path: "/synthetic-absent-observer", sha256: "a".repeat(64)},
      launcherSha256: "a".repeat(64), nodeSha256: "a".repeat(64), catalogSource: Buffer.alloc(0),
      tmpDir: "/synthetic-absent-tmp", limits: egress.operation.limits,
      localCut: {operationDeadline: egress.operation.limits.deadline, expectedClock: {authorityId: "synthetic", epoch: "1"},
        clock: {read: () => ({authorityId: "synthetic", epoch: "1", controlTime: 0}), within: async (_deadline, run) => run()}},
    },
  };
  return {input, tuple, egress, resolves: () => resolves, acquisitions: () => acquisitions, mint: () => createDarwinCodexRouteEnforcement(input)};
};
