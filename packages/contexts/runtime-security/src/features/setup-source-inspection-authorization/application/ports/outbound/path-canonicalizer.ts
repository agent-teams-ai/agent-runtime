export interface CanonicalPathObservation {
  readonly absolutePath: string;
  readonly exists: boolean;
}

export interface PathCanonicalizer {
  canonicalize(
    absolutePath: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<CanonicalPathObservation>;
}
