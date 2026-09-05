/**
 * Only the kernel submits, prepares, claims, starts, drains, and terminalizes.
 * This seam is also exercised with provider-free owners; it never builds proof
 * fields or retries submission. Unknown/cancelled outcomes remain typed views.
 * @param {{dependencies: import('../../../../dist/features/contained-agent-turn/internal.js').ContainedTurnFeatureDependencies,
 * owner: Pick<import('../../../../dist/features/contained-agent-turn/internal.js').CodexCurrentKernelOwner, 'dispose'>,
 * command: import('../../../../dist/features/contained-agent-turn/contracts/contained-agent-turn.js').SubmitContainedTurnInput}} input
 */
export const submitContainedTurnLiveCanary = async input => {
  const { createContainedTurnFeature } = await import("../../../../dist/features/contained-agent-turn/internal.js");
  let failed = false;
  let failure;
  let result;
  try {
    result = await submitAndVerifyCanary(input, createContainedTurnFeature);
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    await input.owner.dispose();
  } catch (error) {
    // Disposal cannot replace the kernel's primary failure or authorize a start.
    if (!failed) {throw error;}
  }
  if (failed) {throw failure;}
  return result;
};

const submitAndVerifyCanary = async (input, createContainedTurnFeature) => {
  const feature = createContainedTurnFeature(input.dependencies);
  const outcome = await feature.submit.execute(input.command);
  if (outcome.status !== "observed") {
    throw new Error(`canary command not observed: ${outcome.status}`);
  }
  const turn = outcome.turn;
  for (const [cursor, chunk] of turn.output.entries()) {
    if (chunk.cursor !== cursor) {throw new Error("canary output is not zero-based and contiguous");}
  }
  const { containedTurnIdentity } = await import("../../../../dist/features/contained-agent-turn/domain/contained-turn-identities.js");
  const operation = await input.dependencies.operationStore.read({
    operationId: containedTurnIdentity("operation", turn.operationId), scope: input.command.scope,
  });
  if (operation === undefined || operation.commandId !== turn.commandId ||
      operation.effectId !== turn.effectId || operation.commandId !== input.command.commandId) {
    throw new Error("canary durable identity mismatch");
  }
  if (turn.status === "succeeded" && (operation.terminal.kind !== "final" ||
      turn.artifactManifestRef === undefined || turn.resultRef === undefined ||
      !operation.proofs.some(proof => proof.kind === "output_drain") ||
      !operation.proofs.some(proof => proof.kind === "terminal_truth"))) {
    throw new Error("canary success lacks durable drain, artifact, or terminal evidence");
  }
  return Object.freeze({physicalContainment: operation.physicalContainment.kind === "contained"
    ? operation.physicalContainment : Object.freeze({kind: "indeterminate"}), turn});
};
