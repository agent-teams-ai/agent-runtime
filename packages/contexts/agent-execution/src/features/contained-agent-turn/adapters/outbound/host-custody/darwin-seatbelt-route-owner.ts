import { lstatSync, realpathSync } from "node:fs";
import type { NodeCustodyHttpLifetime } from "./node-provider-process-custody-http-reservation.js";
import type { LiveCustody } from "./node-provider-process-custody-state.js";
import type { FinalHostLaunch } from "./host-launch-finalization.js";
import type { HostHttpEgressSessionDependencies } from "./egress/host-http-egress-session.js";
import type { HttpEgressRouteFirstWrite } from "./egress/http-egress-ports.js";
import type { HostHttpLocalCutInput } from "./egress/host-http-local-cut-owner.js";
import { DarwinRouteLifecycleJournal } from "./darwin-route-lifecycle-journal.js";
import { captureDarwinOwnedImage, observeDarwinGuardian, type DarwinOwnedImage } from "./darwin-seatbelt-process-identity.js";
import { isIssuedDarwinSeatbeltProjection, recheckDarwinExecutable, type DarwinExecutablePin, type DarwinSeatbeltProjection } from "./darwin-seatbelt-launch-projection.js";

import { issueDarwinRouteIdentity } from "./darwin-route-identity.js";

const rejected = (): never => {throw new TypeError("Darwin same-reservation route sealed or conflicts");};
/** Alternative Host implementation, private candidate composition; this is not
 * Consumer Assembly adoption, a product issuer or physical containment. */
export class DarwinSeatbeltRouteOwner {
  #live: LiveCustody | undefined;
  #state: "reserved" | "launch-authorized" | "installed" | "cut" | "released" | "quarantined" = "reserved";
  #projection: DarwinSeatbeltProjection | undefined; #final: FinalHostLaunch | undefined;
  #session: HostHttpEgressSessionDependencies | undefined; #lastTime = -1;
  #guardianImage: DarwinOwnedImage | undefined; #providerImage: DarwinOwnedImage | undefined;
  #preparation: Promise<void> | undefined; #cleanup: Promise<boolean> | undefined;
  #guardianAttempted = false;
  readonly #requests = new Set<string>();
  public constructor(public readonly lifetime: NodeCustodyHttpLifetime,
    public readonly journal: DarwinRouteLifecycleJournal,
    readonly localCut: Omit<HostHttpLocalCutInput, "claimed" | "identity">,
    readonly closureDeadline: number, readonly owned: Readonly<{node: DarwinExecutablePin;
      /** Borrowed provider observation; route authorization remains local. */
      nativeLaunch(plan: FinalHostLaunch["plan"]): Readonly<{recipe: Readonly<{endpoint: string}>}>;
      files(): Promise<boolean>}>) {issueDarwinRouteIdentity(this);}
  public get pending(): Promise<void> | undefined {return this.#preparation;}
  public get projection(): DarwinSeatbeltProjection {if (this.#projection === undefined) {return rejected();} return this.#projection;}
  public get state(): string {return this.#state;}
  public prepareGuardianAllocation(maximum: number): Readonly<{
    acknowledgementAfterMs: number; projection: DarwinSeatbeltProjection;
  }> {
    this.assertLaunch(this.#final);
    if (this.#guardianAttempted || this.#final === undefined) {return rejected();}
    const acknowledgementAfterMs = Math.min(maximum, this.localCut.operationDeadline - this.#lastTime);
    if (acknowledgementAfterMs <= 0) {return rejected();}
    const projection = this.projection;
    this.journal.storage.assertIntact(); this.assertActive();
    this.#guardianAttempted = true; this.journal.guardianIntent();
    return Object.freeze({acknowledgementAfterMs, projection});
  }
  public attach(live: LiveCustody): void {
    if (this.#live !== undefined || live.plan?.provider !== "codex" || live.plan.intentMode !== "analysis" ||
        live.plan.containmentProfile !== "cooperative-darwin-posix-process-group" ||
        live.httpReservation.executionSessionIdentity !== this.lifetime.executionSessionIdentity) {rejected();}
    live.httpReservation.assertPreparation(this.lifetime); this.#live = live;
  }
  /** Compare the supplied name with the actual reservation's retained directory.
   * This remains name-bound observation, not same-UID namespace exclusion. */
  public assertWritableTmp(path: string): void {
    const live = this.#live; const plan = live?.plan;
    const retained = live?.privatePaths?.byEnvironmentKey.TMPDIR;
    const overlaps = (other: string) => path === other || path.startsWith(`${other}/`) || other.startsWith(`${path}/`);
    if (plan === undefined || retained === undefined || path !== plan.environment.TMPDIR || path !== retained.path ||
        overlaps(plan.environment.CODEX_HOME ?? "/") || overlaps(live!.workspaceRef) || realpathSync(path) !== path) {return rejected();}
    const current = lstatSync(path, {bigint: true});
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== retained.dev || current.ino !== retained.ino ||
        current.uid !== retained.uid || current.mode !== retained.mode || current.ctimeNs !== retained.ctimeNs) {rejected();}
  }
  public run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#preparation !== undefined || this.#live === undefined) {return Promise.reject(new TypeError("Darwin route preparation conflicts"));}
    const done = Promise.withResolvers<void>(); this.#preparation = done.promise;
    return (async () => {try {this.assertActive(); return await operation();}
      catch (error) {this.cutoff(); throw error;} finally {done.resolve();}})();
  }
  public assertActive(): void {
    try {
      if (!["reserved", "launch-authorized", "installed"].includes(this.#state) || this.lifetime.signal.aborted ||
          this.localCut.hostShutdownSignal?.aborted) {rejected();}
      const clock = this.localCut.clock.read();
      if (clock.authorityId !== this.localCut.expectedClock.authorityId || clock.epoch !== this.localCut.expectedClock.epoch ||
          !Number.isSafeInteger(clock.controlTime) || clock.controlTime < this.#lastTime || clock.controlTime < 0 ||
          clock.controlTime >= this.localCut.operationDeadline) {rejected();}
      this.#lastTime = clock.controlTime;
      // Reentrant borrowed clock cannot revive a cut performed during read().
      if (this.lifetime.signal.aborted || !["reserved", "launch-authorized", "installed"].includes(this.#state)) {rejected();}
    } catch (error) {this.cutoff(); throw error;}
  }
  public authorize(projection: DarwinSeatbeltProjection): void {
    this.assertActive();
    if (this.#state !== "reserved" || this.#projection !== undefined || !isIssuedDarwinSeatbeltProjection(projection)) {rejected();}
    if (projection.writePaths.length !== 1) {rejected();}
    this.assertWritableTmp(projection.writePaths[0]!);
    const plan = this.#live!.plan!;
    if (projection.provider.path !== plan.executablePath || projection.provider.sha256 !== plan.executableSha256) {rejected();}
    this.journal.record("launch_profile_authorized", {projectionDigest: projection.digest,
      profileSha256: projection.profileSha256, endpoint: projection.endpoint, launcher: projection.launcher,
      observer: projection.observer, provider: projection.provider, descriptors: [0, 1, 2]});
    this.assertActive(); this.#projection = projection; this.#state = "launch-authorized";
  }
  public bindSession(dependencies: HostHttpEgressSessionDependencies): void {
    this.assertActive();
    if (this.#session !== undefined || dependencies.routeFirstWrite !== this.firstWrite ||
        dependencies.identity.liveProcessSessionIdentity !== this.lifetime.executionSessionIdentity) {rejected();}
    this.#session = dependencies;
  }
  public bindFinal(final: FinalHostLaunch): void {
    this.assertLaunch();
    if (this.#final !== undefined || this.#session === undefined) {rejected();}
    this.assertWritableTmp(this.projection.writePaths[0]!);
    if (final.plan.environment.TMPDIR !== this.projection.writePaths[0]) {rejected();}
    const native = this.owned.nativeLaunch(final.plan);
    if (native.recipe.endpoint !== `http://127.0.0.1:${this.projection.endpoint.port}/backend-api/codex`) {rejected();}
    this.journal.record("finalized", {fingerprint: final.fingerprint.fingerprintSha256, material: final.materialSha256});
    this.assertActive(); this.#final = final;
  }
  public assertLaunch(final?: FinalHostLaunch): void {
    this.assertActive();
    if (this.#state !== "launch-authorized" || final !== undefined && final !== this.#final) {rejected();}
    for (const pin of [this.projection.provider, this.projection.launcher, this.projection.observer, this.owned.node]) {
      recheckDarwinExecutable(pin);
    }
    this.journal.storage.assertIntact(); this.assertActive();
  }
  public beforeLaunch(): boolean {
    try {
      this.assertLaunch(this.#final);
      const guardian = this.#live!.guardian;
      if (!this.#guardianAttempted || guardian === undefined) {return false;}
      this.#guardianImage = observeDarwinGuardian(guardian.child, this.projection.observer, this.owned.node);
      this.journal.record("guardian_observed", this.#guardianImage);
      this.journal.record("provider_exec_intent", {guardian: this.#guardianImage, projection: this.projection.digest});
      this.assertActive(); return true;
    } catch {this.cutoff(); return false;}
  }
  public install(value: unknown): void {
    this.assertLaunch(this.#final);
    const live = this.#live!; const guardian = live.guardian;
    if (guardian === undefined || guardian.child.pid === undefined || live.providerPid === undefined ||
        live.identity.status !== "proved" || live.spawnStatus !== "acknowledged" || this.#guardianImage === undefined) {rejected();}
    const image = captureDarwinOwnedImage(value, live.providerPid!, guardian!.child.pid!, this.projection.provider);
    if (image.pgid !== guardian!.child.pid || guardian!.providerExit !== undefined) {rejected();}
    this.journal.record("final_image_installed", {image, projection: this.projection.digest,
      fingerprint: this.#final!.fingerprint.fingerprintSha256});
    this.assertActive(); this.#providerImage = image; this.#state = "installed";
  }
  public installNative(): void {
    this.assertLaunch(this.#final);
    if (this.#guardianAttempted || this.#providerImage !== undefined || this.#state !== "launch-authorized") {rejected();}
    this.journal.record("native_final_image_observed", {fingerprint: this.#final!.fingerprint.fingerprintSha256});
    this.assertActive(); this.#state = "installed";
  }
  public assertInstalled(): void {
    this.assertActive();
    if (this.#state !== "installed" || this.#guardianAttempted && this.#providerImage === undefined ||
        this.#live!.guardian?.providerExit !== undefined ||
        this.#live!.launchBinding.view.readFinal() !== this.#final) {this.cutoff(); rejected();}
  }
  public readonly firstWrite: HttpEgressRouteFirstWrite = Object.freeze({reserve: (requestId: string) => {
    try {
      this.assertInstalled();
      if (typeof requestId !== "string" || requestId.length < 1 || requestId.length > 128 ||
          this.#requests.has(requestId) || this.#requests.size >= 256) {rejected();}
      this.#requests.add(requestId); let burned = false;
      return Object.freeze({consume: () => {
        if (burned) {this.cutoff(); return false;} burned = true;
        try {this.assertInstalled(); return true;} catch {this.cutoff(); return false;}
      }});
    } catch (error) {this.cutoff(); throw error;}
  }});
  public cutoff(): void {
    if (["cut", "released", "quarantined"].includes(this.#state)) {return;}
    this.#state = "cut";
    this.#live?.httpReservation.cutoff();
    this.#live?.guardian?.stopDarwin();
    this.journal.cutoff();
  }
  public cleanup(resources: () => Promise<boolean>): Promise<boolean> {
    if (this.#cleanup !== undefined) {return this.#cleanup;}
    const done = Promise.withResolvers<boolean>(); this.#cleanup = done.promise; this.cutoff();
    void (async () => {
      await this.#preparation;
      if (this.#guardianAttempted) {
        const guardian = this.#live!.guardian;
        if (guardian === undefined) {return false;}
        const closed = await this.localCut.clock.within(this.closureDeadline, async () => {
          await guardian.guardianExit;
          const streams = await Promise.all([guardian.streamFinal("stdout"), guardian.streamFinal("stderr")]);
          return guardian.providerExit !== undefined && streams.every(status => status === "complete");
        });
        if (!closed) {return false;}
        this.journal.processesClosed();
      }
      const resourcesReleased = await resources();
      if (!resourcesReleased) {return false;}
      const filesReleased = await this.owned.files();
      const released = await this.journal.close(filesReleased);
      this.#state = released ? "released" : "quarantined"; return released;
    })().then(result => {
      if (!result) {this.#cleanup = undefined;} done.resolve(result); return;
    }, () => {this.#cleanup = undefined; done.resolve(false); return;});
    return done.promise;
  }
}
