export type ConfigurationSourceRead =
  | { readonly bytes: Uint8Array; readonly kind: "read" }
  | { readonly kind: "missing" | "too-large" | "unreadable" };

export interface ConfigurationSourceReader {
  read(
    absolutePath: string,
    expectedCanonicalPath: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ConfigurationSourceRead>;
}
