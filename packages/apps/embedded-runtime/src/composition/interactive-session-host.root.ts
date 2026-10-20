import type {Assembly} from "@get-modular/assembly";
import {interactiveSessionRuntimeGroup, hostModule, storeInput, providerInput, authorityInput,
  custodyInput, contextInput, ownershipInput, type InteractiveHostCapabilities} from "../features/interactive-session-runtime/internal.js";

export const interactiveHostModules = [interactiveSessionRuntimeGroup] as const;
export const composeInteractiveSessionHost = (api: Assembly<InteractiveHostCapabilities>) => api.prepare({
  profileId: "agent-runtime/interactive-session-host/v1", modules: interactiveHostModules, roots: {host: hostModule},
  inputs: {store: storeInput, provider: providerInput, authority: authorityInput, custody: custodyInput, context: contextInput, ownership: ownershipInput},
});
