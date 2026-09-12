export type DockerImageReference = Readonly<{
  kind: "image-id" | "repository-digest";
  /** Tag-free repository association returned by Engine RepoDigests; absent for native IDs. */
  repositoryDigest?: string;
  reference: string;
  sha256: string;
}>;

const IMAGE_ID = /^sha256:([a-f0-9]{64})$/u;
const REPOSITORY_DIGEST = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]{1,5})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9._-]+)?@sha256:([a-f0-9]{64})$/u;

/** A config ID is not a repository manifest digest. Never synthesize a repository. */
export const parseDockerImageReference = (value: unknown): DockerImageReference | undefined => {
  if (typeof value !== "string" || value.length > 512) {return undefined;}
  const id = IMAGE_ID.exec(value);
  const repository = id === null ? REPOSITORY_DIGEST.exec(value) : null;
  const digest = id?.[1] ?? repository?.[1];
  if (digest === undefined) {return undefined;}
  if (id !== null) {return Object.freeze({kind: "image-id", reference: value, sha256: digest});}
  const named = value.slice(0, value.lastIndexOf("@"));
  const tag = named.lastIndexOf(":");
  const repositoryName = tag > named.lastIndexOf("/") ? named.slice(0, tag) : named;
  return Object.freeze({kind: "repository-digest", reference: value, sha256: digest,
    repositoryDigest: `${repositoryName}@sha256:${digest}`});
};
