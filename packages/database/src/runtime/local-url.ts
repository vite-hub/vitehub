import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

import { isRemoteSqliteUrl } from "./drizzle-adapter.ts"
import { resolveLocalSqlitePath } from "./local-path.ts"

export function resolveLocalSqliteUrl(url: string) {
  if (url === ":memory:" || isRemoteSqliteUrl(url)) return url
  const path = resolveLocalSqlitePath(url)
  mkdirSync(dirname(path), { recursive: true })
  return url
}
