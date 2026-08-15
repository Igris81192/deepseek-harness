/**
 * In-memory twin of the Electron main process IPC handlers (apps/desktop/
 * src/main.ts): the renderer carrier tests drive the renderer side of all four
 * bridges against this fixture instead of a real Electron window. The unary/
 * respond leg runs the same composed `/api` dispatcher main.ts serves — a real
 * HostConnectionService over the scripted api, so the fixture exercises the
 * trust fence and request construction rather than a re-implementation of them —
 * and the stream leg pumps api.events.mux/host frames with the same
 * stream/error-then-end discipline, so the tests hit the actual wire shapes.
 */

import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import {
  RpcId,
  type ApiProxy, type HostFrame, type MuxFrame, type RpcRequest, type ServerRequest,
} from '@deepseek-ai/dsh-host-apiproxy'
import {
  HOST_EVENTS_PATH, MUX_EVENTS_PATH,
  type DesktopBridge, type SerializedRequest, type StreamMessage,
} from '../src/bridge.ts'

/** Default mux stream frame (session subscription). */
const SUBSCRIBED_FRAME: MuxFrame = { type: 'session/subscribed', sessionId: 's1' as never, lastSeq: -1 }
/** Default host stream frame. */
const REMOTE_EVENT_FRAME: HostFrame = { type: 'host/remote-event', event: 'commands/change', args: [] }

/** Value host.describe answers when the test does not script one. */
export const DEFAULT_DESCRIBE_VALUE = {
  version: '0.0.0-fixture',
  cwd: '/tmp',
  attachedSessions: 0,
  canOpenPath: false,
} as const

/** Behavior knobs for {@link fakeApi}. */
export interface ApiOverrides {
  /** Value host.describe resolves to (a valid hostDescribeValueSchema shape). */
  describeValue?: {
    version: string
    cwd: string
    attachedSessions: number
    canOpenPath: boolean
  }
  /** Stale echo rpcId to script; absent, describe echoes the request's own rpcId. */
  describeEcho?: string
  /** Frames the mux stream yields before ending. */
  muxFrames?: MuxFrame[]
  /** Frames the host stream yields before ending. */
  hostFrames?: HostFrame[]
  /** host.describe throws (the handler then answers HTTP 500). */
  crashDescribe?: boolean
  /** events.mux throws after its frames (the pump then emits stream/error, then end). */
  crashMux?: boolean
}

/**
 * A host-side ApiProxy covering just the surface the carrier tests drive. The
 * untyped members are cast at the object boundary: toFetchHandler dispatches
 * only the routes this fixture scripts (host.describe plus the two event
 * streams), so the rest of the ApiProxy interface is never reached.
 */
export function fakeApi(overrides: ApiOverrides = {}): ApiProxy {
  const muxFrames = overrides.muxFrames ?? [SUBSCRIBED_FRAME]
  const hostFrames = overrides.hostFrames ?? [REMOTE_EVENT_FRAME]
  async function * stream<F>(frames: F[], signal: AbortSignal, crash: boolean): AsyncGenerator<RpcRequest<F>> {
    for (const payload of frames) {
      if (signal.aborted) return
      yield { rpcId: RpcId(`frame-${frames.indexOf(payload)}`), payload }
    }
    if (crash) throw new Error('fixture stream impl failure')
  }
  // Members are typed against the ApiProxy sub-interfaces so the payload
  // parameter carries no implicit any (a mux payload is a full RpcRequest).
  const events: ApiProxy['events'] = {
    mux: (_payload: unknown, signal: AbortSignal) => stream(muxFrames, signal, overrides.crashMux ?? false),
    host: (_payload: unknown, signal: AbortSignal) => stream(hostFrames, signal, false),
  }
  // host is not annotated against ApiProxy['host'] — HostApi also carries
  // pickDirectory/listDirectory/createDirectory/openPath this fixture never
  // scripts; the members are typed in place and the whole object is cast below.
  const host = {
    describe: async (request: { rpcId: RpcId }) => {
      if (overrides.crashDescribe) throw new Error('fixture describe crash')
      return {
        rpcId: overrides.describeEcho === undefined ? request.rpcId : RpcId(overrides.describeEcho),
        result: { ok: true, value: overrides.describeValue ?? DEFAULT_DESCRIBE_VALUE },
      }
    },
  }
  // A loopback-privileged method (settings.describe is in PRIVILEGED_METHODS):
  // the carrier spec asserts it stays reachable through the composed dispatcher
  // with the loopback Host header, pinning the desktop renderer's trust class.
  const settings = {
    describe: async (request: { rpcId: RpcId }) => ({
      rpcId: request.rpcId,
      result: { ok: true, value: { writable: false, hasDocument: false, namespaces: [] } },
    }),
  }
  return {
    events, host, settings,
    respond: async (request: { rpcId: RpcId }) => ({ ok: true, rpcId: request.rpcId }),
  } as unknown as ApiProxy
}

/** Complete a narrow frame into a full server-request (mirror of main.ts's fullFrame). */
function fullFrame(narrow: RpcRequest<MuxFrame | HostFrame>): ServerRequest {
  return { type: 'server-request', rpcId: narrow.rpcId, method: narrow.payload.type, payload: narrow.payload }
}

/** Pick the mux or host frame stream by path (mirror of main.ts's frameStream). */
function frameStream(
  events: ApiProxy['events'], path: string, signal: AbortSignal,
): AsyncIterable<RpcRequest<MuxFrame | HostFrame>> {
  return path === MUX_EVENTS_PATH
    ? events.mux({ rpcId: RpcId(randomUUID()), payload: {} }, signal)
    : events.host({ rpcId: RpcId(randomUUID()), payload: {} }, signal)
}

/**
 * Build the renderer-facing bridge over a fake ApiProxy. Mirrors main.ts's
 * wiring: the scripted api is provided as apiProxy and the composed /api
 * dispatcher serves the fetch leg, so requests built with the loopback Host
 * header (exactly as main constructs them) pass the trust fence and route. The
 * fixture scripts no shared-channel interceptors, so dispatch falls through to
 * the api-proxy fallback the carrier tests drive.
 */
export function fakeDesktopBridge(api: ApiProxy): DesktopBridge {
  const ctx = new Context()
  ctx.provide('apiProxy', api)
  new HostConnectionService(ctx, [])
  const composed = ctx.connection.createApiFetchHandler()
  const handler = (request: Request): Promise<Response> => composed.fetch(request)
  const listeners = new Map<string, (message: StreamMessage) => void>()
  const streams = new Map<string, AbortController>()

  return {
    async fetch(request: SerializedRequest) {
      if (request.path === MUX_EVENTS_PATH || request.path === HOST_EVENTS_PATH) {
        throw new Error(`desktop: ${request.path} must use the stream channel, not the fetch channel`)
      }
      const response = await handler(new Request(`http://127.0.0.1${request.path}`, {
        method: request.method,
        headers: { ...request.headers, host: '127.0.0.1' },
        ...(request.body === undefined ? {} : { body: request.body }),
      }))
      const body = await response.arrayBuffer()
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: Buffer.from(body).toString('base64'),
      }
    },
    async readBundle(id: string) {
      return `window.__dshBundleFixture = ${JSON.stringify(id)}`
    },
    async bootManifest() {
      return { format: 'fixture', version: 1 }
    },
    onStream(streamId, listener) {
      listeners.set(streamId, listener)
      return () => { listeners.delete(streamId) }
    },
    async openStream(streamId, path) {
      const controller = new AbortController()
      streams.set(streamId, controller)
      void pump(streamId, path, controller.signal)
    },
    async closeStream(streamId) {
      const controller = streams.get(streamId)
      if (controller !== undefined) {
        controller.abort()
        streams.delete(streamId)
      }
    },
  }

  async function pump(streamId: string, path: string, signal: AbortSignal): Promise<void> {
    const send = (message: StreamMessage): void => {
      const listener = listeners.get(streamId)
      if (listener !== undefined) listener(message)
    }
    try {
      for await (const narrow of frameStream(api.events, path, signal)) {
        send({ kind: 'frame', serverRequest: fullFrame(narrow) })
      }
    } catch (error) {
      const failure: MuxFrame | HostFrame = {
        type: 'stream/error', error: { code: 'internal', message: String(error), details: {} },
      }
      send({ kind: 'frame', serverRequest: fullFrame({ rpcId: RpcId(randomUUID()), payload: failure }) })
    } finally {
      send({ kind: 'end' })
    }
  }
}
