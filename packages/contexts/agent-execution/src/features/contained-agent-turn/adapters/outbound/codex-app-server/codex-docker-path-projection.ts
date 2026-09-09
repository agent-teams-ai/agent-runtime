import {assertIssuedCodexPermissionBoundary} from "./codex-native-broker-boundary.js";
import {isAbsolute, relative, resolve} from "node:path";
import type {CodexAppServerPermissionBoundary} from "./codex-app-server-permission-boundary.js";

/** Conversion input only. Outer composition verifies same-object provenance
 * against the actual Docker lifecycle before admitting a provider process. */
export interface CodexDockerMountPaths {
  readonly workspaceSource: string;
  readonly privateRootSource: string;
}
export interface CodexProtocolPaths {readonly codexHome: string; readonly workspaceRef: string;}
export interface CodexDockerPathProjection extends CodexProtocolPaths {readonly privateRootPath: string;}
const projections = new WeakMap<CodexDockerPathProjection, Readonly<{
  mounts: CodexDockerMountPaths; boundary: CodexAppServerPermissionBoundary; privateRootSource: string;
}>>();
const bindings = new WeakMap<CodexAppServerPermissionBoundary, Readonly<{
  host: CodexAppServerPermissionBoundary; paths: CodexDockerPathProjection;
}>>();
const rejected = () => new TypeError("Codex Docker path projection rejected");

const privatePath = (root: string, path: string): string => {
  if (!isAbsolute(path) || resolve(path) !== path || path.includes("\0")) {throw rejected();}
  const suffix = relative(root, path);
  if (suffix === "" || suffix === ".." || suffix.startsWith("../") || isAbsolute(suffix)) {throw rejected();}
  return `/agent-private/${suffix}`;
};

/** Pure path conversion; this adapter does not issue Docker custody authority. */
export const createCodexDockerPathProjection = (facts: CodexDockerMountPaths, boundary: CodexAppServerPermissionBoundary): CodexDockerPathProjection => {
  assertIssuedCodexPermissionBoundary(boundary);
  if (facts.workspaceSource !== boundary.workspaceRef) {throw rejected();}
  const paths = Object.freeze({codexHome: privatePath(facts.privateRootSource, boundary.codexHome),
    workspaceRef: "/workspace", privateRootPath: "/agent-private"});
  projections.set(paths, Object.freeze({mounts: facts, boundary, privateRootSource: facts.privateRootSource}));
  return paths;
};

export const codexDockerProjectionSource = (paths: CodexDockerPathProjection) => {
  const state = projections.get(paths);
  if (state === undefined) {throw rejected();}
  return state;
};

export const projectCodexDockerPrivatePath = (paths: CodexDockerPathProjection, path: string): string =>
  privatePath(codexDockerProjectionSource(paths).privateRootSource, path);

/** Exact image locations, or the private mount's bin/codex. Init still verifies the
 * selected tuple's exact executable digest before exec; no basename guessing. */
export const projectCodexDockerExecutable = (paths: CodexDockerPathProjection, path: string): string => {
  const source = codexDockerProjectionSource(paths);
  if (path === "/usr/local/bin/codex" || path === "/ar-provider/provider-entrypoint") {return path;}
  if (path !== `${source.privateRootSource}/bin/codex`) {throw rejected();}
  return projectCodexDockerPrivatePath(paths, path);
};

/** A protocol view retains real Host identities and policy. It is never issued
 * as a new permission boundary or a Node launch capability. */
export const bindCodexDockerProtocolBoundary = (boundary: CodexAppServerPermissionBoundary, paths: CodexDockerPathProjection) => {
  if (codexDockerProjectionSource(paths).boundary !== boundary) {throw rejected();}
  const view = Object.freeze({...boundary});
  bindings.set(view, Object.freeze({host: boundary, paths}));
  return view;
};
export const codexProtocolHostBoundary = (boundary: CodexAppServerPermissionBoundary): CodexAppServerPermissionBoundary =>
  bindings.get(boundary)?.host ?? boundary;
export const codexProtocolPaths = (boundary: CodexAppServerPermissionBoundary): CodexProtocolPaths & {readonly privateRootPath?: string} =>
  bindings.get(boundary)?.paths ?? boundary;
