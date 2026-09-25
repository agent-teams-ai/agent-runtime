import { inspectSurface } from "./surface.mjs";

// Application policy: inputs are observations; this module performs no Git or filesystem IO.
export function candidateIdentity(source, archive) {
  return { packageName: source.package, version: source.version,
    requestedSourceCommit: source.commit, requestedSourceTree: source.tree, sourceBindingStatus: "unverified",
    archiveSha256: archive.canonical.sha256, archiveIntegrity: archive.canonical.integrity };
}

export function inspectPackedSurface(source, archive) {
  const packedManifestBytes = archive.files.get("package.json");
  if (!packedManifestBytes) { throw new Error("archive: package manifest missing"); }
  const packedManifest = JSON.parse(packedManifestBytes.toString("utf8"));
  if (packedManifest.name !== source.package || packedManifest.version !== source.version) {
    throw new Error("archive: package coordinates mismatch");
  }
  return inspectSurface(source.sourceManifest, packedManifest, archive.files);
}

export function buildCandidate({ source, archive, surface, observed, memberHashes, identity, key, collectorRuntime }) {
  const missing = [...archive.files.keys()].filter(path => !observed.has(path));
  const extra = [...observed.keys()].filter(path => !archive.files.has(path));
  const changed = [...archive.files].filter(([path, bytes]) => observed.has(path) && !bytes.equals(observed.get(path))).map(([path]) => path);
  if (missing.length || extra.length || changed.length) { throw new Error(`installed: mismatch ${JSON.stringify({ missing, extra, changed })}`); }
  const reasons = [
    "No reproducible source build or pack derivation was established from the selected commit and pinned native compiler, linker, headers, and sysroot.",
    "The retained archive is independently inspected but has no authenticated producer binding to the selected source commit.",
    "Typed semantic extraction and reachable declaration closure have not been witnessed by the pinned extractor.",
    "Runtime JavaScript reachability and native dependency closure have not been witnessed.",
    "Release history, bootstrap authorization, owner approval, and metadata-root approval are unavailable.",
    "The other five enrolled packages remain outside this one-package candidate."
  ];
  return { schemaVersion: 1, kind: "filesystem-custody-source-candidate", releaseEligible: false,
    source: { commit: source.commit, tree: source.tree, package: source.package, version: source.version, inputs: source.inputs,
      collectorRuntime,
      derivation: { status: "incomplete", reasons: reasons.slice(0, 2), toolchain: { status: "not-used", nativeCompiler: null, nativeLinker: null, nativeHeaders: null, nativeSysroot: null } } },
    transport: { ...archive.transport, origin: "caller-supplied-retained-archive", sourceBindingStatus: "unverified" },
    canonicalArchive: { ...archive.canonical, payload: undefined },
    installed: { identity, key, provenance: "unverified", memberCount: observed.size, members: [...observed].toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([path, bytes]) => ({ path, sha256: memberHashes.get(path), size: bytes.length })) },
    surface,
    observation: { status: "incomplete", reasons }, decisionEvidence: { status: "unavailable" } };
}
