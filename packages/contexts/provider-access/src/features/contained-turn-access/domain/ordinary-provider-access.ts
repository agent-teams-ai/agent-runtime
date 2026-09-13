export interface OrdinaryPaBinding {
  readonly operationId: string;
  readonly attemptId: string;
  readonly tenantId: string;
  readonly projectId: string;
  readonly executionProfile: 'user-session-v1';
  readonly effectClass: 'ordinary_user_session_effect';
  readonly capabilityManifestRevision: 'ordinary-codex-macos-arm64-0.153.4-v1';
}
class OrdinaryPaBindingInvalid extends Error {
  readonly code = 'ORDINARY_PA_UNAVAILABLE';
  constructor() { super('ORDINARY_PA_UNAVAILABLE'); }
}
const keys = ['operationId', 'attemptId', 'tenantId', 'projectId', 'executionProfile', 'effectClass', 'capabilityManifestRevision'] as const;
/** Exact, detached fieldwise snapshot. No callers' aliases enter durable PA facts. */
export function snapshotOrdinaryPaBinding(input: unknown): OrdinaryPaBinding {
  if (input === null || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype) { throw new OrdinaryPaBindingInvalid(); }
  const fields = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(fields).length !== keys.length || keys.some(key => !fields[key] || !('value' in fields[key]!))) { throw new OrdinaryPaBindingInvalid(); }
  const get = (key: typeof keys[number]) => {
    const value: unknown = fields[key]?.value;
    if (typeof value !== 'string' || value.length < 1 || value.length > 512 || Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) { throw new OrdinaryPaBindingInvalid(); }
    return value;
  };
  if (get('executionProfile') !== 'user-session-v1' || get('effectClass') !== 'ordinary_user_session_effect' ||
      get('capabilityManifestRevision') !== 'ordinary-codex-macos-arm64-0.153.4-v1') { throw new OrdinaryPaBindingInvalid(); }
  return Object.freeze({ operationId: get('operationId'), attemptId: get('attemptId'), tenantId: get('tenantId'), projectId: get('projectId'),
    executionProfile: 'user-session-v1', effectClass: 'ordinary_user_session_effect', capabilityManifestRevision: 'ordinary-codex-macos-arm64-0.153.4-v1' });
}
export const sameOrdinaryPaBinding = (a: OrdinaryPaBinding, b: OrdinaryPaBinding): boolean => keys.every(key => a[key] === b[key]);
