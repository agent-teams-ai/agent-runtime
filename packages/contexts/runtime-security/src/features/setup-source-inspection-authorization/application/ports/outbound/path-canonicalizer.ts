export interface CanonicalPathObservation {
  readonly absolutePath: string;
  readonly canonicalLocationPath: string;
  readonly exists: boolean;
  readonly fileIdentity?: string;
  readonly isFile?: boolean;
  readonly linkCount?: number;
}

export interface PathCanonicalizationOptions {
  readonly custodyBoundary?: {
    readonly absolutePath: string;
    readonly canonicalPath: string;
  };
  readonly signal?: AbortSignal;
}

export interface PathCanonicalizer {
  canonicalize(
    absolutePath: string,
    options?: PathCanonicalizationOptions,
  ): Promise<CanonicalPathObservation>;
}
