import type { ContainedTurnEgressRequest, ContainedTurnEgressResult } from "../domain/egress-request.js";

export interface ContainedTurnEgress {
  exchange(request: ContainedTurnEgressRequest): Promise<ContainedTurnEgressResult>;
  dispose(): Promise<"closed" | "quarantined">;
}
