import { AppWebEntry } from '@deepseek-ai/dsh-client-web'
import type { DesktopTransportProvider } from '@deepseek-ai/dsh-client-connection/client'
import { createDesktopConnectionRpc } from './desktop-rpc.ts'
import { ElectronApiClient } from './electron-api-client.ts'
import { bundleIdFor, type DesktopBridge } from './bridge.ts'

const maybeBridge = (globalThis as { __dshDesktop?: DesktopBridge }).__dshDesktop
if (maybeBridge === undefined) {
  throw new Error('desktop: window.__dshDesktop missing — preload bridge not installed (contextIsolation off?)')
}
// Annotate so the type survives into loadBundle (a function declaration does
// not inherit control-flow narrowing of the captured const).
const bridge: DesktopBridge = maybeBridge

// The transport must be visible before the connection plugin (a boot graph
// entry) reads it — set synchronously so module evaluation cannot race it.
;(globalThis as { __DSH_DESKTOP_TRANSPORT__?: DesktopTransportProvider }).__DSH_DESKTOP_TRANSPORT__ = {
  createApi: () => new ElectronApiClient(bridge),
  createRpc: () => createDesktopConnectionRpc(bridge),
}

/** Bundle transport: fetch the bundle text over IPC, run it as a classic script. */
async function loadBundle(url: string): Promise<void> {
  const id = bundleIdFor(url)
  if (id === undefined) {
    throw new Error(`desktop: unexpected bundle URL ${url}`)
  }
  const source = await bridge.readBundle(id)
  const script = document.createElement('script')
  script.textContent = source
  document.head.append(script)
  script.remove()
}

// The web host injects __DSH_BOOT__ into the HTML; the desktop renderer must
// fetch it over IPC before AppWebEntry.run() parses it. Wrapped in an IIFE so
// the module keeps vite's es2020 default target (no top-level await).
void (async () => {
  ;(globalThis as { __DSH_BOOT__?: unknown }).__DSH_BOOT__ = await bridge.bootManifest()
  const root = document.getElementById('root')
  if (root === null) {
    throw new Error('desktop: #root element missing')
  }
  await new AppWebEntry(root, { loadBundle }).run()
})()
