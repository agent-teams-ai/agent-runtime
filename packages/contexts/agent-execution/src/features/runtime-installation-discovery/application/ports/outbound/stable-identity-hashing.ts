export interface StableIdentityHasher {
  digest(value: string): string;
}
