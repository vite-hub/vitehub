import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

import { resolveLocalSqlitePath } from "./local-path.ts"

export function resolveLocalSqliteUrl(url: string) {
  if (url === ":memory:" || /^(?:libsql:|https?:|wss?:)/i.test(url)) return url
  const path = resolveLocalSqlitePath(url)
  if (path === ":memory:") return url
  mkdirSync(dirname(path), { recursive: true })
  return url
}
