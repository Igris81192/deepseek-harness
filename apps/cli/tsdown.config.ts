import { defineConfig } from 'tsdown'

/**
 * The dsh CLI ships the `bin` referenced by package.json `bin` plus the
 * `profile-boot` subpath consumed by embedding hosts (the Electron desktop
 * main). The root tsdown builds only `lib/types/index.js`, so this override
 * points at `lib/types/bin.js` and `lib/types/profile-boot.js` instead; their
 * reachable mode modules bundle with them. Declarations come from `tsc -b`
 * (dts: false), matching every package.
 */
export default defineConfig({
  entry: ['lib/types/bin.js', 'lib/types/profile-boot.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
