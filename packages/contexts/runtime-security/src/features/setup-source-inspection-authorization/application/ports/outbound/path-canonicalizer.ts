export interface CanonicalPathObservation {
  readonly absolutePath: string;
  readonly exists: boolean;
  readonly fileIdentity?: string;
  readonly isFile?: boolean;
  readonly linkCount?: number;
}

export interface PathCanonicalizer {
  canonicalize(
    absolutePath: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<CanonicalPathObservation>;
}
