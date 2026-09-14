import {lstat, readFile, realpath} from "node:fs/promises";
import {dirname, isAbsolute, join} from "node:path";

const refused = reason => new Error(`DARWIN_OPERATOR_PROVIDER_ACCESS_REFUSED: ${reason}`);

/** Real PA secrets (codexHome/sandbox/operatorApproval) must never be baked
 * into the sealed/hashed activation manifest (finding 6 of the activation
 * -closure remediation): the operator supplies them out-of-band as a sibling
 * file next to the activation's own evidenceDirectory, a path every real
 * activation consumer already has in hand (both the operator's own preflight
 * process and the dropped-privilege host-entrypoint child, which inherits no
 * env beyond PATH/LANG/LC_ALL and no argv beyond its fixed bridge flag -- see
 * darwin-attempt-owner-admission.c's ae_root_isolate_host) without requiring
 * any new native spawn channel. Strict ownership/mode/no-symlink checks match
 * darwin-live-infrastructure.mjs#verifyPrivateDirectories and this codebase's
 * other private-file reads. */
export async function loadOperatorProviderAccess(activation) {
  const evidenceDirectory = activation?.evidenceDirectory;
  if (!isAbsolute(evidenceDirectory ?? "")) {throw refused("operator providerAccess location unavailable");}
  const path = join(dirname(evidenceDirectory), "operator-provider-access.json");
  const resolved = await realpath(path).catch(() => {});
  if (resolved !== path) {throw refused("operator providerAccess config missing or not canonical");}
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== process.getuid()) {
    throw refused("operator providerAccess config is not privately owned");
  }
  const value = JSON.parse(await readFile(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).toSorted().join() !== "codexHome,operatorApproval,sandbox" ||
      !isAbsolute(value.codexHome ?? "") || !isAbsolute(value.sandbox ?? "") ||
      !value.operatorApproval || typeof value.operatorApproval !== "object" || Array.isArray(value.operatorApproval)) {
    throw refused("operator providerAccess config shape is invalid");
  }
  return Object.freeze({codexHome: value.codexHome, sandbox: value.sandbox,
    operatorApproval: Object.freeze(structuredClone(value.operatorApproval))});
}

/** Returns a copy of `activation` with infrastructure.providerAccess replaced
 * by the operator-supplied out-of-band value; the sealed object itself (and
 * its hash-verified files) is never mutated. */
export async function withOperatorProviderAccess(activation) {
  const providerAccess = await loadOperatorProviderAccess(activation);
  return Object.freeze({...activation,
    infrastructure: Object.freeze({...activation.infrastructure, providerAccess})});
}
