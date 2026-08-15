/**
 * Renderer-side desktop carrier tests. The fixture (fake-desktop-bridge.ts) is
 * the main-process twin; the tests drive ElectronApiClient and
 * createDesktopConnectionRpc against it and assert the same wire behavior as
 * the reference InProcessApiClient over the real toFetchHandler protocol — so
 * the IPC round trip is validated without booting Electron.
 */

import { describe, expect, it } from 'vitest'
import {
  InProcessApiClient, RpcId, toFetchHandler, type RpcRequest,
} from '@deepseek-ai/dsh-host-apiproxy'
import { decodeBase64 } from '../src/base64.ts'
import { bundleIdFor } from '../src/bridge.ts'
import { ElectronApiClient } from '../src/electron-api-client.ts'
import { fakeApi, fakeDesktopBridge } from './fake-desktop-bridge.ts'

/** Collect every frame an async iterable yields (drives each stream to its end). */
async function collect<F>(stream: AsyncIterable<RpcRequest<F>>): Promise<RpcRequest<F>[]> {
  const frames: RpcRequest<F>[] = []
  for await (const frame of stream) frames.push(frame)
  return frames
}

describe('base64 IPC bodies', () => {
  it('round-trips the Buffer encoding the main process produces', () => {
    const bytes = new TextEncoder().encode('session.export can be binary')
    expect(new TextDecoder().decode(decodeBase64(Buffer.from(bytes).toString('base64'))))
      .toBe('session.export can be binary')
  })
})

describe('bundle loading', () => {
  it('decodes client-module bundle URLs into raw plugin ids (scoped and bare)', () => {
    expect(bundleIdFor('/plugins/@scope/name/client.js?rev=7')).toBe('@scope/name')
    expect(bundleIdFor('/plugins/plain/client.js')).toBe('plain')
    expect(bundleIdFor('/assets/index-abc.js')).toBeUndefined()
    expect(bundleIdFor('/plugins/')).toBeUndefined()
  })

  it('serves the decoded id over the readBundle bridge leg', async () => {
    const bridge = fakeDesktopBridge(fakeApi())
    const source = await bridge.readBundle(bundleIdFor('/plugins/@scope/name/client.js?rev=7')!)
    expect(source).toContain('@scope/name')
  })
})

describe('ElectronApiClient unary leg', () => {
  it('delivers host.describe identically to the in-process reference carrier', async () => {
    const api = fakeApi({ describeValue: { version: '0.1.0', cwd: '/work', attachedSessions: 2, canOpenPath: true } })
    const bridge = fakeDesktopBridge(api)
    const electron = new ElectronApiClient(bridge)
    const reference = new InProcessApiClient(toFetchHandler(api))
    const [electronResult, referenceResult] = await Promise.all([
      electron.host.describe({}),
      reference.host.describe({}),
    ])
    expect(electronResult.rpcId).toBeTypeOf('string')
    // Each client mints its own rpcId; the carried value must match exactly.
    expect(electronResult.result).toEqual(referenceResult.result)
    expect(electronResult.result).toEqual({
      ok: true, value: { version: '0.1.0', cwd: '/work', attachedSessions: 2, canOpenPath: true },
    })
  })

  it('surfaces a handler crash as the same HTTP-500 transport failure', async () => {
    const api = fakeApi({ crashDescribe: true })
    const bridge = fakeDesktopBridge(api)
    const electron = new ElectronApiClient(bridge)
    const reference = new InProcessApiClient(toFetchHandler(api))
    await expect(electron.host.describe({})).rejects.toThrow('transport failure for /api/host.describe: HTTP 500')
    await expect(reference.host.describe({})).rejects.toThrow('transport failure for /api/host.describe: HTTP 500')
  })

  it('rejects a stale rpcId echo like the in-process carrier', async () => {
    const api = fakeApi({ describeEcho: 'stale-echo' })
    const bridge = fakeDesktopBridge(api)
    const electron = new ElectronApiClient(bridge)
    const reference = new InProcessApiClient(toFetchHandler(api))
    await expect(electron.host.describe({})).rejects.toThrow(/rpcId mismatch for host\.describe/)
    await expect(reference.host.describe({})).rejects.toThrow(/rpcId mismatch for host\.describe/)
  })

  it('keeps loopback-privileged methods reachable through the composed dispatcher', async () => {
    // settings.describe is pinned to loopback: with the bridge building requests
    // against 127.0.0.1 exactly as main.ts does, the pin passes and the method
    // routes to the host. A non-loopback host construction would make the fence
    // refuse it (403), so this pins the desktop renderer's loopback trust class.
    const api = fakeApi()
    const bridge = fakeDesktopBridge(api)
    const electron = new ElectronApiClient(bridge)
    await expect(electron.settings.describe({}))
      .resolves.toMatchObject({ result: { ok: true, value: { writable: false, hasDocument: false, namespaces: [] } } })
  })
})

describe('ElectronApiClient stream leg', () => {
  it('pumps mux frames identically to the in-process reference carrier', async () => {
    const api = fakeApi()
    const bridge = fakeDesktopBridge(api)
    const electron = new ElectronApiClient(bridge)
    const reference = new InProcessApiClient(toFetchHandler(api))
    const [electronFrames, referenceFrames] = await Promise.all([
      collect(electron.events.mux({}, new AbortController().signal)),
      collect(reference.events.mux({}, new AbortController().signal)),
    ])
    expect(electronFrames).toEqual(referenceFrames)
    expect(electronFrames).toEqual([{ rpcId: RpcId('frame-0'), payload: { type: 'session/subscribed', sessionId: 's1', lastSeq: -1 } }])
  })

  it('pumps host frames identically to the in-process reference carrier', async () => {
    const api = fakeApi()
    const bridge = fakeDesktopBridge(api)
    const electron = new ElectronApiClient(bridge)
    const reference = new InProcessApiClient(toFetchHandler(api))
    const [electronFrames, referenceFrames] = await Promise.all([
      collect(electron.events.host({}, new AbortController().signal)),
      collect(reference.events.host({}, new AbortController().signal)),
    ])
    expect(electronFrames).toEqual(referenceFrames)
    expect(electronFrames).toEqual([{ rpcId: RpcId('frame-0'), payload: { type: 'host/remote-event', event: 'commands/change', args: [] } }])
  })

  it('turns a mid-stream impl failure into a stream/error frame then end', async () => {
    const api = fakeApi({ crashMux: true })
    const bridge = fakeDesktopBridge(api)
    const electron = new ElectronApiClient(bridge)
    const reference = new InProcessApiClient(toFetchHandler(api))
    const electronPayloads = (await collect(electron.events.mux({}, new AbortController().signal))).map(f => f.payload)
    const referencePayloads = (await collect(reference.events.mux({}, new AbortController().signal))).map(f => f.payload)
    expect(electronPayloads).toEqual(referencePayloads)
    expect(electronPayloads).toEqual([
      { type: 'session/subscribed', sessionId: 's1', lastSeq: -1 },
      // String(error) in main.ts / handler.ts prefixes an Error instance.
      { type: 'stream/error', error: { code: 'internal', message: 'Error: fixture stream impl failure', details: {} } },
    ])
  })

  it('ends cleanly when the SSE consumer cancels the read', async () => {
    const bridge = fakeDesktopBridge(fakeApi())
    const client = new ElectronApiClient(bridge)
    const mux = client.events.mux({}, new AbortController().signal)[Symbol.asyncIterator]()
    expect((await mux.next()).value).toMatchObject({ payload: { type: 'session/subscribed' } })
    // Cancelling the response body must close the IPC stream without throwing.
    await mux.return!()
    await expect(mux.next()).resolves.toMatchObject({ done: true })
  })
})
