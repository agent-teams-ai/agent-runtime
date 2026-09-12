import { createHash } from "node:crypto";
import {darwinAttemptOwnerDigest as digest, darwinAttemptOwnerNumeric as numeric} from "./darwin-attempt-owner-protocol-definitions.js";

/** Inert final data, not an authority issuer. Only the private HTTP owner may
 * transmit it after authenticating its retained same-object final launch. */
export interface DarwinNativeFinalLaunchData {
  readonly home: string; readonly codexHome: string; readonly tmpDir: string;
  readonly localCapability: string; readonly port: number;
  readonly preparedSha256: string; readonly profileSha256: string;
  readonly configSha256: string; readonly catalogSha256: string; readonly installationSha256: string;
  readonly fingerprintSha256: string; readonly materialSha256: string;
  readonly executableSha256: string; readonly argumentsSha256: string;
}
const finalDigestBytes = (value: string): Buffer => {
  if (typeof value !== "string" || !digest.test(value)) {throw new Error("invalid final native binding digest");}
  return Buffer.from(value, "hex");
};
const canonicalFinalPath = (value: string): boolean => value.startsWith("/") &&
  !value.slice(1).split("/").some(part => !part || part === "." || part === "..");
export function encodeDarwinNativeFinalLaunchData(input: DarwinNativeFinalLaunchData): Buffer {
  const names = ["home", "codexHome", "tmpDir", "localCapability", "port", "preparedSha256", "profileSha256",
    "configSha256", "catalogSha256", "installationSha256", "fingerprintSha256", "materialSha256", "executableSha256", "argumentsSha256"];
  if (Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).length !== names.length ||
      names.some(name => !Object.hasOwn(input, name)) ||
      Object.values(Object.getOwnPropertyDescriptors(input)).some(field => !("value" in field) ||
        (typeof field.value !== "string" && typeof field.value !== "number"))) {
    throw new Error("final native launch requires exact inert data");
  }
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535 || (typeof input.localCapability !== "string" || !digest.test(input.localCapability))) {
    throw new Error("invalid final native local route");
  }
  const packet = Buffer.alloc(numeric("FINAL_LAUNCH_BYTES"));
  packet.writeUInt32BE(1, 0); packet.writeUInt32BE(input.port, 4);
  const fields = [input.home, input.codexHome, input.tmpDir, input.localCapability,
    `http://127.0.0.1:${input.port}/backend-api/codex`];
  for (const [index, value] of fields.entries()) {
    if (typeof value !== "string" || !value || !value.isWellFormed() || value.includes("\0") ||
        Buffer.byteLength(value) > 1024 || (index < 3 && !canonicalFinalPath(value))) {
      throw new Error("invalid final native environment field");
    }
    const offset = numeric("FINAL_TEXT_OFFSET") + index * 1028;
    packet.writeUInt32BE(Buffer.byteLength(value), offset); packet.write(value, offset + 4, "utf8");
  }
  const hashes = [input.preparedSha256, input.profileSha256, input.configSha256, input.catalogSha256,
    input.installationSha256, input.fingerprintSha256, input.materialSha256, input.executableSha256, input.argumentsSha256];
  for (const [index, value] of hashes.entries()) {
    finalDigestBytes(value).copy(packet, numeric("FINAL_DIGEST_OFFSET") + index * 32);
  }
  return packet;
}

export function darwinNativeArgumentsSha256(executable: string, args: readonly string[]): string {
  if (args.length > 7) {throw new Error("native argument count exceeds root bound");}
  const hash = createHash("sha256");
  for (const value of [executable, ...args]) {
    if (typeof value !== "string" || !value || !value.isWellFormed() || value.includes("\0") || Buffer.byteLength(value) > 255) {
      throw new Error("native argument exceeds fixed root slot");
    }
    const count = Buffer.alloc(4); count.writeUInt32BE(Buffer.byteLength(value)); hash.update(count).update(value);
  }
  return hash.digest("hex");
}
