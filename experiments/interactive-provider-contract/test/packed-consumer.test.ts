import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const run = (args: string[], cwd: string) => execFileSync('pnpm', args, { cwd, encoding: 'utf8', timeout: 55000, stdio: 'pipe' });

test('packed consumer builds and resolves SDK executable outside source checkout', { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'TEST-interactive-packed-consumer-'));
  const source = fileURLToPath(new URL('../', import.meta.url));
  try {
    run(['pack', '--pack-destination', root], source);
    const archive = (await readdir(root)).find((path) => path.endsWith('.tgz')); assert(archive);
    await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module', packageManager: 'pnpm@11.18.0', dependencies: {
      '@agent-teams/interactive-provider-contract-experiment': `file:./${archive}`,
      '@anthropic-ai/sdk': '0.122.0', '@modelcontextprotocol/sdk': '1.30.0', zod: '4.6.7',
    }, devDependencies: { typescript: '7.0.2', '@types/node': '24.13.3' } }));
    run(['install', '--prefer-offline', '--ignore-scripts', '--config.minimumReleaseAge=0'], root);
    await writeFile(join(root, 'consumer.ts'), `
      import type { InteractionReply, Session } from '@agent-teams/interactive-provider-contract-experiment/draft-contracts';
      import { openClaudeSession } from '@agent-teams/interactive-provider-contract-experiment/claude';
      const reply: InteractionReply = { kind: 'question', answers: { choice: 'A' } };
      const factory: typeof openClaudeSession = openClaudeSession;
      type Consumer = Pick<Session, 'submit' | 'observe' | 'respondToInteraction' | 'close'>;
      export type { Consumer }; export { reply, factory };
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
      assert.equal(typeof openClaudeSession, 'function');
      const adapter = import.meta.resolve('@agent-teams/interactive-provider-contract-experiment/claude');
      const sdk = createRequire(adapter).resolve('@anthropic-ai/claude-agent-sdk');
      const manifest = JSON.parse(readFileSync(join(dirname(sdk), 'package.json'), 'utf8'));
      assert.equal(manifest.version, '0.3.305'); assert.equal(manifest.claudeCodeVersion, '2.1.305');
      assert(!sdk.includes(${JSON.stringify(source)}));
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
