import { Buffer } from "node:buffer"

import type { ForgeProvider, RepoRef } from "forges"

import { forgeDiagnostics } from "../error-diagnostics.ts"
import { ForgeResponseError } from "../provider.ts"

/**
 * The bytes of one Git blob, by its sha. The blob of a symlink holds the link target.
 * Gap: `forges` reads files by path only, and GitHub follows a symlink path to its target.
 * Proposed upstream as `provider.contents.blob(repo, sha, options)`.
 */
export async function forgeBlob(provider: ForgeProvider, repo: RepoRef, sha: string, options: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
  if (provider.forge !== "github") {
    throw forgeDiagnostics.FORGE_R0004({ message: `Reading a blob by sha is not supported for ${provider.forge}.` })
  }
  const { data } = await provider.request<unknown>(
    "GET",
    `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/git/blobs/${encodeURIComponent(sha)}`,
    { signal: options.signal },
  )
  const bytes = decodeBase64Blob(data)
  if (!bytes) throw new ForgeResponseError(`GitHub returned a malformed blob ${sha}.`)
  return new Uint8Array(bytes)
}

function decodeBase64Blob(value: unknown): Buffer | undefined {
  if (!(value instanceof Object) || !("content" in value) || !("encoding" in value) || !("sha" in value)) return undefined
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- GitHub JSON crosses the untrusted HTTP boundary as an unknown value.
  if (typeof value.content !== "string" || value.encoding !== "base64" || typeof value.sha !== "string" || value.sha.length === 0) return undefined
  const content = value.content.replace(/\s+/g, "")
  if (content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) return undefined
  try {
    const bytes = Buffer.from(content, "base64")
    return bytes.toString("base64") === content ? bytes : undefined
  }
  catch {
    return undefined
  }
}
