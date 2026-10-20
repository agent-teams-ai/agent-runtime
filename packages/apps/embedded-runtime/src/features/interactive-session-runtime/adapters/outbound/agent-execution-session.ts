import type {InteractiveSessionFeature} from "@agent-teams/agent-execution/composition";
import type {InteractiveFeaturePort} from "../../application/ports/outbound/interactive-host-ports.js";
import type {SessionReply} from "../../domain/session-host.js";

const reply = (value: SessionReply): SessionReply => ({status: value.status,
  ...(value.receipt === undefined ? {} : {receipt: {inputId: value.receipt.inputId, operationId: value.receipt.operationId}})});
/** Field-explicit boundary: a future Agent Execution field never silently becomes a Host DTO. */
export function bindExecutionFeature(feature: InteractiveSessionFeature): InteractiveFeaturePort {
  const core = feature.session;
  return {session: {
    open: async (ref, ...args) => reply(await core.open(ref, ...args)),
    read: async ref => {
      const view = await core.read(ref); if (view === undefined) {return;}
      return {tenantId: view.tenantId, projectId: view.projectId, sessionId: view.sessionId, generation: view.generation,
        revision: view.revision, status: view.status,
        inputs: view.inputs.map(item => ({inputId: item.inputId, operationId: item.operationId, status: item.status,
          delivery: item.delivery, cancellationRequested: item.cancellationRequested})),
        events: view.events.map(event => ({sequence: event.sequence, generation: event.generation, kind: event.kind,
          data: structuredClone(event.data), ...(event.operationId === undefined ? {} : {operationId: event.operationId}),
          ...(event.inputId === undefined ? {} : {inputId: event.inputId})}))};
    },
    submit: async (ref, input) => reply(await core.submit(ref, input)),
    reply: async (ref, ...args) => reply(await core.reply(ref, ...args)),
    interrupt: async (ref, ...args) => reply(await core.interrupt(ref, ...args)),
    close: async ref => reply(await core.close(ref)),
    restore: async (ref, ...args) => reply(await core.restore(ref, ...args)),
  }, control: {
    dispatch: async ref => reply(await feature.control.dispatch(ref)),
    pumpOutput: async ref => reply(await feature.control.pumpOutput(ref)),
    recover: async ref => reply(await feature.control.recover(ref)),
    checkpoint: async ref => reply(await feature.control.checkpoint(ref)),
    cleanup: async ref => reply(await feature.control.cleanup(ref)),
  }};
}
