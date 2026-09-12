// Only the executable byte observation is synthetic. The actual path verifier,
// immutable fingerprints, reservation and finalization owners remain in use.
const {stats} = Reflect.get(globalThis, Symbol.for("ar69-r205-native-launch-finalization-fixture")).get("executable-observations");
export * from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/host-custody-launch.js";
let gate: Promise<void> | undefined;
export const holdExecutableVerification = (pending?: Promise<void>) => {gate = pending;};
export const verifyExecutable = async (plan: {executablePath: string; executableSha256: string}) => {
  const before = stats(plan.executablePath, {bigint: true});
  await gate;
  return {...before, digest: plan.executableSha256};
};
