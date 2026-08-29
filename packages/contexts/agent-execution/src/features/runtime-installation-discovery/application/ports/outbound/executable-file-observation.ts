export type ExecutableFileObservation =
  | { readonly identity: string; readonly kind: "found" }
  | { readonly kind: "missing" }
  | { readonly kind: "denied" | "invalid" | "unstable" | "unreadable" };

export interface ExecutableFileObservationRequest {
  readonly absolutePath: string;
  readonly authorizedFileIdentity: string | undefined;
  readonly custodyBoundary:
    | {
        readonly absolutePath: string;
        readonly canonicalPath: string;
      }
    | undefined;
  readonly expectedCanonicalPath: string;
  readonly signal?: AbortSignal;
}

export interface ExecutableFileObserver {
  observe(
    request: Readonly<ExecutableFileObservationRequest>,
  ): Promise<ExecutableFileObservation>;
}
