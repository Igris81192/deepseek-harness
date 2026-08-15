import { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import { decodeBase64 } from './base64.ts'
import { HOST_EVENTS_PATH, MUX_EVENTS_PATH, type DesktopBridge } from './bridge.ts'

/**
 * IPC-carried ApiClient for the Electron renderer. The base class needs only
 * doFetch: unary/respond legs POST over the bridge, and the two events paths
 * open a push stream whose frames the renderer re-frames as SSE — the exact
 * `data: {json}\n\n` chunks the inherited readSse consumes.
 */
export class ElectronApiClient extends AbstractApiClient {
  constructor(private readonly bridge: DesktopBridge) {
    super()
  }

  protected doFetch(input: URL, init?: RequestInit): Promise<Response> {
    const path = `${input.pathname}${input.search}`
    if (path === MUX_EVENTS_PATH || path === HOST_EVENTS_PATH) {
      return this.openEventsResponse(path, init?.signal)
    }
    return this.unaryFetch(path, init)
  }

  private async unaryFetch(path: string, init?: RequestInit): Promise<Response> {
    const response = await this.bridge.fetch({
      path,
      method: init?.method ?? 'GET',
      headers: toHeaderRecord(init?.headers),
      ...(init?.body === undefined ? {} : { body: typeof init.body === 'string' ? init.body : JSON.stringify(init.body) }),
    })
    return new Response(decodeBase64(response.body), {
      status: response.status,
      headers: response.headers,
    })
  }

  private openEventsResponse(path: string, signal?: AbortSignal | null): Promise<Response> {
    const streamId = crypto.randomUUID()
    const encoder = new TextEncoder()
    const bridge = this.bridge
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    let unsubscribe: () => void = () => {}
    const close = (): void => {
      try {
        controller?.close()
      } catch {
        // The consumer already cancelled the stream; closing is a no-op.
      }
    }
    // ReadableStream construction runs start() synchronously, so controller is
    // set before any frame can arrive (frames only come after openStream).
    const stream = new ReadableStream<Uint8Array>({
      start(next) {
        controller = next
      },
      cancel() {
        unsubscribe()
        void bridge.closeStream(streamId)
      },
    })
    unsubscribe = bridge.onStream(streamId, (message) => {
      if (message.kind === 'end') {
        unsubscribe()
        close()
        return
      }
      try {
        controller?.enqueue(encoder.encode(`data: ${JSON.stringify(message.serverRequest)}\n\n`))
      } catch {
        // The consumer stopped reading; stop forwarding frames.
        unsubscribe()
        close()
      }
    })
    return bridge.openStream(streamId, path).then(() => {
      if (signal?.aborted) void bridge.closeStream(streamId)
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })
  }
}

/** Normalize the three HeadersInit shapes into the record the bridge carries. */
function toHeaderRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (headers === undefined) return {}
  if (headers instanceof Headers) return Object.fromEntries(headers.entries())
  if (Array.isArray(headers)) {
    const record: Record<string, string> = {}
    for (const [name, value] of headers) record[name] = value
    return record
  }
  return { ...headers }
}
