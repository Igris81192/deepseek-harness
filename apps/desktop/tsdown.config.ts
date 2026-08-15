import { defineConfig } from 'tsdown'

/**
 * The Electron main bundles from the tsc-emitted host tree (same shape as
 * apps/cli): `lib/types/main.js` plus its reachable `./bridge.js` compile to
 * the single `lib/main.js` the package.json `main` points at. Electron stays
 * external (the runtime provides it); every workspace import resolves from
 * node_modules at runtime. Declarations come from `tsc -b` (dts: false),
 * matching every package.
 */
export default defineConfig({
  entry: { main: 'lib/types/main.js' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: {
    neverBundle: ['electron'],
  },
})
