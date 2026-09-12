import type { CodexAppServerPermissionBoundary } from "./codex-app-server-permission-boundary.js";

// Private bridge for the existing boundary issuer and native recipe. Kept apart
// from the wire re-export so validation never depends cyclically on its issuer.
const issued = new WeakSet<CodexAppServerPermissionBoundary>();
export const retainIssuedCodexPermissionBoundary = (boundary: CodexAppServerPermissionBoundary): void => {
  issued.add(boundary);
};
export const assertIssuedCodexPermissionBoundary = (boundary: CodexAppServerPermissionBoundary): void => {
  if (!issued.has(boundary)) {throw new TypeError("Codex native broker requires an issued permission boundary");}
};
