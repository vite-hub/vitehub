export function consoleAuthMountBase(baseURL: string): string {
  const segments = baseURL.split("/").filter(Boolean)
  return segments.length ? `/${segments.join("/")}` : ""
}

export function consoleAuthPath(baseURL: string, path: string): string {
  return `${consoleAuthMountBase(baseURL)}${path}`
}
