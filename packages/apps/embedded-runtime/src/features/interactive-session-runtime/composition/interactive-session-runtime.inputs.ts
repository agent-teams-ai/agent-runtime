import {input} from "@get-modular/assembly";
import type {InteractiveHostCapabilities} from "./interactive-session-runtime.contracts.js";
import {storeDeclaration} from "./store.declaration.js";
import {providerDeclaration} from "./provider.declaration.js";
import {authorityDeclaration} from "./authority.declaration.js";
import {custodyDeclaration} from "./custody.declaration.js";
import {contextDeclaration} from "./context.declaration.js";
import {ownershipDeclaration} from "./ownership.declaration.js";

export const storeInput = input<InteractiveHostCapabilities>()(storeDeclaration);
export const providerInput = input<InteractiveHostCapabilities>()(providerDeclaration);
export const authorityInput = input<InteractiveHostCapabilities>()(authorityDeclaration);
export const custodyInput = input<InteractiveHostCapabilities>()(custodyDeclaration);
export const contextInput = input<InteractiveHostCapabilities>()(contextDeclaration);
export const ownershipInput = input<InteractiveHostCapabilities>()(ownershipDeclaration);
