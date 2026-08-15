/**
 * Renderer-side desktop RPC carrier tests (client aggregate). The generic
 * logical-channel caller is client-plane transport code — it imports a
 * client-owned type (ClientConnectionRpc) — so it type-checks here against a
 * minimal scripted bridge; the host-aggregate carrier tests cover the
 * ElectronApiClient legs against the main-process twin.
 */

import { describe, expect, it } from 'vitest'
import { createDesktopConnectionRpc } from '../src/desktop-rpc.ts'
import type { DesktopBridge, SerializedRequest, SerializedResponse } from '../src/bridge.ts'

/** Bridge surface with only the fetch leg scripted; the rest throw on use. */
function rpcBridge(respond: (request: SerializedRequest) => SerializedResponse): DesktopBridge {
  const unimplemented = (name: string): Error =>
    new Error(`desktop: ${name} is not scripted in the RPC client fixture`)
  return {
    fetch: async request => respond(request),
    readBundle: () => Promise.reject(unimplemented('readBundle')),
    bootManifest: () => Promise.reject(unimplemented('bootManifest')),
    openStream: () => Promise.reject(unimplemented('openStream')),
    closeStream: () => Promise.reject(unimplemented('closeStream')),
    onStream: () => () => {},
  }
}

/** Echo a ServerResponse carrying {@link result}, mirroring the main process's base64 wire body. */
function echoResponse(request: SerializedRequest, result: unknown, echoRpcId?: string): SerializedResponse {
  const sent = JSON.parse(request.body ?? '{}') as { rpcId: string }
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({
      type: 'server-response',
      rpcId: echoRpcId ?? sent.rpcId,
      result,
    })).toString('base64'),
  }
}

describe('createDesktopConnectionRpc over the bridge', () => {
  it('carries a generic RPC call and returns the echoed result', async () => {
    const value = { version: '0.0.0-fixture', cwd: '/tmp', attachedSessions: 0, canOpenPath: false }
    const rpc = createDesktopConnectionRpc(rpcBridge(request => echoResponse(request, { ok: true, value })))
    await expect(rpc.call('/api', 'host.describe', {}))
      .resolves.toEqual({ ok: true, value })
  })

  it('rejects non-routable targets before touching the bridge', async () => {
    const rpc = createDesktopConnectionRpc(rpcBridge(() => {
      throw new Error('desktop: the fetch leg must not run for a rejected target')
    }))
    for (const [channel, endpoint] of [
      ['api2', 'host.describe'],
      ['/api/path', 'host.describe'],
      ['/api', ''],
      ['/api', '.'],
      ['/api', '..'],
      ['/api', 'host//describe'],
      ['/api', 'host.describe?unsafe'],
    ] as const) {
      await expect(rpc.call(channel, endpoint, {})).rejects.toThrow('invalid RPC target')
    }
  })

  it('rejects a mismatched rpcId echo', async () => {
    const rpc = createDesktopConnectionRpc(rpcBridge(request =>
      echoResponse(request, { ok: true, value: null }, 'stale-echo')))
    await expect(rpc.call('/api', 'host.describe', {})).rejects.toThrow(/rpcId mismatch for host\.describe/)
  })
})
