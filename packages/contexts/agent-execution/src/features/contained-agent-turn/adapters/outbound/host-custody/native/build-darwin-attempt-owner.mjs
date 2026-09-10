import { spawnSync } from "node:child_process";
import { isAbsolute, join } from "node:path";

// Read-only finite source deployment description; never installs or launches.
if (process.argv.length === 3 && process.argv[2] === "--describe-deployment") {
  console.log(JSON.stringify({
    version: 1, activationAuthorized: false, appleCompilationVerified: false,
    rootArgv: ["<reviewed protected exact helper image>"],
    inheritedDescriptors: {
      3: "root-owned immutable fixed manifest record",
      4: "root-owned immutable exact qualification/isolation grant record",
      5: "protected approved namespace parent directory",
      6: "protected durable exclusive UID/GID lease registry directory",
      7: "protected durable operation journal directory",
      9: "manifest-bound finite provider input",
      10: "manifest-bound inert bootstrap socket; never prepared HTTP readiness or provider delegation",
    },
    hostArgv: ["<reviewed protected exact Node Host image>", "<root-pinned Host entrypoint image slot 5>", "--darwin-attempt-owner-bridge"],
    hostChallengeDescriptor: 11,
    hostPeerAddon: "image slot 6; loaded only as ./native/darwin-attempt-owner-peer.node in pinned Host closure",
    hostDescriptor: 8,
    capturedImages: ["helper", "sandbox-exec", "provider", "Host", "restricted singleton profile", "Host entrypoint", "Host peer addon", "complete loader closure"],
    imageRequirements: [
      "Exact root-owned immutable bytes, digests, vnode identities and protected ancestors; no writable ACL/metadata ancestry",
      "Root prepares reviewed protected executable copies accessible to leased UID; an existing UID501 private installation path is not assumed usable",
      "Grant must qualify exact singleton/no-descendant/no-external-FD-or-mapping-transfer policy and exclusive execution UID",
      "Root native owner observes its direct child; same UID and direct parent observer requirements remain intact",
    ],
    order: [
      "Root captures operation/scope/Host generation and immutable descriptor packet, reserves original empty inode and lease",
      "Root exec-replaces isolated Host; Host captures selection and privately retains PG receiver",
      "Actual workspace owner scans canonical source, sends complete immutable tree and publishes genuine creation record",
      "Native commitCreation journals operation/scope and acknowledges original destination",
      "Native observed private/HOME/TMP/workspace identities support existing custody owners",
      "Actual PG prepareDispatch derives attempt; outer actual store wrapper binds once",
      "Actual fresh committed claim is retained and confirmed once by that wrapper",
      "Postclaim fixed Codex material install and observed readback finish before final recipe",
      "Native START freshly revalidates material and identity once; uncertainty forbids retry",
      "Only qualified actual writer cessation permits freeze, complete artifact export and closure",
      "Release private HOME/resources separately; retain workspace/journal and issue one private closed-read grant",
    ],
    limits: {depth: 32, entries: 4096, fileBytes: 8388608, treeBytes: 33554432, chunkBytes: 16384},
    rejectingQualification: "Launched wait plus EOF does not prove writer exclusion; launched freeze/release remains unknown",
    rejectingProbeBuild: ["cc", "-std=c11", "-D_DARWIN_C_SOURCE", "-DAE_REJECTING_PROBE_MAIN",
      "-Wall", "-Wextra", "-Werror", "darwin-attempt-owner-probes.c", "-o", "<absolute disposable probe image>"],
    rejectingProbeArgv: ["<root-captured exact probe image>", "--restricted-singleton-probe"],
    rejectingProbeLimits: "Five-second in-image alarm plus root harness outer deadline; only explicit EPERM/EACCES denies count",
    rejectingProbeCoverage: "Writable shared mapping plus fork, Unix descriptor-transfer channel, delegated bootstrap port; passing alone NEVER issues qualification",
    probeExecution: "Separate later root Mac review only. Portable source tests do not execute this launch packet.",
  }, null, 2));
} else if (process.argv[2] === "--build-host-peer-addon") {
  const output = process.argv[3], headers = process.argv[4];
  if (process.platform !== "darwin" || process.argv.length !== 5 || !output || !headers ||
      !isAbsolute(output) || !isAbsolute(headers)) {
    throw new Error("Darwin SDK, absolute scratch output and existing Node headers required");
  }
  const sources = ["main", "state", "custody", "namespace", "admission", "child", "tree", "material"].map(name =>
    join(import.meta.dirname, `darwin-attempt-owner-${name}.c`));
  const result = spawnSync("cc", ["-std=c11", "-D_DARWIN_C_SOURCE", "-DAE_HOST_PEER_ADDON",
    "-Wall", "-Wextra", "-Werror", "-Wno-deprecated-declarations", "-bundle", "-undefined", "dynamic_lookup",
    "-I", headers, ...sources, "-o", output], {stdio: "inherit"});
  if (result.error) {throw result.error;}
  process.exitCode = result.status ?? 1;
} else {
  // Explicit manual compile only. No installation, execution or package wiring.
  if (process.platform !== "darwin") {
    throw new Error("Darwin SDK required; portable tests do not compile __APPLE__ sections");
  }
  const output = process.argv[2];
  if (!output || !isAbsolute(output) || process.argv.length !== 3) {
    throw new Error("one absolute disposable output path required");
  }
  const sources = ["main", "state", "custody", "namespace", "admission", "child", "tree", "material"].map((name) =>
    join(import.meta.dirname, `darwin-attempt-owner-${name}.c`));
  const result = spawnSync("cc", ["-std=c11", "-D_DARWIN_C_SOURCE", "-Wall", "-Wextra", "-Werror",
    "-Wno-deprecated-declarations", ...sources, "-o", output], { stdio: "inherit" });
  if (result.error) {throw result.error;}
  process.exitCode = result.status ?? 1;
}
