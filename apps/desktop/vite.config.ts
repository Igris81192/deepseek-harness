import { fileURLToPath } from 'node:url'
import { defineViteShell } from '../web/vite.shell.ts'

const src = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url))

export default defineViteShell({
  appDir: new URL('.', import.meta.url),
  appName: 'apps/desktop',
  standaloneHint: 'The desktop renderer has no __DSH_BOOT__ without the Electron host: run `pnpm run build && pnpm run desktop:build`, then launch with `pnpm run desktop:dev`.',
  // The shell loads over file:// in the Electron renderer, so built asset
  // URLs must be relative — absolute `/assets/...` paths would resolve to the
  // filesystem root.
  base: './',
  nodeModuleStub: src('./src/node-module-stub.ts'),
  extraAliases: [
    // The renderer bundles the connection/apiproxy transport directly (the
    // web shell does not — it arrives in plugin bundles); compile them from
    // source like every other workspace alias above.
    { find: /^@deepseek-ai\/dsh-client-connection\/client$/, replacement: src('../../packages/client/connection/src/client/index.ts') },
    { find: /^@deepseek-ai\/dsh-host-apiproxy\/api$/, replacement: src('../../packages/host/apiproxy/src/api/index.ts') },
    { find: /^@deepseek-ai\/dsh-host-apiproxy\/client$/, replacement: src('../../packages/host/apiproxy/src/fetch/client.ts') },
  ],
})
