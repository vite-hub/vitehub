import { fileURLToPath } from "node:url"

export function resolveLocalSqlitePath(url: string) {
  const path = url.replace(/[?#].*$/, "")
  if (/^file:\/\/(?:localhost)?\//i.test(path) || /^file:\//i.test(path)) {
    return fileURLToPath(path)
  }
  return /^file:/i.test(path) ? decodeURIComponent(path.slice("file:".length)) : path
}

/** The PGlite folder of a Postgres Database in development, relative to the project root, beside the SQLite files. */
export function localPgliteDir(name: string) {
  return name === "default" ? ".vitehub/data/database/pglite" : `.vitehub/data/database/${name}.pglite`
}
