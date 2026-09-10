import type { CommittedDispatchProofV1 } from "../domain/committed-dispatch-proof-v1.js";
import type { ContainedTurnRouteQualificationTarget } from "./contained-turn-route-enforcement-capability.js";
import type { CreateCodexCurrentKernelOwnerOptions } from "./codex-current-kernel-owner.js";
import { createDarwinCodexHostPostClaimPreparation, type DarwinCodexHostPreparationInput } from "./darwin-codex-host-post-claim-preparation.js";
import {custodyDataRecord, isHostCustodyDataCallback, NodeProviderProcessCustodyCore,
  snapshotHttpBytes, retainFinalizationHttpResources} from "../adapters/outbound/host-custody/contained-turn-kernel-custody-entrypoint.js";
import { CODEX_APP_SERVER_DARWIN_ARM64_TUPLE as tuple, selectCodexAppServerPlatformTuple } from "../adapters/outbound/codex-app-server/codex-app-server-platform-tuple.js";

/** Fixed contained-agent-turn feature-local helper, statically composed by the
 * existing outer owner. Neither an Assembly graph node nor a production root.
 * Nominality authenticates wiring only; registry qualification is independent. */
declare const darwinRoute: unique symbol;
export interface DarwinCodexRouteEnforcementCapability {
  readonly [darwinRoute]: true;
  readonly postClaimPreparation: NonNullable<CreateCodexCurrentKernelOwnerOptions["postClaimPreparation"]>;
}
/** Internal consumer port. Embedded Runtime's concrete PA/RS authority assembler
 * owns acquisition, authenticates the store acknowledgement and burns selection.
 * This is not a feature DI port or a caller-supplied preparation callback. */
export interface DarwinCodexClaimedSessionOwner {
  acquire(proof: CommittedDispatchProofV1): DarwinCodexHostPreparationInput["session"];
}
export interface DarwinCodexRouteEnforcementInput {
  readonly sessionOwner: DarwinCodexClaimedSessionOwner;
  readonly preparation: Omit<DarwinCodexHostPreparationInput, "session">;
  readonly owner: Omit<CreateCodexCurrentKernelOwnerOptions, "postClaimPreparation">;
  readonly qualificationTarget: ContainedTurnRouteQualificationTarget;
}
type Options = CreateCodexCurrentKernelOwnerOptions;
const owners = new WeakMap<object, Readonly<{
  target: ContainedTurnRouteQualificationTarget;
  source: DarwinCodexRouteEnforcementInput["owner"];
  options: Options;
}>>();
const invalid = (): TypeError => new TypeError("Darwin Codex route owner binding is invalid");
const data = <T extends object>(value: T): T => Object.freeze({...custodyDataRecord(value)});
const method = <T extends (...args: never[]) => unknown>(value: T): T => {
  if (!isHostCustodyDataCallback(value)) {throw invalid();}
  return value;
};
const targetSnapshot = (value: ContainedTurnRouteQualificationTarget): ContainedTurnRouteQualificationTarget => {
  const target = data(value);
  const keys = ["provider", "providerAdapter", "binaryClosure", "platform", "credentialRoute",
    "storageTopology", "transportTopology", "failureDomain"] as const;
  if (Reflect.ownKeys(target).length !== keys.length || keys.some(key => {
    const token = target[key];
    return typeof token !== "string" || token.length < 1 || token.length > 256 ||
      /[\p{Cc}\s]/u.test(token) || ["*", "any", "all"].includes(token.toLowerCase());
  }) || target.provider !== "openai-codex" || target.platform !== "darwin-arm64" ||
    target.providerAdapter !== tuple.adapterRevision || target.binaryClosure !== tuple.binaryRevision) {throw invalid();}
  return target;
};

/** Captures deployment facts and defers actual preparation and session acquisition until claim.
 * There is intentionally no preparation callback/brand injection or native execution here. */
export const createDarwinCodexRouteEnforcement = (
  input: DarwinCodexRouteEnforcementInput,
): DarwinCodexRouteEnforcementCapability => {
  const captured = data(input);
  if (Reflect.ownKeys(captured).length !== 4) {throw invalid();}
  const target = targetSnapshot(captured.qualificationTarget);
  const source = data(captured.owner);
  if (Object.hasOwn(source, "postClaimPreparation")) {throw invalid();}
  const platform = data(source.platformTarget);
  if (selectCodexAppServerPlatformTuple(platform) !== tuple ||
      typeof source.hostBootId !== "string" || source.hostBootId.length === 0 ||
      typeof source.hostInstanceId !== "string" || source.hostInstanceId.length === 0) {throw invalid();}
  const prep = data(captured.preparation);
  if (prep.hostCustody !== source.hostCustody || NodeProviderProcessCustodyCore.httpPreparation(prep.hostCustody) === undefined) {
    throw invalid();
  }
  const executable = data(prep.executable);
  if (executable.sha256 !== tuple.binarySha256 || typeof executable.path !== "string" || !executable.path.startsWith("/")) {throw invalid();}
  const localCut = data(prep.localCut); const clock = data(localCut.clock);
  const read = method(clock.read); const within = method(clock.within);
  if (Object.hasOwn(prep, "session")) {throw invalid();}
  const sessionOwner = data(captured.sessionOwner);
  if (Reflect.ownKeys(sessionOwner).length !== 1) {throw invalid();}
  const acquire = method(sessionOwner.acquire);
  const catalogSource = snapshotHttpBytes(prep.catalogSource, Number.MAX_SAFE_INTEGER);
  if (catalogSource === undefined) {throw invalid();}
  const preparationInput = Object.freeze({...prep, executable, observer: data(prep.observer),
    durableRoot: data(prep.durableRoot), limits: data(prep.limits),
    localCut: Object.freeze({...localCut, expectedClock: data(localCut.expectedClock), clock: Object.freeze({
      read: () => Reflect.apply(read, localCut.clock, []),
      within: ((...args: Parameters<typeof within>) => Reflect.apply(within, localCut.clock, args)) as typeof within,
    })}), catalogSource,
  });
  const postClaimPreparation: NonNullable<Options["postClaimPreparation"]> = Object.freeze({
    async prepareClaimed(claimed: Parameters<NonNullable<Options["postClaimPreparation"]>["prepareClaimed"]>[0]) {
      try {
        const claimedInput = data(claimed);
        const proof = data(claimedInput.committedDispatchProof);
        if (proof.provider !== "codex" || proof.hostBootId !== source.hostBootId || proof.hostInstanceId !== source.hostInstanceId) {
          return Object.freeze({kind: "unsupported" as const, reason: "owner" as const});
        }
        // The concrete outer owner must take this same store-acknowledged proof
        // before allocating any per-operation current authority, signer or session.
        const session = data(Reflect.apply(acquire, captured.sessionOwner, [proof]));
        const identity = data(session.identity);
        if (identity.operationId !== proof.operationId || identity.attemptId !== proof.attemptId ||
            identity.custodyId !== proof.custodyId || identity.hostBootId !== proof.hostBootId) {throw invalid();}
        const actual = createDarwinCodexHostPostClaimPreparation({...preparationInput,
          session: retainFinalizationHttpResources(session, data(session.providerAccessSnapshot))});
        return await actual.prepareClaimed(Object.freeze({...claimedInput, committedDispatchProof: proof}));
      } catch {return Object.freeze({kind: "quarantined" as const});}
    },
  });
  const records = data(source.launchRecords); const resolve = method(records.resolve);
  const launchRecords: Options["launchRecords"] = Object.freeze({resolve: async (request: Parameters<Options["launchRecords"]["resolve"]>[0]) => {
    const binding = custodyDataRecord(request.providerBinding);
    if (binding.provider !== "codex" || binding.adapterRevision !== tuple.adapterRevision ||
        binding.binaryRevision !== tuple.binaryRevision || binding.capabilityManifestRevision !== tuple.protocolRevision) {throw invalid();}
    const result = await Reflect.apply(resolve, source.launchRecords, [request]);
    if (result === undefined) {return undefined;}
    const launch = data(result);
    if (launch.executablePath !== executable.path || launch.boundary !== prep.boundary || launch.tmpDir !== prep.tmpDir) {throw invalid();}
    return launch;
  }});
  const options = Object.freeze({...source, platformTarget: platform, launchRecords, postClaimPreparation});
  // The declared symbol is compile-time only; runtime authority is this WeakMap.
  const capability = Object.freeze({postClaimPreparation}) as DarwinCodexRouteEnforcementCapability;
  owners.set(capability, Object.freeze({target, source, options}));
  return capability;
};

/** Identity lookup never reflects on an untrusted candidate. */
export const readDarwinCodexRouteEnforcementTarget = (value: unknown): ContainedTurnRouteQualificationTarget | undefined =>
  value !== null && typeof value === "object" ? owners.get(value)?.target : undefined;

/** Join the existing selected owner to the captured deployment. Only the exact
 * capability-owned preparation is accepted if a caller supplies that option. */
export const bindDarwinCodexRouteEnforcement = (value: unknown, input: Options): Options => {
  const owner = value !== null && typeof value === "object" ? owners.get(value) : undefined;
  if (owner === undefined) {throw invalid();}
  const candidate = data(input);
  const platform = data(candidate.platformTarget);
  if (selectCodexAppServerPlatformTuple(platform) !== tuple ||
      (Object.hasOwn(candidate, "postClaimPreparation") && candidate.postClaimPreparation !== owner.options.postClaimPreparation)) {throw invalid();}
  const keys = Reflect.ownKeys(owner.source) as (keyof typeof owner.source)[];
  if (Reflect.ownKeys(candidate).some(key => key !== "postClaimPreparation" && !keys.includes(key as keyof typeof owner.source)) ||
      keys.some(key => !Object.hasOwn(candidate, key) || (key !== "platformTarget" && candidate[key] !== owner.source[key]))) {throw invalid();}
  return owner.options;
};
