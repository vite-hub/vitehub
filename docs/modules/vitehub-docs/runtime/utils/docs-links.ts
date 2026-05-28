import type { Framework } from "./frameworks";

const frameworkSegments = new Set(["vite", "nitro", "nuxt"]);

function splitLinkTarget(target: string) {
  const suffixIndex = target.search(/[?#]/);

  return suffixIndex === -1
    ? { path: target, suffix: "" }
    : { path: target.slice(0, suffixIndex), suffix: target.slice(suffixIndex) };
}

function dirname(path: string) {
  const segments = path.split("/").filter(Boolean);
  segments.pop();
  return segments.join("/");
}

function normalizePath(...parts: string[]) {
  const segments: string[] = [];

  for (const part of parts) {
    for (const segment of part.split("/")) {
      if (!segment || segment === ".") {
        continue;
      }

      if (segment === "..") {
        segments.pop();
        continue;
      }

      segments.push(segment);
    }
  }

  return segments.join("/");
}

function relativeFileFromPageId(pageId: string) {
  return pageId === "index" ? "index.md" : `${pageId}.md`;
}

export function resolveFrameworkDocLink(framework: Framework, sectionId: string, relativeFile: string, target: string) {
  if (
    !target
    || target.startsWith("/")
    || target.startsWith("#")
    || /^[a-z][a-z0-9+.-]*:/i.test(target)
  ) {
    return target;
  }

  const { path, suffix } = splitLinkTarget(target);
  if (!path.startsWith("./") && !path.startsWith("../")) {
    return target;
  }

  const sourceRouteFile = normalizePath(sectionId, relativeFile);
  const targetRouteFile = normalizePath(dirname(sourceRouteFile), path);
  let pageId = targetRouteFile.replace(/\.md$/, "");

  if (pageId === "." || pageId === "index") {
    return `/docs/${framework}${suffix}`;
  }

  if (pageId.endsWith("/index")) {
    pageId = pageId.slice(0, -"/index".length);
  }

  return `/docs/${framework}/${pageId}${suffix}`;
}

export function resolveFrameworkContentLink(
  framework: Framework,
  source: { section: string; page: string },
  target: string,
) {
  if (!target || target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(target)) {
    return target;
  }

  const { path, suffix } = splitLinkTarget(target);
  if (path === "/docs") {
    return `/docs/${framework}${suffix}`;
  }

  if (path.startsWith("/docs/")) {
    const parts = path.split("/").filter(Boolean);
    if (frameworkSegments.has(parts[1] || "")) {
      return target;
    }

    return `/docs/${framework}/${parts.slice(1).join("/")}${suffix}`;
  }

  return resolveFrameworkDocLink(framework, source.section, relativeFileFromPageId(source.page), target);
}
