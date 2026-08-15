/**
 * Preload for the desktop renderer: the only bridge the sandboxed page gets.
 * Exposes `window.__dshDesktop` (fetch/boot/bundle IPC + stream subscription);
 * the page stays context-isolated and node-free (sandbox: true).
 *
 * This file is shipped as-is (src/preload.cjs) and must stay require-only CJS.
 * The `dsh:stream:` channel prefix mirrors streamChannel() in src/bridge.ts.
 */
const { contextBridge, ipcRenderer } = require('electron')

const CHANNELS = {
  fetch: 'dsh:fetch',
  bundle: 'dsh:bundle',
  boot: 'dsh:boot',
  streamControl: 'dsh:stream-control',
}

contextBridge.exposeInMainWorld('__dshDesktop', {
  fetch: (request) => ipcRenderer.invoke(CHANNELS.fetch, request),
  readBundle: (id) => ipcRenderer.invoke(CHANNELS.bundle, id),
  bootManifest: () => ipcRenderer.invoke(CHANNELS.boot),
  openStream: (streamId, path) =>
    ipcRenderer.invoke(CHANNELS.streamControl, { action: 'open', streamId, path }),
  closeStream: (streamId) =>
    ipcRenderer.invoke(CHANNELS.streamControl, { action: 'close', streamId }),
  onStream: (streamId, listener) => {
    const channel = `dsh:stream:${streamId}`
    const handler = (_event, message) => listener(message)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  },
})
