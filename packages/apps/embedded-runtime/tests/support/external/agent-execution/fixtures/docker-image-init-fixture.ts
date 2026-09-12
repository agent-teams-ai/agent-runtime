import { createHash } from "node:crypto";
import {
  DOCKER_CUSTODY_BOOTSTRAP_PATH, DOCKER_CUSTODY_INIT_ARGUMENTS, DOCKER_CUSTODY_NODE_PATH,
  createDockerImageInitOwner, type DockerImageInitLock,
} from "@agent-teams/agent-execution/composition";
import { NodeUnixSocketDockerEngine } from "@agent-teams/agent-execution/composition";
import { HOST, HOST_BOOT, IMAGE, call, createInput, policy } from "./docker-engine-test-fixture.ts";
import { syntheticDaemon } from "./docker-engine-synthetic-daemon.ts";
import { jsonResponse } from "../features/contained-agent-turn/docker-engine-transport-test-fixture.ts";

export const IMAGE_CONFIG = `sha256:${"7".repeat(64)}`;
export const NODE_BYTES = Buffer.from("synthetic independent interpreter bytes");
export const BOOTSTRAP_BYTES = Buffer.from("synthetic independent closed driver bundle bytes");
export const INIT_HOST = Object.freeze({hostIdentitySha256: HOST, hostBootGenerationSha256: HOST_BOOT,
  hostLifecycleGenerationSha256: "8".repeat(64)});
export const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export const imageLock = (reference = IMAGE): DockerImageInitLock => ({
  imageReference: reference, imageConfigId: IMAGE_CONFIG, os: "linux", architecture: "amd64", variant: "",
  loadingPolicy: "closed-bundle-node-builtins-only-v1",
  interpreter: {path: DOCKER_CUSTODY_NODE_PATH, sha256: digest(NODE_BYTES), size: NODE_BYTES.length, mode: 0o555},
  bootstrap: {path: DOCKER_CUSTODY_BOOTSTRAP_PATH, sha256: digest(BOOTSTRAP_BYTES), size: BOOTSTRAP_BYTES.length, mode: 0o444},
});
export const checksum = (header: Buffer): void => {
  header.fill(32, 148, 156);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
};
export const archive = (path: string, bytes: Uint8Array, mode: number): Buffer => {
  const header = Buffer.alloc(512);
  header.write(path.slice(1), 0, "ascii");
  for (const [offset, length, number] of [[100, 8, mode], [108, 8, 0], [116, 8, 0], [124, 12, bytes.byteLength], [136, 12, 0]]) {
    header.write(`${number!.toString(8).padStart(length! - 1, "0")}\0`, offset!, "ascii");
  }
  header[156] = 48;
  header.write("ustar\u000000", 257, "ascii");
  checksum(header);
  return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.byteLength % 512) % 512 + 1024)]);
};
export async function* chunks(bytes: Uint8Array, width = 317): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += width) {yield bytes.subarray(offset, offset + width);}
}

export const imageInitFixture = async (root: string, reference = IMAGE) => {
  const daemon = syntheticDaemon();
  const lock = imageLock(reference);
  const image: Record<string, unknown> = {Id: IMAGE_CONFIG, RepoDigests: [IMAGE], Architecture: "amd64", Os: "linux"};
  const state = {
    archiveType: "application/x-tar", archiveStatus: 200,
    afterArchive: undefined as (() => void) | undefined,
    transform: undefined as ((raw: Record<string, unknown>) => void) | undefined,
  };
  const archives = new Map([
    [DOCKER_CUSTODY_NODE_PATH, archive(DOCKER_CUSTODY_NODE_PATH, NODE_BYTES, 0o555)],
    [DOCKER_CUSTODY_BOOTSTRAP_PATH, archive(DOCKER_CUSTODY_BOOTSTRAP_PATH, BOOTSTRAP_BYTES, 0o444)],
  ]);
  daemon.inspectTransform = raw => {
    raw.Image = IMAGE_CONFIG; raw.Path = DOCKER_CUSTODY_NODE_PATH; raw.Args = [...DOCKER_CUSTODY_INIT_ARGUMENTS];
    (raw.Config as Record<string, unknown>).Image = reference;
    state.transform?.(raw);
  };
  const client = {...daemon.client,
    async buffered(input: Parameters<typeof daemon.client.buffered>[0]) {
      if (input.path.startsWith("/v1.47/images/")) {
        daemon.routes.push(`${input.method} ${input.path}`);
        assertImagePath(input.path, reference);
        return jsonResponse(200, image);
      }
      return daemon.client.buffered(input);
    },
    async stream(input: Parameters<typeof daemon.client.stream>[0]) {
      if (!input.path.includes("/archive?path=")) {return daemon.client.stream(input);}
      daemon.routes.push(`${input.method} ${input.path}`);
      const path = decodeURIComponent(input.path.split("?path=")[1]!);
      const bytes = archives.get(path);
      if (bytes === undefined) {throw new Error("unexpected archive path");}
      async function* body(): AsyncIterable<Uint8Array> {yield* chunks(bytes!); state.afterArchive?.();}
      return {body: body(), statusCode: state.archiveStatus, contentType: state.archiveType};
    },
  };
  const engine = new NodeUnixSocketDockerEngine({client, policy: {...policy(root), allowedEnvironmentKeys: ["AR_CUSTODY_INIT_CONFIGURATION"]}});
  const input = {...createInput(root), imageDigest: reference, entrypoint: DOCKER_CUSTODY_NODE_PATH,
    arguments: [...DOCKER_CUSTODY_INIT_ARGUMENTS], environment: {AR_CUSTODY_INIT_CONFIGURATION: "{}"}};
  const authority = await engine.create(input, call());
  const owner = createDockerImageInitOwner({engine, lock, host: INIT_HOST});
  return {daemon, engine, owner, authority, lock, archives, image, state, input};
};
const assertImagePath = (path: string, reference: string): void => {
  if (path !== `/v1.47/images/${encodeURIComponent(reference)}/json`) {throw new Error("unexpected image path");}
};
