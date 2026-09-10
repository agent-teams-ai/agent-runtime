// TEST ONLY: synthetic producer facts with real Host authority and launch-plan provenance.
export * from "./synthetic-native-custody-producer.fixture.ts";
export {markDarwinNativeRootLaunchPlan}
  from "../../../src/features/contained-agent-turn/adapters/outbound/host-custody/host-custody-launch.ts";
export {withNativeHostCustodyWorkspaceAuthority, retireNativeHostCustodyWorkspaceAuthority}
  from "../../../src/features/contained-agent-turn/adapters/outbound/host-custody/native-host-custody-workspace-authority.ts";
