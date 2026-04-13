import { computed } from "vue";
import { useRoute } from "#imports";
import type { ContentNavigationItem } from "@nuxt/content";
import { useFrameworkPreference } from "./useFrameworkPreference";
import { docsManifest, getDocsPath, getDocsPathMeta, isDocsPageSupported, type DocsPage, type DocsSection } from "../utils/docs";
import type { Framework } from "../utils/frameworks";
import { normalizeSitePath } from "../utils/docs-routes";

type DocsSectionLink = {
  label: string;
  description?: string;
  icon?: string;
  to: string;
  active: boolean;
};

const startHerePageIds = new Set(["index"]);

function createNavigationGroup(title: string, items: ContentNavigationItem[]) {
  if (!items.length) return null;
  return { title, path: items[0]?.path || "/docs", children: items } satisfies ContentNavigationItem;
}

function isPathActive(itemPath: string, currentPath: string) {
  // Strip trailing slashes for comparison to avoid trailingSlash: "append" mismatches
  const a = itemPath.replace(/\/+$/, "");
  const b = currentPath.replace(/\/+$/, "");
  return b === a || b.startsWith(a + "/");
}

function toNavigationItem(item: { title: string; path: string; icon?: string | null }, currentPath?: string) {
  return {
    title: item.title,
    path: item.path,
    icon: item.icon || undefined,
    // Explicitly set active to bypass ULink's Vue Router isActive check
    // which breaks with trailingSlash: "append" on catch-all routes
    ...(currentPath !== undefined && { active: isPathActive(item.path, currentPath) }),
  } satisfies ContentNavigationItem;
}

function getSupportedPages(section: DocsSection, framework: Framework) {
  return section.pages.filter(page => isDocsPageSupported(section.id, page.id, framework));
}

function getSectionPrimaryPage(section: DocsSection, framework: Framework) {
  const pages = getSupportedPages(section, framework);
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

function buildDocsIndexSidebarNavigation(_sections: DocsSection[], _framework: Framework, currentPath: string) {
  const gettingStartedSection = _sections.find(section => section.id === "getting-started");
  if (!gettingStartedSection) return [];

  return [toNavigationItem({ title: gettingStartedSection.title, path: "/docs", icon: gettingStartedSection.icon }, currentPath)];
}

function buildSectionSidebarNavigation(section: DocsSection, framework: Framework, currentPath: string) {
  const pages = getSupportedPages(section, framework);
  const overviewItem = toNavigationItem({ title: "Overview", path: getDocsPath(section.id, framework), icon: section.icon }, currentPath);
  const startHere = pages
    .filter(page => page.id !== "index" && startHerePageIds.has(page.id))
    .map(page => toNavigationItem({ title: page.title, path: getDocsPath(section.id, framework, page.id), icon: page.icon }, currentPath));
  const guides = pages
    .filter(page => !startHerePageIds.has(page.id) && !page.group)
    .map(page => toNavigationItem({ title: page.title, path: getDocsPath(section.id, framework, page.id), icon: page.icon }, currentPath));
  const groupedPages = new Map<string, DocsPage[]>();

  for (const page of pages) {
    if (!page.group) continue;
    groupedPages.set(page.group, [...(groupedPages.get(page.group) || []), page]);
  }

  const groups = [
    createNavigationGroup("Start Here", [overviewItem, ...startHere]),
    createNavigationGroup("Guides", guides),
    ...[...groupedPages.entries()].map(([group, items]) => createNavigationGroup(
      group,
      items.map(page => toNavigationItem({ title: page.title, path: getDocsPath(section.id, framework, page.id), icon: page.icon }, currentPath)),
    )),
  ];

  return groups.filter(Boolean) as ContentNavigationItem[];
}

export function useDocsNavigation() {
  const route = useRoute();
  const { current } = useFrameworkPreference();
  const normalizedRoutePath = computed(() => normalizeSitePath(route.path));

  const sections = computed(() => docsManifest.sections.filter(section => getSupportedPages(section, current.value).length > 0));
  const activeSection = computed(() => {
    const meta = getDocsPathMeta(normalizedRoutePath.value);
    return meta ? sections.value.find(section => section.id === meta.section) || null : null;
  });

  const sidebarNavigation = computed(() => {
    if (normalizedRoutePath.value === "/docs") {
      return buildDocsIndexSidebarNavigation(sections.value, current.value, normalizedRoutePath.value);
    }

    if (!activeSection.value) {
      const packageLinks = sections.value
        .filter(section => section.id !== "getting-started")
        .map(section => getSectionLink(section, current.value, normalizedRoutePath.value))
        .filter((item): item is DocsSectionLink => Boolean(item))
        .map(item => toNavigationItem({ title: item.label, path: item.to, icon: item.icon }, normalizedRoutePath.value));
      const group = createNavigationGroup("Packages", packageLinks);
      return group ? [group] : [];
    }

    return buildSectionSidebarNavigation(activeSection.value, current.value, normalizedRoutePath.value);
  });

  const docsCards = computed(() => {
    return sections.value
      .filter(section => section.id !== "getting-started")
      .map(section => getSectionLink(section, current.value, normalizedRoutePath.value))
      .filter((item): item is DocsSectionLink => Boolean(item));
  });

  const sectionLinks = computed(() => {
    return sections.value
      .map(section => getSectionLink(section, current.value, normalizedRoutePath.value))
      .filter((item): item is DocsSectionLink => Boolean(item));
  });

  return {
    sections,
    activeSection,
    sidebarNavigation,
    sectionLinks,
    docsCards,
  };
}
