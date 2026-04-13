import { docsManifest, getDocsPath, getDocsPathMeta, isDocsPageSupported } from "./docs";
import { frameworkPattern, frameworks, type Framework } from "./frameworks";

export function normalizeSitePath(path?: string | null) {
  if (!path || path === "/") return "/";
  return path.replace(/\/+$/, "") || "/";
}

export function getFrameworkDocsRoutes(framework: Framework) {
  return docsManifest.sections.flatMap(section =>
    section.pages
      .filter(page => isDocsPageSupported(section.id, page.id, framework))
      .map(page => getDocsPath(section.id, framework, page.id)),
  );
}

export function getPrerenderDocsRoutes() {
  return [...new Set([
    "/",
    "/docs",
    ...frameworks.flatMap(getFrameworkDocsRoutes),
  ])];
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

export function resolveRawDocsPath(path: string) {
  const normalizedPath = normalizeSitePath(path);
  const pathname = normalizedPath.startsWith("/raw/")
    ? normalizedPath.slice(4)
    : normalizedPath;

  if (!pathname.endsWith(".md")) {
    return null;
  }

  const docsPath = pathname.slice(0, -3);

  if (!new RegExp(`^/docs/(?:${frameworkPattern})/.+`).test(docsPath)) {
    return null;
  }

  const meta = getDocsPathMeta(docsPath);
  if (!meta || !isDocsPageSupported(meta.section, meta.page, meta.framework as Framework)) {
    return null;
  }

  return docsPath;
}
