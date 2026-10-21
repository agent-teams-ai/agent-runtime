import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const run = (args: string[], cwd: string) => execFileSync('pnpm', args, { cwd, encoding: 'utf8', timeout: 55000, stdio: 'pipe' });

test('packed consumer builds and resolves SDK executable outside source checkout', { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'TEST-interactive-packed-consumer-'));
  const source = fileURLToPath(new URL('../', import.meta.url));
  try {
    const workspace = resolve(source, '../..');
    const packages = [source, join(workspace, 'packages/platform/provider-implementations'),
      join(workspace, 'packages/contexts/agent-execution'), join(workspace, 'packages/platform/filesystem-custody')];
    const archives = new Map<string, string>();
    for (const [index, directory] of packages.entries()) {
      const destination = join(root, `pack-${index}`); await mkdir(destination);
      run(['pack', '--pack-destination', destination], directory);
      const names = (await readdir(destination)).filter((path) => path.endsWith('.tgz')); assert.equal(names.length, 1);
      const archive = join(destination, names[0]!);
      const manifest = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' })) as { name: string };
      archives.set(manifest.name, archive);
    }
    const archive = archives.get('@agent-teams/interactive-provider-contract-experiment'); assert(archive);
    const driver = archives.get('@agent-teams/provider-implementations'); assert(driver);
    const canonical = archives.get('@agent-teams/agent-execution'); assert(canonical);
    const custody = archives.get('@agent-teams/filesystem-custody'); assert(custody);
    await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module', packageManager: 'pnpm@11.18.0', dependencies: {
      '@agent-teams/interactive-provider-contract-experiment': `file:${archive}`,
      '@agent-teams/provider-implementations': `file:${driver}`,
      '@agent-teams/agent-execution': `file:${canonical}`,
      '@anthropic-ai/sdk': '0.122.0', '@modelcontextprotocol/sdk': '1.30.0', zod: '4.6.7',
    }, devDependencies: { typescript: '7.0.2', '@types/node': '24.13.3' } }));
    // Explicit isolated archive closure; no registry version or production alias is invented.
    await writeFile(join(root, 'pnpm-workspace.yaml'), `engineStrict: true\nstrictPeerDependencies: true\noverrides:\n  '@agent-teams/provider-implementations': 'file:${driver}'\n  '@agent-teams/agent-execution': 'file:${canonical}'\n  '@agent-teams/filesystem-custody': 'file:${custody}'\n`);
    run(['install', '--prefer-offline', '--ignore-scripts', '--config.minimumReleaseAge=0'], root);
    await writeFile(join(root, 'consumer.ts'), `
      import type { InteractionReply, Session } from '@agent-teams/interactive-provider-contract-experiment/draft-contracts';
      import type { Session as CanonicalSession } from '@agent-teams/agent-execution/interactive-contracts';
      import { openClaudeSession } from '@agent-teams/interactive-provider-contract-experiment/claude';
      const reply: InteractionReply = { kind: 'question', answers: { choice: 'A' } };
      const factory: typeof openClaudeSession = openClaudeSession;
      type Consumer = Pick<Session, 'submit' | 'observe' | 'respondToInteraction' | 'close'>;
      const canonicalIdentity = (session: Session): CanonicalSession => session;
      export type { Consumer }; export { reply, factory, canonicalIdentity };
    `);
    await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, target: 'ES2024', lib: ['ES2024', 'DOM', 'DOM.Iterable'], skipLibCheck: false, noEmit: true }, files: ['consumer.ts'] }));
    run(['exec', 'tsc', '-p', 'tsconfig.json'], root);
    await writeFile(join(root, 'consumer.mjs'), `
      import assert from 'node:assert/strict';
      import { createRequire } from 'node:module';
      import { dirname, join } from 'node:path';
      import { accessSync, constants, readFileSync } from 'node:fs';
      import { fileURLToPath } from 'node:url';
      import { openClaudeSession } from '@agent-teams/interactive-provider-contract-experiment/claude';
      import { openClaudeSession as implementation } from '@agent-teams/provider-implementations/claude';
      assert.equal(typeof openClaudeSession, 'function');
      assert.equal(openClaudeSession, implementation, 'compatibility facade preserves the single implementation');
      const provider = import.meta.resolve('@agent-teams/provider-implementations/claude');
      const sdk = createRequire(provider).resolve('@anthropic-ai/claude-agent-sdk');
      const manifest = JSON.parse(readFileSync(join(dirname(sdk), 'package.json'), 'utf8'));
      assert.equal(manifest.version, '0.3.305'); assert.equal(manifest.claudeCodeVersion, '2.1.305');
      assert(!sdk.includes(${JSON.stringify(source)}));
      assert(!provider.includes(${JSON.stringify(workspace)}));
      const native = createRequire(sdk).resolve('@anthropic-ai/claude-agent-sdk-' + process.platform + '-' + process.arch + '/package.json');
      const executable = join(dirname(native), process.platform === 'win32' ? 'claude.exe' : 'claude');
      accessSync(executable, constants.X_OK);
      console.log(JSON.stringify({ sdk: manifest.version, cli: manifest.claudeCodeVersion, platform: process.platform + '-' + process.arch, packed: true }));
    `);
    const output = execFileSync(process.execPath, ['consumer.mjs'], { cwd: root, encoding: 'utf8', timeout: 10000 });
    assert.deepEqual(JSON.parse(output), { sdk: '0.3.305', cli: '2.1.305', platform: `${process.platform}-${process.arch}`, packed: true });
    const lock = await readFile(join(root, 'pnpm-lock.yaml'), 'utf8'); assert(!lock.includes('link:'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
