import { randomUUID } from "node:crypto";
import { types } from "node:util";
import {
  createDockerCodexHostKernelOwner, createDockerCodexNativeBrokerFinalizer,
  createDockerLinuxExclusiveRouteAdmission, createNodeHostHttpConnection, createNodeHostHttpListener, hostHttpAbortOperations,
  type CreateCodexCurrentKernelOwnerOptions, type CodexCurrentKernelOwner, type CreateDockerCodexHostKernelOwnerOptions,
  type DockerCodexNativeBrokerFinalizerInput, type DockerLinuxExclusiveRouteAdmissionInput,
  type DockerLinuxPostClaimDependencies,
} from "@agent-teams/agent-execution/composition";
import { createNodeEd25519ProviderProcessEgressAuthorizationV2Candidate } from "@agent-teams/runtime-security/composition";
import { createContainedTurnCurrentEgressOwners, type ContainedTurnCurrentEgressOwnersInput }
  from "./contained-turn-current-egress-owners.js";
import { bindContainedTurnHttpEgressAuthorities, composeContainedTurnHttpEgressSession,
  type ContainedTurnHttpEgressBrokerPorts } from "./contained-turn-http-egress-authorities.js";

type DockerOptions = CreateDockerCodexHostKernelOwnerOptions;
type Finalizer = ReturnType<typeof createDockerCodexNativeBrokerFinalizer>;
type SignerInput = Parameters<typeof createNodeEd25519ProviderProcessEgressAuthorizationV2Candidate>[0];
type Accept = DockerLinuxPostClaimDependencies["resources"]["accept"];
type ConnectionInput = Parameters<typeof createNodeHostHttpConnection>[0];

/** Private deployment dependencies, never workspace configuration or handle input.
 * select is inert and runs only inside the existing committed-claim handoff.
 * PA/RS readers, approved policy, image/provider closure and resource recipes
 * must be independently supplied; their presence is not qualification evidence. */
export interface LinuxCodexContainedTurnResources {
  readonly imageInitLock: NonNullable<DockerOptions["imageInitLock"]>;
  readonly cleanupMilliseconds: number;
  select(input: Parameters<DockerOptions["preparation"]>[0]): Readonly<{
    preparation: Omit<DockerLinuxPostClaimDependencies, "resources" | "routeAdmission" | "publishRouteFirstWrite"> & Readonly<{
      resources: Omit<DockerLinuxPostClaimDependencies["resources"], "accept" | "listenerFor">;
    }>;
    route: DockerLinuxExclusiveRouteAdmissionInput;
    currentAuthority: ContainedTurnCurrentEgressOwnersInput;
    signer: Omit<SignerInput, "authorityOwner">;
    authorities: Omit<Parameters<typeof bindContainedTurnHttpEgressAuthorities>[0], "runtimeSecurity">;
    broker: ContainedTurnHttpEgressBrokerPorts;
    nativeFiles: DockerCodexNativeBrokerFinalizerInput["nativeFiles"];
    connection: Omit<ConnectionInput, "expectedRequest">;
  }>;
}

export class LinuxCodexCompositionInputUnavailableError extends TypeError {
  public readonly code = "linux_codex_composition_input_unavailable";
  public constructor(public readonly boundary: string) {
    super(`Linux Codex composition input unavailable: ${boundary}`);
    this.name = "LinuxCodexCompositionInputUnavailableError";
  }
}
const missing = (boundary: string): never => {throw new LinuxCodexCompositionInputUnavailableError(boundary);};
const data = <T extends object>(value: T, boundary: string): T => {
  if (value === null || typeof value !== "object" || types.isProxy(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {return missing(boundary);}
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== "string") ||
      Object.values(descriptors).some(descriptor => !("value" in descriptor))) {return missing(boundary);}
  return Object.freeze({...value});
};

type OperationSelection = ReturnType<LinuxCodexContainedTurnResources["select"]>;
const joinedHttpResources = (
  selected: OperationSelection,
  kernel: Parameters<DockerOptions["preparation"]>[0]["kernel"],
  finalizer: Finalizer,
): DockerLinuxPostClaimDependencies["resources"] => {
  const {broker, connection} = selected;
  const httpResources = selected.preparation.resources;
  let address: string | undefined;
  return Object.freeze({...httpResources,
    listenerFor(host: string) {
      const listener = createNodeHostHttpListener({host, deadline: connection.limits.deadline,
        closureDeadline: connection.limits.closureDeadline}, broker.clock);
      return Object.freeze({...listener, async open(...args: Parameters<typeof listener.open>) {
        const opened = await listener.open(...args);
        address = `${opened.address.address}:${opened.address.port}`;
        return opened;
      }});
    },
    async accept(...[socket, signal]: Parameters<Accept>) {
      if (address === undefined || hostHttpAbortOperations.aborted(signal)) {throw new TypeError("Docker HTTP listener unavailable");}
      const cutoff = new AbortController();
      const subscription = hostHttpAbortOperations.subscribe(signal, () => hostHttpAbortOperations.abort(cutoff));
      try {
        const expectedRequest = Object.freeze({requestId: randomUUID(), method: "POST",
          path: "/backend-api/codex/responses", host: address});
        const bound = createNodeHostHttpConnection({...connection, expectedRequest}, broker.clock)
          .bindAcceptedSocket(socket, cutoff);
        await finalizer.execute({operationId: kernel.operationId, attemptId: kernel.attemptId,
          expectedRequest, limits: connection.limits, ...bound});
      } finally {hostHttpAbortOperations.remove(subscription); hostHttpAbortOperations.abort(cutoff);}
    },
  });
};

const validateBrokerBinding = (
  broker: OperationSelection["broker"], currentInput: OperationSelection["currentAuthority"],
  signerInput: OperationSelection["signer"], kernel: Parameters<DockerOptions["preparation"]>[0]["kernel"],
): void => {
  const snapshot = data(broker.providerAccessSnapshot, "provider-access-snapshot");
  const scope = currentInput.operation.scope;
  if (signerInput.scope.operationId !== kernel.operationId ||
      signerInput.hostReservationId !== kernel.custodyId ||
      signerInput.scope.tenantId !== scope.tenantId || signerInput.scope.projectId !== scope.projectId ||
      signerInput.scope.scopeDigest !== scope.scopeDigest || snapshot.tenantId !== scope.tenantId ||
      snapshot.projectId !== scope.projectId || snapshot.scopeDigest !== scope.scopeDigest) {
    return missing("broker-authority-binding");
  }
};

const validateOperationSelection = (
  value: OperationSelection,
  kernel: Parameters<DockerOptions["preparation"]>[0]["kernel"],
) => {
  const selected = data(value, "operation-resources");
  const preparation = data(selected.preparation, "preparation");
  const httpResources = data(preparation.resources, "http-resources");
  const route = data(selected.route, "route-admission");
  const files = data(selected.nativeFiles, "native-finalizer");
  if (typeof files.install !== "function") {return missing("native-finalizer");}
  // Validate the complete selection before entering any resource recipe.
  if (typeof preparation.engineIdentity !== "function" || typeof preparation.openLifecycle !== "function" ||
      typeof preparation.openResourceJournal !== "function" || typeof httpResources.consumption?.prepare !== "function") {
    return missing("resource-owners");
  }
  const broker = data(selected.broker, "broker-ports");
  const connection = data(selected.connection, "connection");
  const currentInput = data(selected.currentAuthority, "current-authority");
  const binding = data(route.binding, "route-binding");
  if (typeof route.engine?.inspect !== "function" || route.nsenter === undefined || route.nft === undefined ||
      binding.operationId !== kernel.operationId || binding.attemptId !== kernel.attemptId ||
      binding.custodyId !== kernel.custodyId || binding.authorityVectorDigest !== kernel.authorityVectorDigest) {
    return missing("route-admission-binding");
  }
  if (currentInput.operation.scope.operationId !== kernel.operationId ||
      currentInput.operation.providerId !== "codex") {return missing("current-authority-binding");}
  for (const key of ["ids", "resolver", "evidence"] as const) {
    data(broker[key], `broker-${key}`);
  }
  const signerInput = data(selected.signer, "signer");
  validateBrokerBinding(broker, currentInput, signerInput, kernel);
  return {selected, preparation, route, broker, connection, currentInput, signerInput};
};

/** Selects the actual Docker Host/kernel owner. No legacy custody is consumed.
 * The existing owner retains claim/start fencing, root/image custody, resource
 * cleanup and uncertainty; this join supplies only its private dependencies. */
export const createLinuxCodexContainedTurnOwner = (
  options: CreateCodexCurrentKernelOwnerOptions,
  supplied: LinuxCodexContainedTurnResources | undefined,
): CodexCurrentKernelOwner => {
  const resources = data(supplied!, "trusted-resources");
  if (resources.imageInitLock === undefined) {return missing("image-init-lock");}
  if (typeof resources.select !== "function" || types.isProxy(resources.select)) {return missing("resource-selection");}
  if (!Number.isSafeInteger(resources.cleanupMilliseconds) || resources.cleanupMilliseconds <= 0) {
    return missing("cleanup-deadline");
  }
  const select = resources.select.bind(supplied);
  const retained = new Map<string, Readonly<{finalizer: Finalizer; dispose(): void}>>();
  const owner = createDockerCodexHostKernelOwner({
    hostBootId: options.hostBootId, hostInstanceId: options.hostInstanceId,
    workspaceOwner: options.workspaceOwner, launchRecords: options.launchRecords,
    platformTarget: options.platformTarget, effectCustody: options.effectCustody,
    cleanupMilliseconds: resources.cleanupMilliseconds, imageInitLock: resources.imageInitLock,
    preparation(input) {
      const {selected, preparation, route, broker, connection, currentInput, signerInput} =
        validateOperationSelection(select(input), input.kernel);
      const current = createContainedTurnCurrentEgressOwners(currentInput);
      let signer: ReturnType<typeof createNodeEd25519ProviderProcessEgressAuthorizationV2Candidate> | undefined;
      let authorities: ReturnType<typeof bindContainedTurnHttpEgressAuthorities> | undefined;
      try {
        signer = createNodeEd25519ProviderProcessEgressAuthorizationV2Candidate({...signerInput, authorityOwner: current});
        authorities = bindContainedTurnHttpEgressAuthorities({...selected.authorities, runtimeSecurity: signer});
        const session = composeContainedTurnHttpEgressSession(authorities, broker);
        // The parser recipe is inert. Validate its bounds before network allocation;
        // the real Host authority and fresh request identity are bound on accept.
        createNodeHostHttpConnection({...connection, expectedRequest: {requestId: "unbound",
          method: "POST", path: "/backend-api/codex/responses", host: "unbound"}}, broker.clock);
        const finalizer = createDockerCodexNativeBrokerFinalizer({session, nativeFiles: selected.nativeFiles,
          routeAdmission: createDockerLinuxExclusiveRouteAdmission(route)});
        const ownedSigner = signer; const ownedAuthorities = authorities;
        retained.set(input.kernel.custodyId, Object.freeze({finalizer, dispose() {
          try {finalizer.cutoff();} finally {
            try {ownedAuthorities.dispose();} finally {try {ownedSigner.dispose();} finally {current.dispose();}}
          }
        }}));
        return Object.freeze({...preparation, routeAdmission: finalizer.routeAdmission,
          resources: joinedHttpResources({...selected, broker, connection}, input.kernel, finalizer)});
      } catch (error) {
        try {authorities?.dispose();} finally {try {signer?.dispose();} finally {current.dispose();}}
        throw error;
      }
    },
    finishClaimed(input) {
      const joined = retained.get(input.claimed.committedDispatchProof.custodyId);
      if (joined === undefined) {return missing("retained-native-finalizer");}
      return joined.finalizer.finishClaimed(input);
    },
  });
  return Object.freeze({custody: owner.custody, provider: owner.provider, dispose() {
    // A failing Host disposal keeps the borrowed lifetimes reachable for retry.
    owner.dispose();
    for (const joined of retained.values()) {joined.dispose();}
  }});
};
