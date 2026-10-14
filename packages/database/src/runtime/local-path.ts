export function resolveLocalSqlitePath(url: string) {
  const path = url.startsWith("file:") ? url.slice("file:".length) : url
  return path.replace(/\?.*$/, "")
}
