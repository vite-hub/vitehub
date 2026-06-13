export const defaultAuthBasePath = "/api/auth"

export function normalizeAuthBasePath(value: string | undefined): string {
  const path = value?.trim() || defaultAuthBasePath
  if (!path.startsWith("/")) {
    throw new TypeError("`defineAuth()` basePath must start with `/`.")
  }
  return path.length > 1 ? path.replace(/\/+$/g, "") : path
}

export function isAuthRequestPath(pathname: string, basePath: string): boolean {
  return pathname === basePath || pathname.startsWith(`${basePath}/`)
}
