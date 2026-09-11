/** Pure, deterministic path string algebra: no filesystem access, no ambient
 * state. Kept as a port only so the application layer never names a Node
 * builtin directly; the adapter is a thin pass-through to `node:path`. */
export interface PathAlgebra {
  readonly isAbsolute: (path: string) => boolean;
  readonly join: (...segments: readonly string[]) => string;
  readonly relative: (from: string, to: string) => string;
  readonly resolve: (...segments: readonly string[]) => string;
  readonly sep: string;
}
