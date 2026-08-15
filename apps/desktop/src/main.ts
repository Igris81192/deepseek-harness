/**
 * Electron main process for the dsh desktop app. Boots the `web` profile
 * in-process with runProfile (the webserver stays mounted — v1 keeps the
 * network path; see Known Limitations in apps/desktop/README.md) and serves
 * its API, boot graph, and plugin bundles to the file:// renderer over the IPC
 * bridges in src/bridge.ts. Only this process may hold the host Context merges
 * (ctx.apiProxy / ctx.clientModules); the renderer is a client-plane program
 * and never sees them.
 */

import { app, BrowserWindow, ipcMain, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import type { Context } from '@deepseek-ai/cordis'
import {
  RpcId,
  type ApiProxy, type HostFrame, type MuxFrame, type RpcRequest, type ServerRequest,
} from '@deepseek-ai/dsh-host-apiproxy'
// Activates the ctx.connection Context merge for the composed /api dispatcher.
import type {} from '@deepseek-ai/dsh-client-connection'
import type { ClientModuleRegistry } from '@deepseek-ai/dsh-client-modules'
import {
  HOST_EVENTS_PATH, IPC_BOOT_CHANNEL, IPC_BUNDLE_CHANNEL, IPC_FETCH_CHANNEL,
  IPC_STREAM_CONTROL_CHANNEL, MUX_EVENTS_PATH, streamChannel,
  type SerializedRequest, type StreamControlMessage, type StreamMessage,
} from './bridge.ts'

/** This compiled file lives in apps/desktop/lib/; the package root is one level up. */
const APP_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')

/** Complete a narrow frame into a full server-request (mirror of handler.ts's fullFrame). */
function fullFrame(narrow: RpcRequest<MuxFrame | HostFrame>): ServerRequest {
  return { type: 'server-request', rpcId: narrow.rpcId, method: narrow.payload.type, payload: narrow.payload }
}

/** Pick the mux or host frame stream by path (both answer a bare {} payload). */
function frameStream(
  events: ApiProxy['events'], path: string, signal: AbortSignal,
): AsyncIterable<RpcRequest<MuxFrame | HostFrame>> {
  return path === MUX_EVENTS_PATH
    ? events.mux({ rpcId: RpcId(randomUUID()), payload: {} }, signal)
    : events.host({ rpcId: RpcId(randomUUID()), payload: {} }, signal)
}

/** Read one plugin's client bundle from the modules registry (never undefined for a graph id). */
async function readClientBundle(modules: ClientModuleRegistry, id: string): Promise<string> {
  const path = modules.clientPath(id)
  if (path === undefined) throw new Error(`desktop: no client bundle for "${id}"`)
  return readFile(path, 'utf8')
}

function installIpcHandlers(ctx: Context): void {
  // The composed /api dispatcher (generic RPC-channel interception, then the
  // privileged-method loopback pin, the events upgrade fence, and the API Proxy
  // fallback) — the exact handler the web HTTP bridge serves. Requests are
  // built against a loopback authority with an explicit loopback Host header so
  // the trusted in-process renderer is classified loopback exactly like a
  // browser tab at 127.0.0.1: generic RPC channels (dynamicCordisRunner) route,
  // and the pinned settings/credentials/host methods the surface needs stay
  // reachable.
  const composed = ctx.connection.createApiFetchHandler()
  const handler = (request: Request): Promise<Response> => composed.fetch(request)

  ipcMain.handle(IPC_FETCH_CHANNEL, async (_event, request: SerializedRequest) => {
    if (request.path === MUX_EVENTS_PATH || request.path === HOST_EVENTS_PATH) {
      throw new Error(`desktop: ${request.path} must use the stream channel, not ${IPC_FETCH_CHANNEL}`)
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
  })

  ipcMain.handle(IPC_BOOT_CHANNEL, () => ctx.clientModules.graph())
  ipcMain.handle(IPC_BUNDLE_CHANNEL, (_event, id: string) => readClientBundle(ctx.clientModules, id))

  const streams = new Map<string, AbortController>()
  ipcMain.handle(IPC_STREAM_CONTROL_CHANNEL, (event, control: StreamControlMessage) => {
    if (control.action === 'close') {
      const controller = streams.get(control.streamId)
      if (controller !== undefined) {
        controller.abort()
        streams.delete(control.streamId)
      }
      return
    }
    const controller = new AbortController()
    streams.set(control.streamId, controller)
    void pumpStream(event.sender, control.streamId, control.path, controller.signal)
  })

  async function pumpStream(
    sender: WebContents, streamId: string, path: string, signal: AbortSignal,
  ): Promise<void> {
    const send = (message: StreamMessage): void => {
      if (!sender.isDestroyed()) sender.send(streamChannel(streamId), message)
    }
    try {
      for await (const narrow of frameStream(ctx.apiProxy.events, path, signal)) {
        send({ kind: 'frame', serverRequest: fullFrame(narrow) })
      }
    } catch (error) {
      // Mid-stream failure: one stream/error frame, then end — the client must
      // see the failure instead of a silent close.
      const failure: MuxFrame | HostFrame = {
        type: 'stream/error', error: { code: 'internal', message: String(error), details: {} },
      }
      send({ kind: 'frame', serverRequest: fullFrame({ rpcId: RpcId(randomUUID()), payload: failure }) })
    } finally {
      streams.delete(streamId)
      send({ kind: 'end' })
    }
  }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'DeepSeek Harness',
    webPreferences: {
      preload: join(APP_ROOT, 'src', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  void win.loadFile(join(APP_ROOT, 'dist', 'index.html'))
  return win
}

async function main(): Promise<void> {
  await app.whenReady()
  const { ctx, shutdown } = await runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: 'web',
    patchFiles: [],
    // The renderer reaches the host over IPC, never the webserver, so request
    // an OS-assigned port (`--port 0`): a concurrently running `dsh web` on the
    // default port must not block the desktop boot, and nothing to bind is
    // lost. v1 still mounts the webserver for compatibility (see README).
    args: ['--port', '0'],
  })
  installIpcHandlers(ctx)
  createWindow()

  let quitting = false
  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    quitting = true
    void shutdown.shutdown(0).finally(() => { app.quit() })
  })
  app.on('window-all-closed', () => { app.quit() })
}

main().catch((error: unknown) => {
  console.error('desktop: boot failed:', error)
  app.exit(1)
})
