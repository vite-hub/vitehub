import { getDocsPath, getDocsPathMeta, isDocsPageSupported } from "./docs";
import { frameworkPattern, type Framework } from "./frameworks";

export function normalizeSitePath(path?: string | null) {
  if (!path || path === "/") return "/";
  return path.replace(/\/+$/, "") || "/";
}

export function resolveFrameworkSwitchPath(path: string, framework: Framework) {
  if (new RegExp(`^/docs/(?:${frameworkPattern})(?:/|$)`).test(path)) {
    const nextPath = path.replace(new RegExp(`^/docs/(?:${frameworkPattern})`), `/docs/${framework}`);
    const meta = getDocsPathMeta(nextPath);

    if (meta && !isDocsPageSupported(meta.section, meta.page, framework)) {
      return getDocsPath(meta.section, framework);
    }

    return nextPath;
  }

  return path;
}
