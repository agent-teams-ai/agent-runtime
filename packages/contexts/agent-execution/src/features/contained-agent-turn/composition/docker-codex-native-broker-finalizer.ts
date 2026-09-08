import {custodyDataRecord, isHostCustodyDataCallback, hostLaunchFinalizationRecipe, retainFinalizationHttpResources,
  hostHttpAbortOperations, type HostHttpEgressSessionDependencies}
  from "../adapters/outbound/host-custody/contained-turn-kernel-custody-entrypoint.js";
import {assertDockerPreparedIoLaunch, dockerProviderProcessMountFacts}
  from "../adapters/outbound/host-custody/docker/docker-provider-process-entrypoint.js";
import {createCodexNativeBrokerRecipe, prepareCodexNativeBrokerFiles, isCodexNativeBrokerLaunchPlan,
  isIssuedCodexAppServerLaunchPlan, type CodexNativeBrokerRecipe}
  from "../adapters/outbound/codex-app-server/codex-app-server-launch-plan.js";
import type {CreateDockerCodexHostKernelOwnerOptions} from "./docker-codex-host-kernel-owner.js";
import type {DockerHostHttpResources} from "./docker-host-http-resources.js";
import type {DockerLinuxOperationRouteAdmission} from "./docker-linux-post-claim-preparation.js";
import {retainDockerNativeBrokerRoute} from "./docker-native-broker-route.js";

type Finish = NonNullable<CreateDockerCodexHostKernelOwnerOptions["finishClaimed"]>;
type Session = ReturnType<DockerHostHttpResources["bindSession"]>;
export interface DockerCodexNativeBrokerFinalizerInput {
  readonly routeAdmission: DockerLinuxOperationRouteAdmission;
  /** Existing private broker owners, including PA, RS and credential rendering.
   * HTTP custody replaces identity, consumption and local-cut slots with its own. */
  readonly session: HostHttpEgressSessionDependencies;
  /** Installs only the renderer's non-secret config and pinned catalog into the
   * retained private home. File issuance below independently checks exact bytes.
   * This owner retains any partial-file cleanup debt through custody cleanup. */
  readonly cutoffNativeFiles: () => void;
  readonly nativeFiles: Readonly<{install(recipe: CodexNativeBrokerRecipe): Promise<void>}>;
}
const apply = Reflect.apply;
const rejected = () => new TypeError("Docker Codex native broker finalization unavailable");

const assertProviderSelection = (
  selected: NonNullable<ReturnType<typeof hostLaunchFinalizationRecipe>>["providerAccess"],
  expected: HostHttpEgressSessionDependencies["providerAccessSnapshot"],
  proof: Parameters<Finish>[0]["claimed"]["committedDispatchProof"],
): void => {
  if (proof.provider !== "codex" || expected.tenantId !== proof.tenantId || expected.projectId !== proof.projectId ||
    Object.entries(selected).some(([key, fact]) => expected[key as keyof typeof expected] !== fact)) {throw rejected();}
};

/** One operation, private Pure DI. Construction only captures owners. Use the
 * returned routeAdmission in preparation, finishClaimed in the kernel owner and
 * execute in the retained Host HTTP connection consumer. No secret is returned
 * by that consumer; only the kernel receives the issued native launch plan.
 * Independent image provenance and private-root closure remain separate owners. */
export const createDockerCodexNativeBrokerFinalizer = (value: DockerCodexNativeBrokerFinalizerInput) => {
  const input = custodyDataRecord(value);
  const cutoffMethod = input.cutoffNativeFiles;
  if (!isHostCustodyDataCallback(cutoffMethod)) {throw rejected();}
  const cutoffNativeFiles = () => apply(cutoffMethod, value, []);
  const files = custodyDataRecord(input.nativeFiles);
  if (typeof files.install !== "function") {throw rejected();}
  const installMethod = files.install;
  const install: DockerCodexNativeBrokerFinalizerInput["nativeFiles"]["install"] = recipe =>
    apply(installMethod, input.nativeFiles, [recipe]);
  const dependencies = custodyDataRecord(input.session);
  const expected = custodyDataRecord(dependencies.providerAccessSnapshot);
  if (expected.provider !== "codex") {throw rejected();}
  // Checks every independent broker owner before any route/listener/file effect.
  const sessionInput = retainFinalizationHttpResources(dependencies, expected);
  if (sessionInput.route.requestProfile !== "codex-chatgpt-responses/v1") {throw rejected();}
  const route = retainDockerNativeBrokerRoute(input.routeAdmission);
  let entered = false;
  let cut = false;
  let session: Session | undefined;
  let cutHttp: (() => void) | undefined;
  let subscription: ReturnType<typeof hostHttpAbortOperations.subscribe> | undefined;
  const cutoff = () => {
    cut = true;
    try {cutoffNativeFiles();} finally {
    try {session?.close();} finally {
      try {cutHttp?.();} finally {
        if (subscription !== undefined) {hostHttpAbortOperations.remove(subscription); subscription = undefined;}
      }
    }
    }
  };
  const finishClaimed: Finish = async supplied => {
    if (entered || cut) {throw rejected();}
    entered = true;
    try {
      const request = custodyDataRecord(supplied);
      // Retain the existing HTTP owner, never a second HTTP/session lifetime.
      const http = request.http;
      cutHttp = http.cutoff.bind(http);
      const openIngress = http.openIngress.bind(http);
      const bindSession = http.bindSession.bind(http);
      const claimed = custodyDataRecord(request.claimed);
      const proof = custodyDataRecord(claimed.committedDispatchProof);
      const original = request.originalPlan;
      const recipeOwner = hostLaunchFinalizationRecipe(original);
      if (recipeOwner === undefined || !isIssuedCodexAppServerLaunchPlan(original)) {throw rejected();}
      assertProviderSelection(recipeOwner.providerAccess, expected, proof);
      if (original.containmentProfile !== "strict-linux-cgroup-v2" ||
        (["tenantId", "projectId", "operationId", "attemptId", "custodyId", "hostInstanceId", "hostBootId"] as const)
          .some(key => request.launch.key[key] !== proof[key])) {throw rejected();}
      assertDockerPreparedIoLaunch(request.providerIo, request.launch);
      const mounts = dockerProviderProcessMountFacts(request.launch);
      const record = custodyDataRecord(request.record);
      if (mounts.privateRootSource !== original.privateRootPath || mounts.workspaceSource !== original.workspaceRef ||
        record.privateRootPath !== original.privateRootPath || record.tmpDir !== original.tmpDir ||
        record.executablePath !== original.executablePath || record.boundary.codexHome !== original.codexHome ||
        record.boundary.workspaceRef !== original.workspaceRef) {throw rejected();}
      const active = () => {
        if (cut || hostHttpAbortOperations.aborted(claimed.signal)) {throw rejected();}
        assertDockerPreparedIoLaunch(request.providerIo, request.launch);
        dockerProviderProcessMountFacts(request.launch);
        route.endpoint(request.launch.authority, request.routeFirstWrite, http.gateway);
      };
      active();
      subscription = hostHttpAbortOperations.subscribe(claimed.signal, cutoff);
      const endpoint = route.endpoint(request.launch.authority, request.routeFirstWrite, http.gateway);
      const recipe = createCodexNativeBrokerRecipe({boundary: record.boundary, endpoint,
        profile: "codex-chatgpt", dockerMounts: mounts});
      const firstWrite = custodyDataRecord(request.routeFirstWrite);
      if (typeof firstWrite.reserve !== "function") {throw rejected();}
      const reserve = firstWrite.reserve.bind(request.routeFirstWrite);
      const ingress = openIngress();
      await install(recipe);
      active();
      const preparedFiles = await prepareCodexNativeBrokerFiles(recipe);
      active();
      // The capability never crosses an installer, callback or public DTO. The
      // original provider-issued builder is its sole native-material consumer.
      const built = recipeOwner.build({recipe, files: preparedFiles}, ingress.nativeBearerToken());
      built.validate();
      if (!isIssuedCodexAppServerLaunchPlan(built.plan) || !isCodexNativeBrokerLaunchPlan(built.plan)) {throw rejected();}
      session = bindSession({...sessionInput, routeFirstWrite: Object.freeze({reserve})});
      active(); built.validate(); ingress.nativeBearerToken();
      return Object.freeze({plan: built.plan});
    } catch {
      cutoff();
      throw rejected();
    }
  };
  return Object.freeze({routeAdmission: route.routeAdmission, finishClaimed, cutoff,
    async execute(operation: Parameters<Session["execute"]>[0]) {
      if (cut || session === undefined) {throw rejected();}
      try {
        const receipt = await session.execute(operation);
        if (receipt.outcome !== "completed") {cutoff();}
        return receipt;
      } catch {cutoff(); throw rejected();}
    },
  });
};
