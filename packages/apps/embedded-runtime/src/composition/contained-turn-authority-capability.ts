import type { ContainedTurnCapabilityBundle } from "./contained-turn-runtime-access.js";
import type { ContainedTurnCompositionOperationRef } from "./contained-turn-operation-ref.js";
import {
  copyContainedTurnAccessAuthority,
  matchesContainedTurnAccessAuthority,
  type ContainedTurnAccessAuthority,
} from "./contained-turn-access-authority.js";
import { contractViolation } from "./contained-turn-runtime-validation.js";

const { types } = process.getBuiltinModule("node:util");

export interface AuthorityBoundOperationRef extends ContainedTurnCompositionOperationRef {
  readonly authority: ContainedTurnAccessAuthority;
}

export interface AuthorityBoundContainedTurnCapability {
  readonly authorityRevision: string;
  readonly cancel: {
    execute(input: AuthorityBoundOperationRef, options?: { readonly signal?: AbortSignal }): Promise<unknown>;
  };
  readonly observe: {
    execute(input: AuthorityBoundOperationRef): Promise<unknown>;
  };
  readonly submit: {
    execute(
      input: Parameters<ContainedTurnCapabilityBundle["submit"]["execute"]>[0] & {
        readonly authority: ContainedTurnAccessAuthority;
      },
      options?: {
        readonly onAccepted?: (operation: unknown) => void;
        readonly signal?: AbortSignal;
      },
    ): Promise<unknown>;
  };
}

const scopeOf = (authority: ContainedTurnAccessAuthority) => Object.freeze({
  projectId: authority.projectId, tenantId: authority.tenantId,
});

/**
 * Trusted composition assigns a revision to the selected owner capability.
 * Rebinding/rotation requires a new composition product. The owner still owns
 * operation truth; this adapter only binds invocation authority to its DTOs.
 */
export const bindContainedTurnCapabilityAuthority = (
  owner: ContainedTurnCapabilityBundle,
  authorityRevision: string,
): AuthorityBoundContainedTurnCapability => {
  if (copyContainedTurnAccessAuthority({ authorityRevision, projectId: "probe", tenantId: "probe" }) === undefined) {
    throw new TypeError("Contained-turn access authority is invalid");
  }
  const cancellation = owner.cancel;
  const observation = owner.observe;
  const submission = owner.submit;
  const cancel = cancellation.execute.bind(cancellation);
  const observe = observation.execute.bind(observation);
  const submit = submission.execute.bind(submission);
  const boundAuthority = (input: {
    readonly authority: ContainedTurnAccessAuthority;
    readonly scope: ContainedTurnCompositionOperationRef["scope"];
  }): ContainedTurnAccessAuthority => {
    const authority = copyContainedTurnAccessAuthority(input.authority);
    if (authority === undefined || authority.authorityRevision !== authorityRevision ||
      authority.projectId !== input.scope.projectId || authority.tenantId !== input.scope.tenantId) {
      return contractViolation("malformed_owner_outcome");
    }
    return authority;
  };
  return Object.freeze({
    authorityRevision,
    cancel: Object.freeze({ async execute(input: Parameters<AuthorityBoundContainedTurnCapability["cancel"]["execute"]>[0], options?: { readonly signal?: AbortSignal }) {
      const authority = boundAuthority(input);
      const outcome = await cancel(Object.freeze({ operationId: input.operationId, scope: scopeOf(authority) }), options);
      return Object.freeze({ authority, outcome });
    } }),
    observe: Object.freeze({ async execute(input: AuthorityBoundOperationRef) {
      const authority = boundAuthority(input);
      const outcome = await observe(Object.freeze({ operationId: input.operationId, scope: scopeOf(authority) }));
      return Object.freeze({ authority, outcome });
    } }),
    submit: Object.freeze({ async execute(
      input: Parameters<AuthorityBoundContainedTurnCapability["submit"]["execute"]>[0],
      options?: Parameters<AuthorityBoundContainedTurnCapability["submit"]["execute"]>[1],
    ) {
      const authority = boundAuthority(input);
      const scope = scopeOf(authority);
      const outcome = await submit(Object.freeze({
        commandId: input.commandId, expectedProvider: input.expectedProvider, intent: input.intent, scope,
      }), {
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
        onAccepted: operation => {
          options?.onAccepted?.(Object.freeze({ authority, outcome: operation }));
        },
      });
      return Object.freeze({ authority, outcome });
    } }),
  });
};

/** Snapshot the envelope's data fields before any owner DTO can be projected. */
export const unwrapContainedTurnAuthorityOutcome = (
  value: unknown,
  bound: ContainedTurnAccessAuthority,
): unknown => {
  try {
    if (typeof value !== "object" || value === null || types.isProxy(value)) {
      return contractViolation("malformed_owner_outcome");
    }
    const authority = Object.getOwnPropertyDescriptor(value, "authority");
    const outcome = Object.getOwnPropertyDescriptor(value, "outcome");
    if (authority === undefined || !("value" in authority) ||
      outcome === undefined || !("value" in outcome) ||
      !matchesContainedTurnAccessAuthority(authority.value, bound)) {
      return contractViolation("malformed_owner_outcome");
    }
    return outcome.value;
  } catch {
    return contractViolation("malformed_owner_outcome");
  }
};
