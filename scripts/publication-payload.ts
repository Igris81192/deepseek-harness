/** Publication payload policy shared by static manifests and packed tarballs. */

/**
 * Whether a package manifest exports generated Host-for-Client metadata.
 * @param manifest - parsed package manifest to inspect.
 * @returns whether the canonical `./remote` export pair is present.
 */
export function hasTypertRemoteNavigation(manifest: unknown): boolean {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) return false
  const exportsField = (manifest as Record<string, unknown>).exports
  if (exportsField === null || typeof exportsField !== 'object' || Array.isArray(exportsField)) return false
  const remote = (exportsField as Record<string, unknown>)['./remote']
  if (remote === null || typeof remote !== 'object' || Array.isArray(remote)) return false
  const entry = remote as Record<string, unknown>
  return entry.types === './lib/typert.remote-client.d.ts'
    && entry.default === './lib/typert.remote-client.js'
}

/** Normalize a package manifest path or npm tarball member to its payload-relative path. */
function payloadPath(file: string): string {
  const normalized = file.replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/\/+$/, '')
  return normalized.startsWith('package/') ? normalized.slice('package/'.length) : normalized
}

/**
 * Deliberate source payloads whose exact bytes are part of the package's audit
 * surface. The desktop preload ships as-is CJS (Electron loads it verbatim),
 * and the landlock entrypoint is compiled into the native addon.
 */
export const publicationSourceAllowlist: Readonly<Record<string, readonly string[]>> = {
  '@deepseek-ai/dsh-desktop': ['src/preload.cjs'],
  '@deepseek-ai/node-addon-landlock-run': ['src/main.c'],
}

/**
 * Whether a package payload path exposes source or map intermediates. Maps
 * serve editor navigation during development, where a workspace consumer
 * resolves their source through the package link; a published map resolves
 * nothing, so no payload publishes one.
 * @param file - manifest path or tarball member to classify.
 * @returns whether publishing this path is forbidden.
 */
export function isForbiddenPublicationFile(file: string): boolean {
  const normalized = payloadPath(file)
  return normalized === 'src'
    || normalized.startsWith('src/')
    || normalized.endsWith('.d.ts.map')
    || normalized.endsWith('.js.map')
}

/**
 * Reject source and map members in a packed npm tarball.
 * @param files - tarball members to validate.
 * @param context - tarball identity named in the failure.
 * @param allowedSources - payload paths exempt from the source ban
 *   ({@link publicationSourceAllowlist} entries for the artifact's package).
 */
export function validateTarballPayload(
  files: readonly string[],
  context: string,
  allowedSources: readonly string[] = [],
): void {
  for (const file of files) {
    if (!isForbiddenPublicationFile(file) || allowedSources.includes(payloadPath(file))) continue
    const normalized = payloadPath(file)
    if (normalized === 'src' || normalized.startsWith('src/')) {
      throw new Error(`${context} publishes source file ${file}`)
    }
    throw new Error(`${context} publishes source map ${file}`)
  }
}
