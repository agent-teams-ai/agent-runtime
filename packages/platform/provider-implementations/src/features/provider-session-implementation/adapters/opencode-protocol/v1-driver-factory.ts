import type { DriverFactory, OpenConfig } from '@agent-teams/agent-execution/interactive-contracts'
import { OpenCodeDriverSession } from './driver-session.ts'
import { createV1DriverBackend } from './v1-driver-backend.ts'
import { snapshotV1Config, v1Compatibility } from './v1-driver-config.ts'
import type { OpenCodeV1DriverConfig } from './v1-driver-config.ts'
export type OpenCodeV1DriverHost = {
  resolveConfiguration: (request: OpenConfig) => Promise<OpenCodeV1DriverConfig | undefined>
  readCheckpoint: (reference: string, request: OpenConfig) => Promise<unknown>
  capabilities: readonly string[]
}
const supported = new Set(['text', 'tools', 'permission', 'interrupt', 'checkpoint'])
/** Existing explicitly selected V1 native session only; no Host/bootstrap/materialization. */
export function createOpenCodeV1DriverFactory(host: OpenCodeV1DriverHost): DriverFactory {
  const capabilities = Object.freeze([...host.capabilities])
  if (capabilities.some(value => !supported.has(value)) || new Set(capabilities).size !== capabilities.length) {throw new Error('opencode.v1.unsupported')}
  return { async open(request) {
    const selected = Object.freeze({ ...request, requiredCapabilities: Object.freeze([...request.requiredCapabilities]) })
    if (selected.requiredCapabilities.some(value => !capabilities.includes(value))) {throw new Error('opencode.v1.unsupported')}
    let config: OpenCodeV1DriverConfig
    try {
      const resolved = await host.resolveConfiguration(selected)
      if (!resolved) {throw new Error('missing')}
      config = snapshotV1Config(resolved, selected)
    } catch { throw new Error('opencode.v1.invalid-config') }
    const compatibility = v1Compatibility(config)
    if (selected.checkpointRef !== undefined) {
      let checkpoint: unknown
      try { checkpoint = await host.readCheckpoint(selected.checkpointRef, selected) }
      catch { throw new Error('opencode.v1.checkpoint-missing') }
      if (checkpoint === undefined) {throw new Error('opencode.v1.checkpoint-missing')}
      const cp = checkpoint as Record<string, unknown> | null
      if (!cp || cp.version !== 1 || cp.engine !== 'opencode-v1' || cp.nativeSessionId !== config.nativeSessionId || cp.compatibility !== compatibility) {throw new Error('opencode.v1.checkpoint-incompatible')}
    }
    const driver = new OpenCodeDriverSession({ ...config, engine: 'opencode-v1', compatibility }, signal => createV1DriverBackend(config, signal))
    const ready = await driver.checkReadiness()
    if (!ready.ok) { await driver.close(); throw new Error('opencode.v1.' + ready.code) }
    return { driver, capabilities }
  } }
}
