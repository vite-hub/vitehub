import { fileURLToPath } from "node:url"

export function resolveLocalSqlitePath(url: string) {
  const path = url.replace(/\?.*$/, "")
  if (/^file:\/\/(?:localhost)?\//i.test(path) || /^file:\//i.test(path)) {
    return fileURLToPath(path)
  }
  return path.startsWith("file:") ? path.slice("file:".length) : path
}
