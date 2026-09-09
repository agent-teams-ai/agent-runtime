import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';
// Explicit installed compiler and absolute NEW output only. No xcrun download,
// installation, provider execution or source-derived trust digest.
const [compiler, output] = process.argv.slice(2);
if (process.platform !== 'darwin' || !compiler || !output || !isAbsolute(compiler) ||
    !isAbsolute(output) || !existsSync(compiler) || existsSync(output)) {
  throw new Error('Usage on Darwin: node build-darwin-owned-image.mjs /absolute/installed/clang /absolute/new/output');
}
const result = spawnSync(compiler, ['-arch', 'arm64', '-std=c11', '-Wall', '-Wextra', '-Werror', '-O2',
  fileURLToPath(new URL('./darwin-owned-image.c', import.meta.url)), '-lproc', '-o', output],
{stdio: 'inherit', shell: false, env: {PATH: '/usr/bin:/bin'}});
if (result.error || result.status !== 0) {process.exitCode = 1;}
