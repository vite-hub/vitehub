import { useRoute } from "#app/composables/router";
import { computed } from "vue";
import type { ContentNavigationItem } from "@nuxt/content";
import { useFrameworkPreference } from "./useFrameworkPreference";
import { docsManifest, getDocsPath, getDocsPathMeta, isDocsPageSupported, type DocsPage, type DocsSection } from "~~/modules/vitehub-docs/runtime/utils/docs";
import type { Framework } from "~~/modules/vitehub-docs/runtime/utils/frameworks";
import { normalizeSitePath } from "~~/modules/vitehub-docs/runtime/utils/docs-routes";

type DocsSectionLink = {
  label: string;
  description?: string;
  icon?: string;
  to: string;
  active: boolean;
};

function createNavigationGroup(title: string, items: ContentNavigationItem[]) {
  if (!items.length) return null;
  return { title, path: items[0]?.path || "/docs", children: items } satisfies ContentNavigationItem;
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

function buildDocsIndexSidebarNavigation(sections: DocsSection[], framework: Framework, currentPath: string) {
  const gettingStartedSection = sections.find(section => section.id === "getting-started");
  if (!gettingStartedSection) return [];

  return [toNavigationItem({ title: gettingStartedSection.title, path: "/docs", icon: gettingStartedSection.icon }, currentPath)];
}

function buildSectionSidebarNavigation(section: DocsSection, framework: Framework, currentPath: string) {
  const pages = getSupportedPages(section, framework);
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

  return {
    sections,
    activeSection,
    sidebarNavigation,
  };
}
