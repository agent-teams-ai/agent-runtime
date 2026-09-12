import { createImmutableHostCustodyLaunchPlan } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/custodied-provider-process.js";
import type { CodexAppServerLaunchPlan } from "../../../dist/features/contained-agent-turn/adapters/outbound/codex-app-server/codex-app-server-launch-plan.js";

/** Compile-only contract: never execute these intentional invalid operations. */
export const verifyImmutableLaunchTypes = (base: CodexAppServerLaunchPlan): void => {
  const plan = createImmutableHostCustodyLaunchPlan({
    ...base, arguments: [...base.arguments], environment: { ...base.environment },
    privatePathEnvironmentKeys: ["HOME"], metadata: { count: 1 },
    workspaceIdentity: { ...base.workspaceIdentity },
  });
  // @ts-expect-error returned argument arrays are immutable
  plan.arguments.push("--extra");
  // @ts-expect-error returned environment values are immutable
  plan.environment.HOME = "/changed";
  // @ts-expect-error returned private-path keys are immutable
  plan.privatePathEnvironmentKeys[0] = "TMPDIR";
  // @ts-expect-error returned flat metadata is immutable
  plan.metadata.count += 1;
  // @ts-expect-error named Codex directory identities are immutable
  plan.workspaceIdentity.inode += 1;
  // @ts-expect-error extra arrays are not supported launch metadata
  createImmutableHostCustodyLaunchPlan({ ...base, metadata: ["unsupported"] });
  // @ts-expect-error nested metadata records are unsupported
  createImmutableHostCustodyLaunchPlan({ ...base, metadata: { nested: { count: 1 } } });
  // @ts-expect-error executable metadata is unsupported
  createImmutableHostCustodyLaunchPlan({ ...base, metadata: () => 1 });
  const retainedNamedMetadata: CodexAppServerLaunchPlan = plan;
  void retainedNamedMetadata;
};
