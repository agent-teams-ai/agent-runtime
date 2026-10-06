import assert from 'node:assert/strict';

type NativeProbe = { exitCode: number | null; signal: NodeJS.Signals | null; stdout: string };
export function assertNamespaceNativeQualification(outcome: string | null, native: { format: NativeProbe; arch: NativeProbe } | null): void {
  if (outcome === 'success') { assert.ok(native, 'successful full product qualification requires the actual native artifact'); }
  if (native) {
    assert.equal(native.format.exitCode, 0); assert.equal(native.format.signal, null);
    assert.match(native.format.stdout, /Mach-O 64-bit bundle arm64/u);
    assert.equal(native.arch.exitCode, 0); assert.equal(native.arch.signal, null);
    assert.equal(native.arch.stdout.trim(), 'arm64');
  }
}

export function assertNamespaceQualificationWorkflow(value: unknown): void {
  assert.deepEqual(value, {
    name: 'Namespace full product qualification', on: { workflow_dispatch: {} }, permissions: { contents: 'read' },
    jobs: { qualification: { 'runs-on': 'namespace-profile-macos-15', 'timeout-minutes': 30,
      env: { GIT_AUTHOR_NAME: 'iliya', GIT_AUTHOR_EMAIL: 'iliyazelenkog@gmail.com',
        GIT_COMMITTER_NAME: 'iliya', GIT_COMMITTER_EMAIL: 'iliyazelenkog@gmail.com',
        EXPECTED_REVISION: '${{ github.workflow_sha }}', CI_EVIDENCE_DIR: '${{ runner.temp }}/ci-namespace-qualification' },
      steps: [
        { name: 'Checkout exact workflow revision', uses: 'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803',
          with: { ref: '${{ github.workflow_sha }}', 'persist-credentials': false, 'fetch-depth': 0 } },
        { name: 'Verify checkout before running repository code', shell: 'bash',
          run: 'set -euo pipefail\n[[ "$EXPECTED_REVISION" =~ ^[a-f0-9]{40}$ ]]\ntest "$(git rev-parse HEAD)" = "$EXPECTED_REVISION"\n' },
        { name: 'Setup pinned Node', uses: 'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38', with: { 'node-version-file': '.node-version' } },
        { name: 'Verify typed revision binding', run: 'node scripts/ci/gate.ts revision' },
        { name: 'Enable pinned pnpm', run: 'corepack enable\ncorepack install --global pnpm@11.18.0\n' },
        { name: 'Install dependencies', run: 'pnpm install --frozen-lockfile' },
        { name: 'Run original full product checks', id: 'product', run: 'pnpm product:check' },
        { name: 'Capture actual Namespace platform and native evidence', if: '${{ always() }}',
          env: { PRODUCT_OUTCOME: '${{ steps.product.outcome }}' }, run: 'node scripts/ci/namespace-qualification.ts' },
        { name: 'Retain every qualification attempt', if: '${{ always() }}', uses: 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
          with: { name: 'namespace-product-qualification-${{ github.run_id }}-${{ github.run_attempt }}',
            path: '${{ runner.temp }}/ci-namespace-qualification/', 'if-no-files-found': 'error', 'retention-days': 14 } },
      ],
    } },
  }, 'Namespace canary must remain inputless, exact-source, original full product and separately observed');
}
