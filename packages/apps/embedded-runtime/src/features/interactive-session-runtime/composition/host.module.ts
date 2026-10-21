import {implement} from "@get-modular/assembly";
import {scoped} from "@get-modular/resources";
import {createInteractiveSessionFeature} from "@agent-teams/agent-execution/composition";
import {bindExecutionFeature} from "../adapters/outbound/agent-execution-session.js";
import {bindProviderGeneration} from "../adapters/outbound/provider-generation-fence.js";
import {createSessionHost} from "../application/use-cases/create-session-host.js";
import type {InteractiveHostCapabilities} from "./interactive-session-runtime.contracts.js";
import {hostDeclaration} from "./host.declaration.js";

export const hostModule = implement<InteractiveHostCapabilities>()(hostDeclaration, async (deps, {resources}) => {
  const host = createSessionHost({scope: deps.context.scope,
    authorize: deps.authority.authorize}, (current, retain, authorize) => bindExecutionFeature(createInteractiveSessionFeature({
    scope: deps.context.scope, store: deps.store, drivers: bindProviderGeneration(deps.provider, current, retain), authorize, custody: deps.custody,
    clock: deps.context.clock, limits: deps.context.limits, interactionTimeoutMs: deps.context.interactionTimeoutMs,
    newOperationId: deps.context.newOperationId, withinDeadline: deps.context.withinDeadline,
    ...(deps.context.checkpoints === undefined ? {} : {checkpoints: deps.context.checkpoints}),
  })));
  const owner = await resources.setup({name: "interactive-host", setup: async () => {
    const held = await deps.ownership.acquire();
    let complete = false;
    return {...host, dispose: async () => {
      if (complete) {return;}
      await host.dispose(); // Keep the existing process lock while logical/grant/output/process cleanup is uncertain.
      await held.release(); complete = true;
    }};
  }, cleanup: value => value.dispose()});
  return {instance: owner, capabilities: {"agent-runtime/interactive-host/host": owner}};
}, scoped);
