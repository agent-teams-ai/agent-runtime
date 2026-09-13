// Test-only trusted bootstrap wiring. Import and construction perform no I/O.
import {createPostgresCredentialRenderingOwner} from
  "@agent-teams/provider-access/composition";
import type {OperationCredentialMaterial} from
  "@agent-teams/provider-access/composition";
import type {LinuxCodexDeploymentInfrastructure} from "../../../dist/composition/linux-codex-deployment.js";

type Factory = LinuxCodexDeploymentInfrastructure["createProviderAccess"];
type Pool = Parameters<typeof createPostgresCredentialRenderingOwner>[0];
export interface LinuxCodexOwnedPaMaterial {
  readonly material: OperationCredentialMaterial;
  readonly operationAbortSignal: AbortSignal;
  /** Absolute performance.now() deadline, independently fixed for this operation. */
  readonly deadline: number;
}

const validateMaterialBinding = (material: OperationCredentialMaterial, acknowledged: Parameters<Factory>[1]): void => {
  const subject = acknowledged.input.subject;
  const binding = material.binding;
  const current = acknowledged.current.binding;
  const receipt = acknowledged.providerAccessReceipt;
  if (material.recipe !== "codex-chatgpt" || material.operationRef !== subject.operationId || binding.provider !== "codex" ||
    binding.availability !== "available" || binding.revocation !== "active" ||
    binding.tenantId !== subject.scope.tenantId || binding.projectId !== subject.scope.projectId ||
    binding.scopeDigest !== subject.scopeDigest || receipt.operationId !== subject.operationId ||
    binding.credentialGeneration !== receipt.authorityFacts.credentialGeneration ||
    binding.credentialBindingDigest !== receipt.authorityFacts.authorityHeadDigest ||
    (Object.keys(binding) as (keyof typeof binding)[]).some(key => binding[key] !== current[key])) {
    throw new TypeError("Material binding mismatch");
  }
};

/** Trusted administration supplies independently selected material and lifetime by
 * operation ID. Selection transfers exclusive custody of dedicated byte arrays,
 * even on failure; it must erase unreturned material if it throws. No discovery,
 * request-derived approval, head publication, migration or acquisition fallback.
 * The deployment callback has no signal/deadline slots, so administration must
 * supply the actual operation cancellation signal and fixed deadline here.
 */
export const createLinuxCodexPaRenderingFactory = (pool: Pool,
  takeOwnedMaterial: (operationId: string) => LinuxCodexOwnedPaMaterial,
): Factory => (input, acknowledged) => {
  let owned: LinuxCodexOwnedPaMaterial | undefined;
  let pa: ReturnType<typeof createPostgresCredentialRenderingOwner> | undefined;
  try {
    const subject = acknowledged.input.subject;
    if (input.kernel.operationId !== subject.operationId || input.kernel.attemptId !== subject.attemptId ||
        input.kernel.custodyId !== subject.custodyId) {throw new TypeError("PA rendering selection rejected");}
    owned = takeOwnedMaterial(subject.operationId);
    const {material, operationAbortSignal, deadline} = owned;
    // Constructing PA snapshots/validates the exact binding; admission below
    // performs PA's existing material validation and exclusive buffer transfer.
    pa = createPostgresCredentialRenderingOwner(pool, {operationRef: subject.operationId,
      binding: material.binding, recipe: material.recipe, operationAbortSignal, deadline});
    validateMaterialBinding(material, acknowledged);
    if (pa.control.materialAdmission?.admit(material).kind !== "admitted") {throw new TypeError("PA rendering selection rejected");}
    return pa.owner;
  } catch {
    try {pa?.owner.dispose();} catch { /* Keep diagnostics independent of owner errors. */ } finally {
      // PA erases transferred buffers; the producer still owns attached buffers
      // on constructor/admission rejection. Trusted input is ordinary data only.
      for (const field of owned?.material.fields ?? []) {
        try {Uint8Array.prototype.fill.call(field.valueBytes, 0);} catch { /* Already detached by PA. */ }
      }
    }
    throw new TypeError("Linux Codex PA rendering unavailable");
  }
};
