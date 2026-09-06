import * as safetyFixture from "./staged-ingress-safety-fixture.mjs";
void safetyFixture;
import { registerHooks } from "node:module";
import { createHostHttpAdmissionGuard as actualGuard } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/host-http-admission-guard.js";
import { createStrictHttpEgressBroker as actualBroker } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/strict-http-egress-broker.js";
import type { HttpEgressBrokerPorts } from "../../../dist/features/contained-agent-turn/adapters/outbound/host-custody/egress/http-egress-ports.js";

export const guards: ReturnType<typeof actualGuard>[] = [];
export const bindings: HttpEgressBrokerPorts[] = [];
let construct: (() => void) | undefined;
export const duringConstruction = (action?: () => void): void => {construct = action;};
export const createHostHttpAdmissionGuard = (identity: unknown) => {
  const guard = actualGuard(identity); guards.push(guard); return guard;
};
export const createStrictHttpEgressBroker = (...args: Parameters<typeof actualBroker>) => {
  bindings.push(args[0]); construct?.(); return actualBroker(...args);
};

// Test-only fault injection before importing the session. Match only its two
// local factories; the wrappers still call the original guard and broker.
registerHooks({
  resolve(specifier, context, next) {
    if (/\/host-http-egress-session\.(?:js|ts)$/.test(context.parentURL ?? "")
      && ["./host-http-admission-guard.js", "./strict-http-egress-broker.js"].includes(specifier)) {
      return {url: import.meta.url, shortCircuit: true};
    }
    return next(specifier, context);
  },
});
