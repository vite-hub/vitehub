import type { ContentNavigationItem } from "@nuxt/content";
import {
  docsManifest,
  getDocsPage,
  getDocsPath,
  getDocsPathMeta,
  isDocsPageSupported,
  type DocsPage,
  type DocsSection,
} from "./docs";
import { normalizeFrameworkPage, type DocsRenderOptions } from "./framework-content";
import type { Framework } from "./frameworks";

type DocsRouteMeta = Omit<NonNullable<ReturnType<typeof getDocsPathMeta>>, "framework"> & { framework: Framework };

type ContentPageInput = {
  title?: unknown;
  description?: string | null;
  seo?: { title?: string; description?: string };
  meta?: Record<string, unknown> | null;
  body?: { value?: unknown[]; toc?: { links?: unknown[] } | null } | null;
};

export type DocsPageFallback = {
  title: string;
  sourceTitle: string | null;
  description: string | null;
};

export type DocsPageState<T extends ContentPageInput> = T & {
  path: string;
  title: string;
  description: string;
  seo: { title: string; description: string };
  data: Record<string, unknown>;
};

type DocsResolvedRoute = {
  meta: DocsRouteMeta;
  page: DocsPage | null;
  sourcePath: string;
  supported: boolean;
};

type DocsSectionLink = {
  label: string;
  description?: string;
  icon?: string;
  to: string;
  active: boolean;
};

export function resolveDocsRoute(path: string): DocsResolvedRoute | null {
  const meta = getDocsPathMeta(path);

  if (!meta) {
    return null;
  }

  const framework = meta.framework as Framework;
  const page = getDocsPage(meta.section, meta.page);
  const sourcePath = getDocsPath(meta.section, framework, meta.page);

  return {
    meta: { ...meta, framework },
    page,
    sourcePath,
    supported: Boolean(page && isDocsPageSupported(meta.section, meta.page, framework)),
  };
}

export function getDocsPageFallback(page: DocsPage): DocsPageFallback {
  return {
    title: page.title,
    sourceTitle: page.sourceTitle,
    description: page.description,
  };
}

export function createDocsPageState<T extends ContentPageInput>(
  doc: T | null | undefined,
  sourcePath: string,
  fallback: DocsPageFallback,
) {
  if (!doc) return null;

  const title = String(doc.title || fallback.sourceTitle || fallback.title);
  const description = doc.description || fallback.description || "";

  return {
    ...doc,
    path: sourcePath,
    title,
    description,
    seo: {
      title: doc.seo?.title || title,
      description: doc.seo?.description || description,
    },
    data: doc.meta || {},
  } satisfies DocsPageState<T>;
}

export function renderDocsPage<T extends ContentPageInput>(
  doc: T | null | undefined,
  sourcePath: string,
  fallback: DocsPageFallback,
  options: DocsRenderOptions,
) {
  return normalizeFrameworkPage(createDocsPageState(doc, sourcePath, fallback), options);
}

function createNavigationGroup(title: string, items: ContentNavigationItem[], options: { defaultOpen?: boolean } = {}) {
  if (!items.length) return null;
  return {
    title,
    path: items[0]?.path || "/docs",
    children: items,
    ...(options.defaultOpen !== undefined && { defaultOpen: options.defaultOpen }),
  } satisfies ContentNavigationItem;
}

function isPathExact(itemPath: string, currentPath: string) {
  const a = itemPath.replace(/\/+$/, "");
  const b = currentPath.replace(/\/+$/, "");
  return b === a;
}

function isPathActive(itemPath: string, currentPath: string) {
  const a = itemPath.replace(/\/+$/, "");
  const b = currentPath.replace(/\/+$/, "");
  return b === a || b.startsWith(`${a}/`);
}

function toNavigationItem(item: { title: string; path: string; icon?: string | null }, currentPath?: string) {
  return {
    title: item.title,
    path: item.path,
    icon: item.icon || undefined,
    ...(currentPath !== undefined && { active: isPathExact(item.path, currentPath) }),
  } satisfies ContentNavigationItem;
}

function getSupportedDocsPages(section: DocsSection, framework: Framework) {
  return section.pages.filter(page => isDocsPageSupported(section.id, page.id, framework));
}

export function getSupportedDocsSections(framework: Framework) {
  return docsManifest.sections.filter(section => getSupportedDocsPages(section, framework).length > 0);
}

function getSectionPrimaryPage(section: DocsSection, framework: Framework) {
  const pages = getSupportedDocsPages(section, framework);
  return pages.find(page => page.id === "index") || pages[0] || null;
}

function getSectionLink(section: DocsSection, framework: Framework, currentPath: string): DocsSectionLink | null {
  const primaryPage = getSectionPrimaryPage(section, framework);
  if (!primaryPage) return null;

  const sectionPath = getDocsPath(section.id, framework);
  return {
    label: section.title,
    description: section.description || undefined,
    icon: section.icon || undefined,
    to: getDocsPath(section.id, framework, primaryPage.id),
    active: isPathActive(sectionPath, currentPath),
  };
}

function buildDocsIndexSidebarNavigation(sections: DocsSection[], currentPath: string) {
  const gettingStartedSection = sections.find(section => section.id === "getting-started");
  if (!gettingStartedSection) return [];

  return [toNavigationItem({ title: gettingStartedSection.title, path: "/docs", icon: gettingStartedSection.icon }, currentPath)];
}

function buildSectionSidebarNavigation(section: DocsSection, framework: Framework, currentPath: string) {
  const pages = getSupportedDocsPages(section, framework);
  const rootItems = [
    toNavigationItem({ title: "Overview", path: getDocsPath(section.id, framework), icon: section.icon }, currentPath),
    ...pages
      .filter(page => page.id !== "index" && !page.group)
      .map(page => toNavigationItem({ title: page.title, path: getDocsPath(section.id, framework, page.id), icon: page.icon }, currentPath)),
  ];
  const groupedPages = new Map<string, DocsPage[]>();

  for (const page of pages) {
    if (!page.group) continue;
    groupedPages.set(page.group, [...(groupedPages.get(page.group) || []), page]);
  }

  const groups = [
    ...rootItems,
    ...[...groupedPages.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([group, items]) => createNavigationGroup(
        group,
        items.map(page => toNavigationItem({ title: page.title, path: getDocsPath(section.id, framework, page.id), icon: page.icon }, currentPath)),
        { defaultOpen: group === "Providers" },
      )),
  ];

  return groups.filter(Boolean) as ContentNavigationItem[];
}

export function getDocsActiveSection(path: string, sections: DocsSection[]) {
  const meta = getDocsPathMeta(path);
  return meta ? sections.find(section => section.id === meta.section) || null : null;
}

export function buildDocsSidebarNavigation(path: string, framework: Framework, sections = getSupportedDocsSections(framework)) {
  if (path === "/docs") {
    return buildDocsIndexSidebarNavigation(sections, path);
  }

  const activeSection = getDocsActiveSection(path, sections);

  if (!activeSection) {
    const packageLinks = sections
      .filter(section => section.id !== "getting-started")
      .map(section => getSectionLink(section, framework, path))
      .filter((item): item is DocsSectionLink => Boolean(item))
      .map(item => toNavigationItem({ title: item.label, path: item.to, icon: item.icon }, path));
    const group = createNavigationGroup("Packages", packageLinks);
    return group ? [group] : [];
  }

  return buildSectionSidebarNavigation(activeSection, framework, path);
}
