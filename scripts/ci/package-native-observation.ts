import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import type { CommandResult, runCommand } from './package-execution.ts';
export interface ToolObservation { command: CommandResult; stdout: string; stderr: string }
export interface NativeBuild {
  cleanOutputAbsent: true; path: string; sha256: string | null; format: string | null; arch: string | null;
  builderHash: string; sourceHash: string; recipe: string[];
  compiler: { path: string; sha256: string }; compilerDriver: { path: string; sha256: string }; headers: { path: string; files: Record<string, string> };
  sdk: { path: string; realPath: string; settingsHash: string }; probes: Record<string, ToolObservation>;
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const nativeRoot = 'packages/platform/filesystem-custody';
export const nativeOutput = `${nativeRoot}/dist/rename-no-replace.node`;
export function assertMachOArm64(bytes: Uint8Array): void {
  const value = Buffer.from(bytes);
  assert.ok(value.length >= 32, 'missing Mach-O header');
  assert.equal(value.readUInt32LE(0), 0xfeedfacf, 'Mach-O 64-bit required');
  assert.equal(value.readUInt32LE(4), 0x0100000c, 'Mach-O arm64 required');
  assert.equal(value.readUInt32LE(12), 8, 'Mach-O bundle required');
}
export async function assertNativeAbsent(root: string): Promise<void> {
  await assert.rejects(lstat(join(root, nativeOutput)), { code: 'ENOENT' }, 'clean must remove old native output');
}
interface ToolContext { root: string; output: string; env: NodeJS.ProcessEnv; run: typeof runCommand }
async function tool(context: ToolContext, name: string, executable: string, argv: string[]): Promise<ToolObservation> {
  const { root, output, env, run } = context;
  const prefix = join(output, `native-${name}`);
  const command = await run(executable, argv, root, env, prefix);
  const result = { command, stdout: await readFile(`${prefix}.stdout`, 'utf8'), stderr: await readFile(`${prefix}.stderr`, 'utf8') };
  assert.equal(command.error || command.signal || command.exitCode, 0, `native observation failed: ${name}`);
  assert.ok(result.stdout.trim() || result.stderr.trim(), `empty native observation: ${name}`); return result;
}
export async function prepareNative(root: string, output: string, env: NodeJS.ProcessEnv, run: typeof runCommand): Promise<NativeBuild> {
  const context = { root, output, env, run };
  const probes: Record<string, ToolObservation> = {};
  probes.compilerPath = await tool(context, 'compiler-path', '/bin/sh', ['-c', 'command -v cc']);
  const compiler = await realpath(probes.compilerPath.stdout.trim());
  probes.compilerDriver = await tool(context, 'compiler-driver', '/usr/bin/xcrun', ['--find', 'cc']);
  const compilerDriver = await realpath(probes.compilerDriver.stdout.trim());
  probes.compilerVersion = await tool(context, 'compiler-version', 'cc', ['--version']);
  probes.sdkPath = await tool(context, 'sdk-path', '/usr/bin/xcrun', ['--show-sdk-path']);
  probes.sdkVersion = await tool(context, 'sdk-version', '/usr/bin/xcrun', ['--show-sdk-version']);
  probes.osVersion = await tool(context, 'os-version', '/usr/bin/sw_vers', ['-productVersion']);
  probes.osBuild = await tool(context, 'os-build', '/usr/bin/sw_vers', ['-buildVersion']);
  const sdk = probes.sdkPath.stdout.trim();
  const sdkRealPath = await realpath(sdk);
  let headers: string | undefined;
  for (const candidate of [resolve(dirname(process.execPath), '../include/node'), '/usr/local/include/node', '/usr/include/node']) {
    try { await lstat(join(candidate, 'node_api.h')); headers = candidate; break; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
    }
  }
  assert.ok(headers, 'original ambient build requires Node-API headers');
  const files: Record<string, string> = {};
  for (const entry of await readdir(headers, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory()) { continue; }
    assert.ok(entry.isFile(), 'unsupported header input');
    const path = join(entry.parentPath, entry.name); files[relative(headers, path)] = hash(await readFile(path));
  }
  const recipe = ['-O2', '-Wall', '-Wextra', '-Werror', '-fPIC', '-bundle', '-undefined', 'dynamic_lookup', '-lsandbox',
    `-I${headers}`, 'native/rename-no-replace.c', '-o', 'dist/rename-no-replace.node'];
  // Read-only driver trace for the unchanged ambient recipe; -### emits no build output.
  probes.driverTrace = await tool({ ...context, root: join(root, nativeRoot) }, 'driver-trace', 'cc', ['-###', ...recipe]);
  await assertNativeAbsent(root);
  return { cleanOutputAbsent: true, path: nativeOutput, sha256: null, format: null, arch: null,
    builderHash: hash(await readFile(join(root, nativeRoot, 'scripts/build-native-helper.mjs'))),
    sourceHash: hash(await readFile(join(root, nativeRoot, 'native/rename-no-replace.c'))),
    recipe,
    compiler: { path: compiler, sha256: hash(await readFile(compiler)) }, compilerDriver: { path: compilerDriver, sha256: hash(await readFile(compilerDriver)) }, headers: { path: headers, files },
    sdk: { path: sdk, realPath: sdkRealPath, settingsHash: hash(await readFile(join(sdk, 'SDKSettings.json'))) }, probes };
}
export async function finishNative(root: string, output: string, env: NodeJS.ProcessEnv, before: NativeBuild, run: typeof runCommand): Promise<NativeBuild> {
  const context = { root, output, env, run };
  const path = join(root, nativeOutput); assert.equal(await realpath(path), path, 'native output symlink');
  const bytes = await readFile(path); assertMachOArm64(bytes);
  const format = await tool(context, 'file', '/usr/bin/file', [path]);
  const arch = await tool(context, 'arch', '/usr/bin/lipo', ['-archs', path]);
  assert.match(format.stdout, /Mach-O 64-bit bundle arm64/u); assert.equal(arch.stdout.trim(), 'arm64');
  const outputDigest = await tool(context, 'hash', '/usr/bin/shasum', ['-a', '256', path]);
  assert.equal(outputDigest.stdout.split(/\s+/u)[0], hash(bytes), 'native hash observation mismatch');
  await writeFile(join(output, 'rename-no-replace.node'), bytes, { flag: 'wx' });
  assert.equal(hash(await readFile(before.compiler.path)), before.compiler.sha256, 'compiler drift');
  assert.equal(hash(await readFile(before.compilerDriver.path)), before.compilerDriver.sha256, 'compiler driver drift');
  assert.equal(hash(await readFile(join(before.sdk.path, 'SDKSettings.json'))), before.sdk.settingsHash, 'SDK drift');
  for (const [name, digest] of Object.entries(before.headers.files)) {
    assert.equal(hash(await readFile(join(before.headers.path, name))), digest, 'header drift');
  }
  return { ...before, sha256: hash(bytes), format: 'Mach-O 64-bit bundle', arch: 'arm64', probes: { ...before.probes, format, arch, digest: outputDigest } };
}
