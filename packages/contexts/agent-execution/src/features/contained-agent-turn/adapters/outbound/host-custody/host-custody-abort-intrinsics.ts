/** Native descriptors are trusted platform definitions, captured before admission.
 * Explicit receiver types retain brand checks when called with the owned instance. */
export const nativeAborted = (Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted") as {
  get: (this: AbortSignal) => boolean;
}).get;
export const nativeAbort = (Object.getOwnPropertyDescriptor(AbortController.prototype, "abort") as {
  value: (this: AbortController, reason?: unknown) => void;
}).value;
export const nativeRemoveEventListener = (Object.getOwnPropertyDescriptor(EventTarget.prototype, "removeEventListener") as {
  value: (this: EventTarget, ...args: Parameters<EventTarget["removeEventListener"]>) => void;
}).value;
export const isSignalObject = (value: unknown): value is object => value !== null && typeof value === "object";
