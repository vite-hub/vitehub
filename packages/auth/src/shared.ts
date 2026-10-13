import { authErrorDiagnostics } from "./error-diagnostics.ts"
const defaultAuthBasePath = "/api/auth"

export function normalizeAuthBasePath(value: string | undefined): string {
  const path = value?.trim() || defaultAuthBasePath
  if (!path.startsWith("/")) {
    throw authErrorDiagnostics.AUTH_R0013({ message: "`defineAuth()` basePath must start with `/`." })
  }
  const normalized = path.replace(/\/+$/g, "")
  if (!normalized) {
    throw authErrorDiagnostics.AUTH_R0013({ message: "`defineAuth()` basePath must resolve to a non-empty path." })
  }
  return normalized
}

export function isAuthRequestPath(pathname: string, basePath: string): boolean {
  return basePath === "/" || pathname === basePath || pathname.startsWith(`${basePath}/`)
}
