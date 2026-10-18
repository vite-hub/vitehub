import type { ForgeProvider, RepoRef } from "forges"
import { forgeDiagnostics } from "../error-diagnostics.ts"

export interface ForgeArchiveOptions {
  /** Branch, tag or commit sha. */
  ref: string
  /** Only `tar.gz` is supported. */
  format?: "tar.gz"
  signal?: AbortSignal
}

/**
 * The repository tree at `ref` as a gzipped tarball stream.
 * Gap: `forges` has no `contents.archive()`. Proposed upstream as `provider.contents.archive(repo, options)`.
 */
export async function forgeArchive(provider: ForgeProvider, repo: RepoRef, options: ForgeArchiveOptions): Promise<ReadableStream<Uint8Array>> {
  if (provider.forge !== "github") {
    throw forgeDiagnostics.FORGE_R0002({ message: `Repository archives are not supported for ${provider.forge}.` })
  }
  const owner = encodeURIComponent(repo.owner)
  const name = encodeURIComponent(repo.name)
  const ref = options.ref.split("/").map(encodeURIComponent).join("/")
  // Anonymous API calls share a limit of 60 an hour. Public github.com archives on codeload do not count against it.
  const path = provider.authKind === "anonymous" && provider.baseUrl.replace(/\/+$/, "") === "https://api.github.com"
    ? `https://codeload.github.com/${owner}/${name}/tar.gz/${ref}`
    // The API answers with a signed redirect to codeload. The provider follows it and drops its credentials on the other origin.
    : `/repos/${owner}/${name}/tarball/${ref}`
  const response = await provider.request("GET", path, { raw: true, signal: options.signal })
  return response.body
}
