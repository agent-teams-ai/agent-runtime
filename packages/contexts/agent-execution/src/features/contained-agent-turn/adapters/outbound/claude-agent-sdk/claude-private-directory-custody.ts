import type {
  PrivateDirectoryCustodyPort,
} from "../provider-delegation-ports/private-directory-custody-port.js";

/** Capture one verifier authority without retaining its mutable receiver state. */
export const captureClaudePrivateDirectoryCustody = (
  custody: PrivateDirectoryCustodyPort,
): PrivateDirectoryCustodyPort => {
  if (typeof custody !== "object" || custody === null) {
    throw new TypeError("Claude private-directory custody must be an object");
  }
  const verifier = custody.assertPrivateDirectory;
  if (typeof verifier !== "function") {
    throw new TypeError("Claude private-directory custody requires a verifier");
  }
  const receiver = Object.create(null) as PrivateDirectoryCustodyPort;
  Object.defineProperty(receiver, "assertPrivateDirectory", {
    configurable: false,
    enumerable: true,
    value: verifier,
    writable: false,
  });
  return Object.freeze(receiver);
};
