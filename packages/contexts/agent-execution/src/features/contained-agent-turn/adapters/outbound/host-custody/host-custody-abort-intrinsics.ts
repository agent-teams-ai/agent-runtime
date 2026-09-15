/** Native descriptors are trusted platform definitions, captured before admission.
 * Explicit receiver types retain brand checks when called with the owned instance. */
export const nativeAborted = (Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted") as {
  get: (this: AbortSignal) => boolean;
}).get;
export const nativeAbort = (Object.getOwnPropertyDescriptor(AbortController.prototype, "abort") as {
  value: (this: AbortController, reason?: unknown) => void;
}).value;
type NativeEventListener = ((event: Event) => void) | {handleEvent(event: Event): void};

type NativeRemoveEventListener = (
  this: EventTarget,
  type: string,
  callback: NativeEventListener | null,
  options?: boolean | EventListenerOptions,
) => void;

export const nativeRemoveEventListener: NativeRemoveEventListener = (
  Object.getOwnPropertyDescriptor(EventTarget.prototype, "removeEventListener") as {
    value: NativeRemoveEventListener;
  }
).value;
export const isSignalObject = (value: unknown): value is object => value !== null && typeof value === "object";
