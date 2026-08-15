/**
 * Wire contract shared by the Electron main process and the file:// renderer
 * over IPC. The preload (src/preload.cjs) exposes a {@link DesktopBridge} to
 * the page as `window.__dshDesktop`; the main process owns the matching
 * ipcMain handlers and stream pump. These message shapes are the only coupling
 * between the two processes, so the file compiles into both the host and client
 * leaves and touches neither node nor DOM globals.
 */

export const IPC_FETCH_CHANNEL = 'dsh:fetch'
export const IPC_BUNDLE_CHANNEL = 'dsh:bundle'
export const IPC_BOOT_CHANNEL = 'dsh:boot'
export const IPC_STREAM_CONTROL_CHANNEL = 'dsh:stream-control'

/** Downlink paths the fetch carrier must route to the stream channel instead. */
export const MUX_EVENTS_PATH = '/api/events.mux'
export const HOST_EVENTS_PATH = '/api/events.host'

/**
 * Per-stream frame channel. The preload hardcodes the `dsh:stream:` prefix to
 * stay require-only CJS — keep it in sync here if the prefix ever changes.
 */
export const streamChannel = (streamId: string): string => `dsh:stream:${streamId}`

/**
 * Decode a client-module bundle URL into its plugin id
 * (`/plugins/<id>/client.js?rev=…`, where `<id>` is the raw registry id and may
 * contain a scope slash). Any other URL is not a bundle and returns undefined.
 */
export function bundleIdFor(url: string): string | undefined {
  const match = /^\/plugins\/(.+)\/client\.js(?:\?.*)?$/.exec(url)
  return match === null ? undefined : match[1]
}

/** One fetch leg forwarded over IPC (the main process rebuilds a Request from it). */
export interface SerializedRequest {
  path: string
  method: string
  headers: Record<string, string>
  body?: string
}

/** One fetch response round-tripped over IPC; the body is always base64 (session.export can be binary). */
export interface SerializedResponse {
  status: number
  headers: Record<string, string>
  body: string
}

/** A server-pushed frame or the stream's end — the only two stream messages. */
export type StreamMessage =
  | { kind: 'frame'; serverRequest: unknown }
  | { kind: 'end' }

/** Renderer → main stream control. */
export type StreamControlMessage =
  | { action: 'open'; streamId: string; path: string }
  | { action: 'close'; streamId: string }

/** The preload-exposed bridge surface the renderer transports build on. */
export interface DesktopBridge {
  fetch(request: SerializedRequest): Promise<SerializedResponse>
  readBundle(id: string): Promise<string>
  bootManifest(): Promise<unknown>
  openStream(streamId: string, path: string): Promise<void>
  closeStream(streamId: string): Promise<void>
  onStream(streamId: string, listener: (message: StreamMessage) => void): () => void
}
