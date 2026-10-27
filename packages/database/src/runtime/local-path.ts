import { fileURLToPath } from "node:url"

export function resolveLocalSqlitePath(url: string) {
  const path = url.replace(/[?#].*$/, "")
  if (/^file:\/\/(?:localhost)?\//i.test(path) || /^file:\//i.test(path)) {
    return fileURLToPath(path)
  }
  return /^file:/i.test(path) ? decodeURIComponent(path.slice("file:".length)) : path
}
