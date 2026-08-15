/**
 * Base64 → bytes for renderer-side IPC response bodies. The main process
 * encodes with Buffer.toString('base64'); the renderer has no Buffer, so the
 * decode lives here (client leaf only — the host leaf never decodes). Returns
 * a plain ArrayBuffer so the bytes type cleanly as a fetch BodyInit.
 */
export function decodeBase64(encoded: string): ArrayBuffer {
  const binary = atob(encoded)
  const buffer = new ArrayBuffer(binary.length)
  const bytes = new Uint8Array(buffer)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return buffer
}
