export type ExecutableFileObservation =
  | { readonly identity: string; readonly kind: "found" }
  | { readonly kind: "missing" }
  | { readonly kind: "denied" | "invalid" | "unstable" | "unreadable" };

export interface ExecutableFileObservationRequest {
  readonly absolutePath: string;
  readonly authorizedFileIdentity: string | undefined;
  readonly custodyBoundary: {
    readonly absolutePath: string;
    readonly canonicalPath: string;
  };
  readonly expectedCanonicalPath: string;
  readonly signal?: AbortSignal;
}

/** Public composition capability retained under its existing name. */
export interface ExecutableFileObserver {
  observe(
    request: Readonly<ExecutableFileObservationRequest>,
  ): Promise<ExecutableFileObservation>;
}
