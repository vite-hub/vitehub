import { normalizeDocsPath } from "./docs";

export function normalizeSitePath(path?: string | null) {
  if (!path || path === "/") return "/";
  return path.startsWith("/docs") ? normalizeDocsPath(path) : path.replace(/\/+$/, "") || "/";
}
