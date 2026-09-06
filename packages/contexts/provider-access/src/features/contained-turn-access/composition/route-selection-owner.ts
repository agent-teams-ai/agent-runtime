import { createPostgresMaterializationRepository } from "../adapters/outbound/postgres/materialization-postgres-repository.js";
import { routeSelectionDigest, snapshotRouteSelectionFacts, type RouteSelectionCurrent,
  type RouteSelectionFacts } from "../adapters/outbound/postgres/route-selection-data.js";
import type { MaterializationPostgresPool, MaterializationPostgresTimeouts } from "../adapters/outbound/postgres/materialization-postgres-transactions.js";
import { credentialData, exactCredentialData } from "../adapters/outbound/credential-rendering-bytes.js";
import { CredentialRenderingLifetime, signalAborted } from "../adapters/outbound/credential-rendering-lifetime.js";

const snapshotTimeouts = (input: Partial<MaterializationPostgresTimeouts> | undefined): Partial<MaterializationPostgresTimeouts> => {
  if (input === undefined) {return {};}
  const data = credentialData(input);
  if (Object.keys(data).some(key => !["connectionMs", "statementMs", "transactionMs"].includes(key))) {throw new TypeError("Invalid PA route timeouts");}
  return Object.freeze(Object.fromEntries(Object.entries(data).map(([key, value]) => [key, value.value]))) as Partial<MaterializationPostgresTimeouts>;
};

export type RouteSelectionInput = RouteSelectionFacts & Readonly<{deadline: number; operationAbortSignal: AbortSignal}>;
/**
 * Trusted PA composition control only, never initialized from HTTP input. The pool
 * is borrowed. Construction only snapshots data; neither reads nor migration endorse.
 * The durable immutable association is pinned to the current PA CAS head. Any generic
 * binding replacement invalidates it, including same-revision credential replacement;
 * generic replacement remains accepted, but a new route endorsement needs a new revision.
 */
export const createPostgresRouteSelectionOwner = (pool: MaterializationPostgresPool, input: RouteSelectionInput,
  timeouts?: Partial<MaterializationPostgresTimeouts>) => {
  const data = exactCredentialData(input, ["binding", "recipe", "descriptor", "deadline", "operationAbortSignal"]);
  const facts = snapshotRouteSelectionFacts({binding: data.binding?.value, recipe: data.recipe?.value, descriptor: data.descriptor?.value});
  const deadline: unknown = data.deadline?.value;
  const signal = data.operationAbortSignal?.value as AbortSignal;
  signalAborted(signal);
  if (typeof deadline !== "number" || !Number.isFinite(deadline) || deadline <= 0 || deadline - performance.now() > 2_147_483_647) {
    throw new TypeError("Invalid PA route deadline");
  }
  const store = createPostgresMaterializationRepository(pool, snapshotTimeouts(timeouts));
  let closed = false;
  const check = () => {
    if (closed || signalAborted(signal) || performance.now() >= deadline) {
      closed = true; store.dispose(); throw new Error("PA route owner is closed");
    }
  };
  const perform = async <T>(work: (checkOpen: () => void) => Promise<T>): Promise<T> => {
    check();
    const lifetime = new CredentialRenderingLifetime(signal, deadline);
    const checkOpen = () => {check(); lifetime.check();};
    try {const result = await lifetime.wait(work(checkOpen)); checkOpen(); return result;}
    finally {lifetime.close();}
  };
  const expected = async (): Promise<RouteSelectionCurrent> => Object.freeze({...facts,
    routeGeneration: String(facts.binding.bindingRevision), routeAuthorityDigest: await routeSelectionDigest(facts)});
  return Object.freeze({
    async readCurrent(): Promise<RouteSelectionCurrent | undefined> {
      try {return await perform(async checkOpen => store.routeSelection.readCurrent(await expected(), checkOpen));}
      catch {return undefined;}
    },
    control: Object.freeze({
      migrate: () => perform(async checkOpen => {await store.migrate(); checkOpen(); await store.routeSelection.migrate(checkOpen);}),
      endorse: (expectedHeadVersion: number): Promise<RouteSelectionCurrent> => perform(async checkOpen => {
        if (!Number.isSafeInteger(expectedHeadVersion) || expectedHeadVersion < 1) {throw new TypeError("Invalid PA route head version");}
        const result = await store.routeSelection.endorse(await expected(), expectedHeadVersion, checkOpen);
        if (!result) {throw new Error("PA route selection is not current or conflicts with immutable endorsement");}
        return result;
      }),
    }),
    dispose() {closed = true; store.dispose();},
  });
};
