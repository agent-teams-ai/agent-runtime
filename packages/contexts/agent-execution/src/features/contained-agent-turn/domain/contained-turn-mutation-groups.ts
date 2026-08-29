import type { ContainedTurnMutation } from "./contained-turn-operation.js";

export type MutationOf<Kind extends ContainedTurnMutation["kind"]> = Extract<
  ContainedTurnMutation,
  { readonly kind: Kind }
>;

export type WorkspaceMutation = MutationOf<"workspace_bound" | "workspace_closed" | "workspace_quarantined">;
export type DispatchMutation = MutationOf<"cancellation_requested" | "dispatch_claimed" | "dispatch_prevented">;
export type ProviderMutation = MutationOf<
  | "execution_closed"
  | "execution_started"
  | "execution_unknown"
  | "provider_acceptance_unknown"
  | "provider_accepted"
  | "provider_not_accepted"
>;
export type OutputMutation = MutationOf<"output_appended" | "output_sealed">;
export type ContainmentMutation = MutationOf<"containment_recorded" | "containment_unproven">;
export type EffectMutation = MutationOf<"effect_ambiguous" | "effect_resolved" | "reconciliation_required">;
export type PublicationMutation = MutationOf<"artifacts_sealed" | "result_published" | "terminalize">;

const WORKSPACE_MUTATIONS = new Set<ContainedTurnMutation["kind"]>([
  "workspace_bound",
  "workspace_closed",
  "workspace_quarantined",
]);
const DISPATCH_MUTATIONS = new Set<ContainedTurnMutation["kind"]>([
  "cancellation_requested",
  "dispatch_claimed",
  "dispatch_prevented",
]);
const PROVIDER_MUTATIONS = new Set<ContainedTurnMutation["kind"]>([
  "execution_closed",
  "execution_started",
  "execution_unknown",
  "provider_acceptance_unknown",
  "provider_accepted",
  "provider_not_accepted",
]);
const OUTPUT_MUTATIONS = new Set<ContainedTurnMutation["kind"]>([
  "output_appended",
  "output_sealed",
]);
const CONTAINMENT_MUTATIONS = new Set<ContainedTurnMutation["kind"]>([
  "containment_recorded",
  "containment_unproven",
]);
const EFFECT_MUTATIONS = new Set<ContainedTurnMutation["kind"]>([
  "effect_ambiguous",
  "effect_resolved",
  "reconciliation_required",
]);

export const isWorkspaceMutation = (mutation: ContainedTurnMutation): mutation is WorkspaceMutation =>
  WORKSPACE_MUTATIONS.has(mutation.kind);
export const isDispatchMutation = (mutation: ContainedTurnMutation): mutation is DispatchMutation =>
  DISPATCH_MUTATIONS.has(mutation.kind);
export const isProviderMutation = (mutation: ContainedTurnMutation): mutation is ProviderMutation =>
  PROVIDER_MUTATIONS.has(mutation.kind);
export const isOutputMutation = (mutation: ContainedTurnMutation): mutation is OutputMutation =>
  OUTPUT_MUTATIONS.has(mutation.kind);
export const isContainmentMutation = (mutation: ContainedTurnMutation): mutation is ContainmentMutation =>
  CONTAINMENT_MUTATIONS.has(mutation.kind);
export const isEffectMutation = (mutation: ContainedTurnMutation): mutation is EffectMutation =>
  EFFECT_MUTATIONS.has(mutation.kind);
