import { authErrorDiagnostics } from "./error-diagnostics.ts"
const defaultAuthBasePath = "/api/auth"

export function normalizeAuthBasePath(value: string | undefined): string {
  const path = value?.trim() || defaultAuthBasePath
  if (!path.startsWith("/")) {
    throw authErrorDiagnostics.AUTH_R0013({ message: "`defineAuth()` basePath must start with `/`." })
  }
  return path.length > 1 ? path.replace(/\/+$/g, "") : path
}

export function isAuthRequestPath(pathname: string, basePath: string): boolean {
  return pathname === basePath || pathname.startsWith(`${basePath}/`)
}
