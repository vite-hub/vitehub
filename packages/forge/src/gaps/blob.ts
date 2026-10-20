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
  if (!isBase64Blob(data)) throw new ForgeResponseError(`GitHub returned a malformed blob ${sha}.`)
  return new Uint8Array(Buffer.from(data.content, "base64"))
}

function isBase64Blob(value: unknown): value is { content: string, encoding: "base64" } {
  if (!(value instanceof Object) || !("content" in value) || !("encoding" in value)) return false
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- GitHub JSON crosses the untrusted HTTP boundary as an unknown value.
  return typeof value.content === "string" && value.encoding === "base64"
}
