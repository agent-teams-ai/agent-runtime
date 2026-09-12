import { OrdinaryPaUnavailable } from '../../contracts/ordinary-provider-access.js';
/** Per-operation secret inventory. The trusted RS sink owns any copies it retains. */
export function createOrdinaryPaSecretGuard() {
  let closed = false, installed = false;
  const held: Buffer[] = [];
  return Object.freeze({
    install(tokens: readonly string[]) {
      if (closed || installed || tokens.length !== 3 || tokens.some(token => token.length < 1 || token.length > 4096)) { throw new OrdinaryPaUnavailable(); }
      installed = true;
      for (const token of tokens) { const bytes = Buffer.alloc(Buffer.byteLength(token)); bytes.write(token); held.push(bytes); }
    },
    check(text: string): boolean {
      if (closed || !installed || typeof text !== 'string' || Buffer.byteLength(text) > 8_388_608) { return false; }
      const bytes = Buffer.from(text, 'utf8');
      try { return held.every(secret => !bytes.includes(secret)); } finally { bytes.fill(0); }
    },
    artifact(bytes: Uint8Array): boolean {
      if (closed || !installed || bytes.byteLength > 8_388_608) { return false; }
      try { return this.check(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return false; }
    },
    dispose() { closed = true; for (const bytes of held) { bytes.fill(0); } held.length = 0; },
  });
}
export type OrdinaryPaSecretGuard = ReturnType<typeof createOrdinaryPaSecretGuard>;
