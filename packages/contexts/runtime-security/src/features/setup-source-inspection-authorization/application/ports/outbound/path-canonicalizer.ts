export interface CanonicalPathObservation {
  readonly absolutePath: string;
  readonly canonicalLocationPath: string;
  readonly exists: boolean;
  readonly fileIdentity?: string;
  readonly isFile?: boolean;
  readonly linkCount?: number;
}

export interface PathCanonicalizer {
  canonicalize(
    absolutePath: string,
    options?: {
      readonly custodyBoundary?: {
        readonly absolutePath: string;
        readonly canonicalPath: string;
      };
      readonly signal?: AbortSignal;
    },
  ): Promise<CanonicalPathObservation>;
}
