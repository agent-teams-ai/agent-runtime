import {dockerCustodyAttemptLocator, dockerCustodyAuthoritySha256} from "./journal/docker-custody-journal-codec.js";
import type {DockerCustodyAttemptKey, DockerCustodyJournalRecord} from "./journal/docker-custody-journal-types.js";
import type {DockerContainerAuthority, DockerEngineCall} from "./engine/docker-engine-port.js";
import {retainDockerImageInitOwner, type DockerImageInitOwner, type DockerImageInitHostBinding,
  type DockerImageInitWitness} from "./docker-image-init-owner.js";

export interface DockerLifecycleImageSelection {
  readonly owner: DockerImageInitOwner;
  readonly host: DockerImageInitHostBinding;
}

/** Volatile exact create authority and historical image readback. Never restart authority. */
export class DockerLifecycleAuthority {
  readonly #bindings = new Map<string, {authority: DockerContainerAuthority; sha256: string}>();
  readonly #images = new WeakMap<DockerContainerAuthority, DockerLifecycleImageSelection & {witness: DockerImageInitWitness}>();
  public constructor(private readonly maximum: number) {}
  public hold(key: DockerCustodyAttemptKey, authority: DockerContainerAuthority): string {
    const locator = dockerCustodyAttemptLocator(key);
    const sha256 = dockerCustodyAuthoritySha256(authority);
    if (!this.#bindings.has(locator) && this.#bindings.size >= this.maximum) {
      const oldest = this.#bindings.keys().next().value;
      if (oldest !== undefined) {this.#bindings.delete(oldest);}
    }
    this.#bindings.set(locator, {authority, sha256});
    return sha256;
  }
  public retained(key: DockerCustodyAttemptKey): DockerContainerAuthority | undefined {
    return this.#bindings.get(dockerCustodyAttemptLocator(key))?.authority;
  }
  public retire(key: DockerCustodyAttemptKey): void {this.#bindings.delete(dockerCustodyAttemptLocator(key));}
  public match(key: DockerCustodyAttemptKey, authority: DockerContainerAuthority, journal?: DockerCustodyJournalRecord):
    "match" | "mismatch" | "unavailable" {
    const expected = journal?.authoritySha256 ?? this.#bindings.get(dockerCustodyAttemptLocator(key))?.sha256;
    if (expected === undefined || expected === null) {return "unavailable";}
    return expected === dockerCustodyAuthoritySha256(authority) ? "match" : "mismatch";
  }
  public async verify(selection: DockerLifecycleImageSelection, authority: DockerContainerAuthority, call: DockerEngineCall): Promise<void> {
    const owner = retainDockerImageInitOwner(selection.owner);
    const host = Object.freeze({...selection.host});
    const witness = await owner.verifyCreated(authority, call);
    owner.assertWitness(witness, authority, host);
    this.#images.set(authority, {owner, host, witness});
  }
  public image(authority: DockerContainerAuthority, host: DockerImageInitHostBinding): DockerImageInitWitness {
    const retained = this.#images.get(authority);
    if (retained === undefined) {throw new TypeError("Docker created image witness unavailable");}
    retained.owner.assertWitness(retained.witness, authority, host);
    return retained.witness;
  }
}
