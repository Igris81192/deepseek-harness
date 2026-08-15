import { RpcId, serverResponseSchema, type ClientRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import { decodeBase64 } from './base64.ts'
import type { DesktopBridge } from './bridge.ts'

const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

/**
 * IPC-carried generic logical-channel RPC caller — the desktop twin of
 * createWebConnectionRpc: the same envelope validation, with the transport leg
 * swapped from browser fetch to the preload bridge.
 */
export function createDesktopConnectionRpc(bridge: DesktopBridge): ClientConnectionRpc {
  return {
    async call(channel, endpoint, payload) {
      assertTarget(channel, endpoint)
      const rpcId = RpcId(crypto.randomUUID())
      const message: ClientRequest = { type: 'client-request', rpcId, method: endpoint, payload }
      const response = await bridge.fetch({
        path: `${channel}/${endpoint}`,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(message),
      })
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`connection: transport failure for ${channel}/${endpoint}: HTTP ${response.status}`)
      }
      const full = serverResponseSchema.parse(JSON.parse(new TextDecoder().decode(decodeBase64(response.body))))
      if (full.rpcId !== rpcId) {
        throw new Error(`connection: rpcId mismatch for ${endpoint}: sent ${rpcId}, got ${full.rpcId}`)
      }
      return full.result
    },
  }
}

/** Reject channel/endpoint shapes that could escape the host route table (mirror of the web rpc's assertTarget). */
function assertTarget(channel: string, endpoint: string): void {
  const segments = endpoint.split('/')
  const invalid = !CHANNEL_PATTERN.test(channel)
    || segments.some(segment =>
      segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))
  if (invalid) {
    throw new Error(`connection: invalid RPC target ${JSON.stringify(`${channel}/${endpoint}`)}`)
  }
}
