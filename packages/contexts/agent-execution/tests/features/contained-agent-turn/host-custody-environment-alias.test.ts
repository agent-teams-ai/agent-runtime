import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { NodeProviderProcessCustody as BaseNodeProviderProcessCustody } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/node-provider-process-custody.js";
import { hostCustodyLaunchTestSupport } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/host-custody-launch.js";
import { createStaticHostCustodyLaunchPlanResolver } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/static-host-custody-launch-plan-resolver.js";
import {
  binding,
  claudeBinding,
  disposableRoot,
  launchPlan,
  nextText,
  qualifiedIdentityObserver,
  syntheticResidueAuthorityFactory,
} from "../../host-custody-test-fixture.ts";

const linuxTest = process.platform === "linux" ? test : test.skip;

class NodeProviderProcessCustody extends BaseNodeProviderProcessCustody {
  public constructor(options: ConstructorParameters<typeof BaseNodeProviderProcessCustody>[0]) {
    super({
      identityObservationAfterMs: 60_000,
      residueAuthorityFactory: syntheticResidueAuthorityFactory,
      spawnAcknowledgementAfterMs: 60_000,
      ...options,
    });
  }

  public override open(input: Parameters<BaseNodeProviderProcessCustody["open"]>[0]) {
    return super.open({ intentMode: "analysis", ...input });
  }
}

linuxTest("qualified Codex HOME and CODEX_HOME alias shares one descriptor-bound child authority", async () => {
  const workspaceRef = await disposableRoot();
  const entry = await launchPlan({
    script: `process.stdout.write(JSON.stringify([process.env.CODEX_HOME, process.env.HOME, process.env.TMPDIR]) + "\\n")`,
    workspaceRef,
  });
  const home = entry.plan.environment.HOME;
  assert.ok(home);
  const aliasPlan = Object.freeze({
    ...entry.plan,
    environment: Object.freeze({ ...entry.plan.environment, CODEX_HOME: home }),
  });
  const custody = new NodeProviderProcessCustody({
    launchPlans: createStaticHostCustodyLaunchPlanResolver([{ plan: aliasPlan, providerBinding: binding }]),
    processIdentityObserver: qualifiedIdentityObserver,
  });
  const request = {
    attemptId: "attempt:codex-home-alias",
    operationId: "operation:codex-home-alias",
    providerBinding: binding,
    workspaceRef,
  } as const;
  const opened = await custody.open(request);
  const processHandle = custody.get(opened.custodyRef);
  assert.ok(processHandle);
  const environment = JSON.parse(await nextText(processHandle.stdout)) as [string, string, string];
  assert.equal(environment[0], environment[1]);
  assert.match(environment[0], /^\/proc\/\d+\/fd\/\d+$/u);
  assert.notEqual(environment[0], home);
  assert.notEqual(environment[2], environment[0]);
  assert.equal((await custody.requestContainment({ ...request, custodyRef: opened.custodyRef })).kind, "contained");
});

test("Codex rejects different-path inode aliases even for HOME and CODEX_HOME", async () => {
  const workspaceRef = await disposableRoot();
  const entry = await launchPlan({ workspaceRef });
  const observation = Object.freeze({
    ctimeNs: 1n,
    dev: 1n,
    ino: 30n,
    mode: 0o40700n,
    uid: 1000n,
  });
  assert.throws(() => hostCustodyLaunchTestSupport.assertQualifiedPrivateFilesystemObjects(
    entry.plan,
    { dev: 1n, ino: 10n },
    { dev: 1n, ino: 20n },
    {
      CODEX_HOME: { ...observation, path: "/private/config" },
      HOME: { ...observation, path: "/private/home" },
    },
  ), /distinct filesystem objects/u);
});

const assertRejectedWithoutProviderEffect = async (
  label: string,
  workspaceRef: string,
  plan: Awaited<ReturnType<typeof launchPlan>>["plan"],
  providerBinding: typeof binding | typeof claudeBinding = binding,
): Promise<void> => {
  const marker = join(workspaceRef, `${label}-provider-effect`);
  const effectPlan = Object.freeze({
    ...plan,
    arguments: Object.freeze([
      "-e",
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "effect")`,
    ]),
  });
  const custody = new NodeProviderProcessCustody({
    launchPlans: createStaticHostCustodyLaunchPlanResolver([{ plan: effectPlan, providerBinding }]),
  });
  const request = {
    attemptId: `attempt:${label}`,
    operationId: `operation:${label}`,
    providerBinding,
    workspaceRef,
  } as const;
  await assert.rejects(custody.open(request), { name: "HostCustodyLaunchRejectedError" });
  await assert.rejects(access(marker), { code: "ENOENT" });
};

linuxTest("private environment overlap remains rejected without provider effects", async () => {
  const cases = [
    {
      label: "tmpdir-home-overlap",
      mutate: (plan: Awaited<ReturnType<typeof launchPlan>>["plan"]) => ({
        ...plan.environment,
        TMPDIR: plan.environment.HOME,
      }),
    },
    {
      label: "workspace-overlap",
      mutate: (plan: Awaited<ReturnType<typeof launchPlan>>["plan"], workspaceRef: string) => ({
        ...plan.environment,
        HOME: workspaceRef,
      }),
    },
    {
      label: "private-root-overlap",
      mutate: (plan: Awaited<ReturnType<typeof launchPlan>>["plan"]) => ({
        ...plan.environment,
        HOME: plan.privateRootPath,
      }),
    },
  ] as const;
  for (const row of cases) {
    const workspaceRef = await disposableRoot();
    const entry = await launchPlan({ workspaceRef });
    await assertRejectedWithoutProviderEffect(row.label, workspaceRef, Object.freeze({
      ...entry.plan,
      environment: Object.freeze(row.mutate(entry.plan, workspaceRef)),
    }));
  }
});

linuxTest("non-Codex provider homes remain pairwise separated", async () => {
  const workspaceRef = await disposableRoot();
  const entry = await launchPlan({ binding: claudeBinding, workspaceRef });
  const config = entry.plan.environment.CLAUDE_CONFIG_DIR;
  assert.ok(config);
  await assertRejectedWithoutProviderEffect("claude-home-alias", workspaceRef, Object.freeze({
    ...entry.plan,
    environment: Object.freeze({ ...entry.plan.environment, HOME: config }),
  }), claudeBinding);
});
