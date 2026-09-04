export interface MaterializationAuthorizationDigest {
  digest(canonicalPayload: string): Promise<string>;
}
