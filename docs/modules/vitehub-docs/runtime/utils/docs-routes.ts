import { getDocsPath, getDocsPathMeta, isDocsPageSupported, isDocsSectionSupported } from "./docs";
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
      return isDocsSectionSupported(meta.section, framework)
        ? getDocsPath(meta.section, framework)
        : getDocsPath("getting-started", framework);
    }

    return nextPath;
  }

  if (new RegExp(`^/blogs/(?:${frameworkPattern})(?:/|$)`).test(path)) {
    const nextPath = path.replace(new RegExp(`^/blogs/(?:${frameworkPattern})`), `/blogs/${framework}`);
    const parts = nextPath.split("/").filter(Boolean);
    const page = parts.slice(2).join("/") || "index";

    if (!isDocsPageSupported("tutorials", page, framework)) {
      return isDocsSectionSupported("tutorials", framework)
        ? `/blogs/${framework}`
        : "/blogs/vite";
    }

    return nextPath;
  }

  return path;
}
