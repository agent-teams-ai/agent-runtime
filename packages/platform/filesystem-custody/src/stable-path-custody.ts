import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

interface PathComponentIdentity {
  readonly ctimeNs: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly mtimeNs: bigint;
  readonly nlink: bigint;
  readonly path: string;
  readonly size: bigint;
}

export interface PathLineage {
  readonly components: readonly PathComponentIdentity[];
}

export interface PathCustodyBoundary {
  readonly absolutePath: string;
  readonly canonicalPath: string;
}

export interface OpenedStablePath {
  readonly canonicalLocationPath: string;
  readonly canonicalPath: string;
  readonly handle: FileHandle;
  readonly stats: BigIntStats;
}

export class PathCustodyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PathCustodyError";
  }
}

const componentPaths = (
  absolutePath: string,
  boundaryPath: string,
): readonly string[] => {
  const target = resolve(absolutePath);
  const boundary = resolve(boundaryPath);
  const suffix = relative(boundary, target);
  if (
    suffix === ".." ||
    suffix.startsWith(`..${sep}`) ||
    isAbsolute(suffix)
  ) {
    throw new PathCustodyError("Path is outside its custody boundary");
  }
  const paths = [boundary];
  let cursor = boundary;
  for (const component of suffix.split(sep).filter(Boolean)) {
    cursor = join(cursor, component);
    paths.push(cursor);
  }
  return paths;
};

const componentIdentity = (
  path: string,
  observation: BigIntStats,
): PathComponentIdentity => ({
  ctimeNs: observation.ctimeNs,
  dev: observation.dev,
  ino: observation.ino,
  mode: observation.mode,
  mtimeNs: observation.mtimeNs,
  nlink: observation.nlink,
  path,
  size: observation.size,
});

export const capturePathLineage = async (
  absolutePath: string,
  boundaryPath = absolutePath,
  signal?: AbortSignal,
): Promise<PathLineage> => {
  if (!isAbsolute(absolutePath) || !isAbsolute(boundaryPath)) {
    throw new TypeError("Path lineage requires an absolute path");
  }
  const components: PathComponentIdentity[] = [];
  for (const path of componentPaths(absolutePath, boundaryPath)) {
    signal?.throwIfAborted();
    components.push(componentIdentity(path, await lstat(path, { bigint: true })));
  }
  return { components };
};

const componentsEqual = (
  left: PathComponentIdentity,
  right: PathComponentIdentity,
): boolean =>
  left.path === right.path &&
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mode === right.mode &&
  left.nlink === right.nlink &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs;

export const pathLineagesEqual = (
  left: PathLineage,
  right: PathLineage,
): boolean =>
  left.components.length === right.components.length &&
  left.components.every((component, index) => {
    const comparison = right.components[index];
    return comparison !== undefined && componentsEqual(component, comparison);
  });

const isSingleLinkRegularFile = (observation: BigIntStats): boolean =>
  observation.isFile() && observation.nlink === 1n;

const fileIdentitiesEqual = (
  left: BigIntStats,
  right: BigIntStats,
): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mode === right.mode &&
  left.nlink === right.nlink &&
  left.size === right.size &&
  left.mtimeNs === right.mtimeNs &&
  left.ctimeNs === right.ctimeNs;

const lineageEndsWithIdentity = (
  lineage: PathLineage,
  observation: BigIntStats,
): boolean => {
  const terminal = lineage.components.at(-1);
  return terminal !== undefined &&
    terminal.dev === observation.dev &&
    terminal.ino === observation.ino &&
    terminal.mode === observation.mode &&
    terminal.nlink === observation.nlink &&
    terminal.size === observation.size &&
    terminal.mtimeNs === observation.mtimeNs &&
    terminal.ctimeNs === observation.ctimeNs;
};

const captureLineages = async (
  absolutePath: string,
  expectedCanonicalPath: string,
  boundary: PathCustodyBoundary,
  signal?: AbortSignal,
): Promise<readonly [PathLineage, PathLineage]> =>
  Promise.all([
    capturePathLineage(absolutePath, boundary.absolutePath, signal),
    capturePathLineage(
      expectedCanonicalPath,
      boundary.canonicalPath,
      signal,
    ),
  ]);

interface ResolvedPathCustody {
  readonly canonicalBoundaryPath: string;
  readonly canonicalParentPath: string;
  readonly canonicalPath: string;
  readonly observedBoundaryPath: string;
  readonly observedPath: string;
}

const resolvePathCustody = async (
  absolutePath: string,
  expectedCanonicalPath: string,
  boundary: PathCustodyBoundary,
): Promise<ResolvedPathCustody> => {
  const [
    observedPath,
    canonicalPath,
    canonicalParentPath,
    observedBoundaryPath,
    canonicalBoundaryPath,
  ] = await Promise.all([
    realpath(absolutePath),
    realpath(expectedCanonicalPath),
    realpath(dirname(absolutePath)),
    realpath(boundary.absolutePath),
    realpath(boundary.canonicalPath),
  ]);
  return {
    canonicalBoundaryPath,
    canonicalParentPath,
    canonicalPath,
    observedBoundaryPath,
    observedPath,
  };
};

const assertExpectedPathCustody = (
  observation: ResolvedPathCustody,
  expectedCanonicalPath: string,
  boundary: PathCustodyBoundary,
): void => {
  if (
    observation.observedPath !== expectedCanonicalPath ||
    observation.canonicalPath !== expectedCanonicalPath ||
    observation.observedBoundaryPath !== boundary.canonicalPath ||
    observation.canonicalBoundaryPath !== boundary.canonicalPath
  ) {
    throw new PathCustodyError("Path changed while it was being resolved");
  }
};

const assertStableOpenedPath = (
  opened: BigIntStats,
  preflight: BigIntStats,
  current: BigIntStats,
  before: readonly [PathLineage, PathLineage],
  after: readonly [PathLineage, PathLineage],
): void => {
  if (
    !isSingleLinkRegularFile(opened) ||
    !isSingleLinkRegularFile(current) ||
    !fileIdentitiesEqual(opened, preflight) ||
    !fileIdentitiesEqual(opened, current) ||
    !lineageEndsWithIdentity(before[1], preflight) ||
    !lineageEndsWithIdentity(after[1], current) ||
    !pathLineagesEqual(before[0], after[0]) ||
    !pathLineagesEqual(before[1], after[1])
  ) {
    throw new PathCustodyError("Path lineage changed while it was being opened");
  }
};

export const openStablePath = async <Result>(
  absolutePath: string,
  expectedCanonicalPath: string,
  operation: (opened: OpenedStablePath) => Promise<Result>,
  options?: {
    readonly custodyBoundary?: PathCustodyBoundary;
    readonly openFile?: (
      path: string,
      flags: number,
    ) => Promise<FileHandle>;
    readonly signal?: AbortSignal;
  },
): Promise<Result> => {
  if (!isAbsolute(absolutePath) || !isAbsolute(expectedCanonicalPath)) {
    throw new TypeError("Stable path custody requires absolute paths");
  }
  const signal = options?.signal;
  const boundary = options?.custodyBoundary ?? {
    absolutePath,
    canonicalPath: expectedCanonicalPath,
  };
  if (
    !isAbsolute(boundary.absolutePath) ||
    !isAbsolute(boundary.canonicalPath)
  ) {
    throw new TypeError("Path custody boundaries must be absolute");
  }
  signal?.throwIfAborted();
  const before = await captureLineages(
    absolutePath,
    expectedCanonicalPath,
    boundary,
    signal,
  );
  const initialResolution = await resolvePathCustody(
    absolutePath,
    expectedCanonicalPath,
    boundary,
  );
  assertExpectedPathCustody(initialResolution, expectedCanonicalPath, boundary);
  const preflight = await lstat(expectedCanonicalPath, { bigint: true });
  if (!isSingleLinkRegularFile(preflight)) {
    throw new PathCustodyError("Stable path must be a single-link regular file");
  }
  const openFile = options?.openFile ?? open;
  const handle = await openFile(
    expectedCanonicalPath,
    constants.O_RDONLY |
      constants.O_NONBLOCK |
      (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = await handle.stat({ bigint: true });
    if (!isSingleLinkRegularFile(opened)) {
      throw new PathCustodyError("Stable path must be a single-link regular file");
    }
    const [finalResolution, pathObservation, after] = await Promise.all([
      resolvePathCustody(absolutePath, expectedCanonicalPath, boundary),
      lstat(expectedCanonicalPath, { bigint: true }),
      captureLineages(absolutePath, expectedCanonicalPath, boundary, signal),
    ]);
    signal?.throwIfAborted();
    assertExpectedPathCustody(finalResolution, expectedCanonicalPath, boundary);
    assertStableOpenedPath(opened, preflight, pathObservation, before, after);
    return await operation({
      canonicalLocationPath: join(
        initialResolution.canonicalParentPath,
        basename(absolutePath),
      ),
      canonicalPath: expectedCanonicalPath,
      handle,
      stats: opened,
    });
  } finally {
    await handle.close();
  }
};
