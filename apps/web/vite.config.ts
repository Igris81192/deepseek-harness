import { fileURLToPath } from 'node:url'
import { defineViteShell } from './vite.shell.ts'

const src = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url))

export default defineViteShell({
  appDir: new URL('.', import.meta.url),
  appName: 'apps/web',
  standaloneHint: 'From a repository checkout, run `pnpm dsh web`; an installed package uses `dsh web`. '
    + 'For client-plugin HMR, run `pnpm dsh web` together with `pnpm run dev:web`.',
  nodeModuleStub: src('./src/node-module-stub.ts'),
})
