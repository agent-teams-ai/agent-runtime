export type ExecutableFileObservation =
  | { readonly identity: string; readonly kind: "found" }
  | { readonly kind: "missing" }
  | { readonly kind: "denied" | "invalid" | "unstable" | "unreadable" };

export interface ExecutableFileObserver {
  observe(
    absolutePath: string,
    expectedCanonicalPath: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ExecutableFileObservation>;
}
