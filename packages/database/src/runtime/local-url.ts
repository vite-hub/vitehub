import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

import { isRemoteSqliteUrl } from "./drizzle-adapter.ts"

export function resolveLocalSqliteUrl(url: string) {
  if (url === ":memory:" || isRemoteSqliteUrl(url)) return url
  const path = url.startsWith("file:") ? url.slice("file:".length) : url
  mkdirSync(dirname(path), { recursive: true })
  return url
}
