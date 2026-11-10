// Node-only file handling of the default journal. It loads only for a local SQLite file, so a Worker never imports it.
import { mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { defaultAgentInvocationsPath } from "./default-location.ts"

/** Resolves a `file:` URL, or the default file when `url` is undefined, from the project root. Drops the fragment and keeps the query. */
export function resolveLocalJournalFile(projectRoot: string, url = `file:${resolve(projectRoot, defaultAgentInvocationsPath)}`): { file?: string, url: string } {
  const fragmentIndex = url.indexOf("#")
  const urlWithoutFragment = fragmentIndex === -1 ? url : url.slice(0, fragmentIndex)
  const queryIndex = urlWithoutFragment.indexOf("?")
  const fileUrl = queryIndex === -1 ? urlWithoutFragment : urlWithoutFragment.slice(0, queryIndex)
  const query = queryIndex === -1 ? "" : urlWithoutFragment.slice(queryIndex)
  const isAbsoluteFileUrl = /^file:\//i.test(fileUrl)
  const relativeFilePath = isAbsoluteFileUrl ? undefined : decodeURIComponent(fileUrl.slice("file:".length))
  if (relativeFilePath === ":memory:") return { url: urlWithoutFragment }
  const file = isAbsoluteFileUrl ? fileURLToPath(fileUrl) : resolve(projectRoot, relativeFilePath!)
  return { file, url: `${pathToFileURL(file).href}${query}` }
}

/** Creates the directory of a journal file. */
export function createJournalDirectory(file: string): void {
  mkdirSync(dirname(file), { recursive: true })
}
