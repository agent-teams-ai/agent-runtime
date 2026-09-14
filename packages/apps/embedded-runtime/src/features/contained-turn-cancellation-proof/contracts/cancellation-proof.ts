export type CancellationProof =
  | Readonly<{ kind: "contract_violation" }> | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "nonterminal"; status: "accepted" | "reconcile_required" | "running" }>
  | Readonly<{ kind: "operation_mismatch" }> | Readonly<{
    kind: "terminal"; status: "cancelled" | "failed" | "succeeded";
  }>;
