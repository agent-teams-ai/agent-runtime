import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const hashFile = async (path: string): Promise<string> =>
  createHash("sha256").update(await readFile(path)).digest("hex");

export interface CredentialFixtureGuard {
  verifySourceUnchanged(): Promise<Readonly<Record<string, unknown>>>;
}

export const copyCredentialFixture = async (
  source: string,
  destination: string,
): Promise<CredentialFixtureGuard> => {
  const sourceHash = await hashFile(source);
  const content = await readFile(source);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await writeFile(destination, content, { mode: 0o600 });

  return {
    async verifySourceUnchanged() {
      if ((await hashFile(source)) !== sourceHash) {
        throw new Error("Credential source changed during sandbox scenario");
      }
      return {
        credentialSourceUnchanged: true,
        providerReceivedSandboxCopy: true,
      };
    },
  };
};

export const writeCorruptCredentialFixture = async (
  destination: string,
): Promise<void> => {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await writeFile(destination, "{not-valid-json\n", { mode: 0o600 });
};
