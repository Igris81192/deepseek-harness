/**
 * Shared Vite shell configuration for the `dsh` browser-surface apps
 * (apps/web and the Electron desktop renderer). Both shells bundle the same
 * workspace client kernel — the client/web boot over the vendored cordis
 * Loader, with workspace packages resolved to SOURCE — split the same vendor
 * chunks, and stub the same process globals. The desktop renderer adds the
 * connection/apiproxy source aliases its IPC transport needs and loads under
 * `file://` (`base: './'`); the shell factory is parameterized for those two
 * differences plus the standalone-serve rejection copy.
 */

import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/** Options for {@link defineViteShell}. */
export interface ViteShellOptions {
  /** Absolute URL of the app directory; app-relative and repo-relative paths resolve against it. */
  appDir: string | URL
  /** App label for the standalone-serve rejection message (e.g. 'apps/web'). */
  appName: string
  /** Guidance appended to the standalone-serve rejection message. */
  standaloneHint: string
  /** Base for built asset URLs — './' makes the bundle loadable from file://. */
  base?: string
  /** App-owned browser stub for `node:module` (the vendored Loader's only node import). */
  nodeModuleStub: string
  /** Extra workspace aliases appended after the shared shell aliases (order matters: subpath aliases must win over bare-name prefixes). */
  extraAliases?: ReadonlyArray<{ find: string | RegExp; replacement: string }>
}

/** Resolve `rel` against the app directory (same semantics as the per-app `src()` helper). */
const src = (appDir: string | URL, rel: string): string => fileURLToPath(new URL(rel, appDir))

/**
 * Vendor-chunk membership, by exact npm package name — the heavy render
 * families (math, highlight, markdown) that change only on dependency bumps.
 * Only packages workspace code imports DIRECTLY need listing: their private
 * transitive dependencies (oniguruma machinery, character tables, …) are
 * imported solely by these and rollup's chunk coloring pulls them into
 * vendor automatically. A dependency shared with index-side code falls back
 * to index — a few kB of dilution, never a correctness problem. Anything not
 * listed (react family, the vendored cordis workspace, tiny helpers like
 * anser/clsx, all workspace code) stays in the default `index` chunk, so
 * editing shell code re-hashes only index and returning clients keep the
 * cached vendor chunk.
 *
 * Every member must be React-free. A package that
 * imports react/jsx-runtime must never be listed — rollup folds a module
 * shared between the entry and a manual chunk into the manual chunk, so one
 * react-importing member would drag the single shared react copy into
 * vendor. The React side of markdown/math rendering is workspace code and
 * rides index.
 */
const VENDOR_PACKAGES: ReadonlySet<string> = new Set([
  // math
  'katex',
  // syntax highlight (@shikijs/langs is handled separately below —
  // lazy grammars must not land here)
  'shiki',
  // markdown parse pipeline (micromark/mdast; the incremental React renderer
  // over it is workspace code)
  'mdast-util-from-markdown',
  'mdast-util-gfm',
  'mdast-util-math',
  'micromark-core-commonmark',
  'micromark-extension-gfm',
  'micromark-extension-math',
  'micromark-factory-space',
  'micromark-util-character',
  'micromark-util-classify-character',
  'micromark-util-sanitize-uri',
  'micromark-util-symbol',
  'micromark-util-types',
])

/**
 * Boot grammars statically imported by ui-primitives' highlight.ts
 * (`@shikijs/langs/typescript` → `dist/typescript.mjs`, etc.). They live in
 * the same package as the lazy read-card grammars, but unlike those they are
 * part of the initial load and belong in the vendor chunk; the lazy ones must
 * stay unassigned so each keeps its own on-demand chunk.
 */
const BOOT_GRAMMAR_FILES: readonly string[] = [
  'dist/typescript.mjs',
  'dist/shellscript.mjs',
  'dist/json.mjs',
]

/** Font asset extensions routed to assets/fonts/ (KaTeX's woff2/woff/ttf faces). */
const FONT_EXTENSIONS: readonly string[] = ['.woff2', '.woff', '.ttf']

/**
 * npm package name of a resolved module id: the segment after the last
 * `node_modules/`. pnpm nests the real package under an inner node_modules.
 */
function npmPackageOf(id: string): string | undefined {
  const parts = id.split('/node_modules/')
  if (parts.length === 1) return undefined
  const [first, second] = parts[parts.length - 1].split('/')
  if (first.startsWith('.')) return undefined // .pnpm store segment, not a package
  if (first.startsWith('@')) return second === undefined ? undefined : `${first}/${second}`
  return first
}

/**
 * Build a browser-surface shell Vite config. `__DSH_BOOT__` arrives from the
 * host (webserver injection or the desktop IPC bridge), never from Vite, so
 * serving standalone is rejected before the manifest-free shell can boot.
 * @param options - app dir, app name, rejection guidance, and shell differences.
 * @returns the Vite config.
 */
export function defineViteShell(options: ViteShellOptions) {
  /** Fail before a Vite dev or preview server can expose the boot-manifest-free shell. */
  function rejectStandaloneServe(): Plugin {
    return {
      name: 'dsh-reject-standalone-serve',
      config(_config, env) {
        if (env.command === 'serve') {
          throw new Error(
            `${options.appName} is not a standalone application: bare Vite cannot inject window.__DSH_BOOT__. ${options.standaloneHint}`,
          )
        }
      },
    }
  }

  return defineConfig({
    plugins: [rejectStandaloneServe(), react()],
    ...(options.base === undefined ? {} : { base: options.base }),
    build: {
      sourcemap: true,
      rollupOptions: {
        output: {
          // Output layout: the two main chunks stay at assets/ root; lazy
          // @shikijs/langs grammar chunks group under assets/langs/; fonts
          // (all KaTeX faces referenced by vendor.css) group under
          // assets/fonts/. Sourcemaps need no arrangement: rollup writes each
          // .map next to its js and references it by bare relative filename.
          chunkFileNames(chunk): string {
            // Grammar chunks are recognized by their member modules, not the
            // facade: shared embedded-grammar chunks (e.g. html+javascript,
            // split out because php/ruby/mdx embed them) have no facade at all.
            // index and vendor are excluded by name — vendor legitimately
            // carries the three boot grammars.
            if (chunk.name === 'index' || chunk.name === 'vendor') return 'assets/[name]-[hash].js'
            const isLangChunk = chunk.moduleIds.some(id => id.includes('/node_modules/@shikijs/langs/'))
            return isLangChunk ? 'assets/langs/[name]-[hash].js' : 'assets/[name]-[hash].js'
          },
          assetFileNames(asset): string {
            const fileName = asset.names[0] ?? ''
            const isFont = FONT_EXTENSIONS.some(ext => fileName.endsWith(ext))
            return isFont ? 'assets/fonts/[name]-[hash][extname]' : 'assets/[name]-[hash][extname]'
          },
          manualChunks(id: string): string | undefined {
            const pkg = npmPackageOf(id)
            if (pkg === undefined) return undefined // workspace + vendored cordis: index
            if (pkg === '@shikijs/langs') {
              return BOOT_GRAMMAR_FILES.some(file => id.endsWith(`/${file}`)) ? 'vendor' : undefined
            }
            return VENDOR_PACKAGES.has(pkg) ? 'vendor' : undefined
          },
        },
      },
    },
    resolve: {
      // Workspace packages resolve to SOURCE: package.json exports point at lib
      // for Node/type consumers, but the browser bundle must compile src directly
      // so CSS rides vite's pipeline instead of the CSS-externalized lib bundle.
      // Only the shell's normal package entry is aliased — plugin packages are
      // NEVER bundled here (shell self-sufficiency — see
      // packages/client/web/README.md); they arrive as runtime
      // bundles through the client module system. Order matters — subpath
      // aliases must win over bare-name prefixes.
      alias: [
        // Browserization of the vendored cordis Loader: its only node-only
        // import; the two process probes are mapped by `define` below.
        { find: /^node:module$/, replacement: options.nodeModuleStub },
        { find: /^@deepseek-ai\/dsh-client-web$/, replacement: src(options.appDir, '../../packages/client/web/src/boot.tsx') },
        { find: /^@deepseek-ai\/dsh-client-web-react$/, replacement: src(options.appDir, '../../packages/client/web-react/src/index.ts') },
        { find: /^@deepseek-ai\/dsh-client-ui-slots$/, replacement: src(options.appDir, '../../packages/client/ui-slots/src/index.ts') },
        { find: /^@deepseek-ai\/dsh-client-ui-primitives$/, replacement: src(options.appDir, '../../packages/client/ui-primitives/src/index.ts') },
        { find: /^@deepseek-ai\/dsh-client-ui-attachment$/, replacement: src(options.appDir, '../../packages/client/ui-attachment/src/index.ts') },
        { find: /^@deepseek-ai\/dsh-client-schema-form$/, replacement: src(options.appDir, '../../packages/client/schema-form/src/index.ts') },
        { find: /^@deepseek-ai\/dsh-client-modules\/client$/, replacement: src(options.appDir, '../../packages/client/modules/src/client/index.ts') },
        ...(options.extraAliases ?? []),
      ],
    },
    define: {
      // vendored loader internal.ts: fromInternal() probes the Node major —
      // "0.0.0" takes neither branch, returning undefined (exactly the empty
      // internal slot the shell boot fills with the client module loader).
      'process.versions.node': '"0.0.0"',
      'process.execArgv': '[]',
      // vendored loader index.ts: envData falls to its default branch.
      'process.env.CORDIS_SHARED': 'undefined',
    },
  })
}
