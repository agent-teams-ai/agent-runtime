import type {Event} from "../ports/outbound/interactive-provider-driver.js";
import type {DriverObservation} from "../ports/outbound/interactive-session-ports.js";
import type {JsonValue} from "../../domain/session.js";

/** JSON boundary retains snapshot/message/block identity and leaves absent attribution absent. */
export function normalizeProviderEvent(event: Event, expiresAt: number): DriverObservation {
  const attribution = {...(event.operationRef === undefined ? {} : {operationId: event.operationRef}),
    ...(event.inputId === undefined ? {} : {inputId: event.inputId})};
  if (event.kind === "result") {
    if (event.operationRef === undefined || event.inputId === undefined) {return {kind: "diagnostic", data: {code: "unattributed-result"}};}
    return {kind: "result", operationId: event.operationRef, inputId: event.inputId, outcome: event.outcome};
  }
  const {sessionRef: _sessionRef, operationRef: _operationRef, inputId: _inputId, ...payload} = event;
  const data = JSON.parse(JSON.stringify(payload)) as JsonValue;
  if (event.kind === "interaction") {return {kind: "interaction", ...attribution,
    interactionId: event.interactionRef, requestKind: event.request.kind, expiresAt, data};}
  return {kind: event.kind, ...attribution, data};
}
