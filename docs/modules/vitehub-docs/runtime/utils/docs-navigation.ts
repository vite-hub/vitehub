import { normalizeDocsPath, type DocsPage, type DocsSection } from "./docs";

/** Catalog rows on `/docs` and groups in the product select, in display order. */
export const docsCategoryOrder = [
  "Start",
  "Data",
  "Compute",
  "Access",
  "Delivery",
  "Files",
  "Agents",
  "Platform",
] as const;

export type DocsCategory = (typeof docsCategoryOrder)[number];

export type DocsCatalogGroup = {
  category: DocsCategory;
  sections: DocsSection[];
};

const primitiveCategories = new Set(["Data", "Compute", "Access", "Delivery", "Files"]);

/** Stable display order for task lanes in primitive sidebars. */
const primitiveSidebarGroupOrder: Array<string | null> = [
  null,
  "Learn",
  "Build",
  "Deploy and operate",
];

/** The section whose pages fill the Start row of the catalog. */
export const docsRootSectionId = "getting-started";

function isDocsCategory(value: string | null): value is DocsCategory {
  return value !== null && docsCategoryOrder.some(category => category === value);
}

/** Groups sections by their `.navigation.yml` category. Sections without a known category are skipped. */
export function getDocsCatalog(sections: DocsSection[]): DocsCatalogGroup[] {
  return docsCategoryOrder
    .map(category => ({
      category,
      sections: sections
        .filter(section => section.category === category)
        .sort((left, right) => left.order - right.order || left.title.localeCompare(right.title)),
    }))
    .filter(group => group.sections.length > 0);
}

export function getUncategorizedDocsSections(sections: DocsSection[]) {
  return sections.filter(section => !isDocsCategory(section.category));
}

/** The section that owns a docs path. `/docs` and unknown paths have no section; the sidebar shows the product index. */
export function getDocsSectionForPath(sections: DocsSection[], path: string) {
  const normalizedPath = normalizeDocsPath(path);

  return sections.find(section =>
    normalizedPath === normalizeDocsPath(section.path) || normalizedPath.startsWith(`${normalizeDocsPath(section.path)}/`),
  ) || null;
}

export type DocsSidebarGroup = {
  label: string | null;
  pages: DocsPage[];
};

/** Sidebar rows for one section: navigable pages in order, grouped by `navigation.group`. */
export function getDocsSidebarGroups(section: DocsSection): DocsSidebarGroup[] {
  const groups = new Map<string | null, DocsPage[]>();

  for (const page of section.pages) {
    if (page.navigation === false) continue;
    const label = page.group?.trim() || null;
    groups.set(label, [...(groups.get(label) || []), page]);
  }

  const entries = [...groups].map(([label, pages], index) => ({ label, pages, index }));
  if (!primitiveCategories.has(section.category || "")) {
    return entries.map(({ label, pages }) => ({ label: pages.length > 1 ? label : null, pages }));
  }
  return entries
    .sort((left, right) => {
      const leftOrder = primitiveSidebarGroupOrder.indexOf(left.label);
      const rightOrder = primitiveSidebarGroupOrder.indexOf(right.label);
      const normalizedLeft = leftOrder === -1 ? primitiveSidebarGroupOrder.length : leftOrder;
      const normalizedRight = rightOrder === -1 ? primitiveSidebarGroupOrder.length : rightOrder;
      return normalizedLeft - normalizedRight || left.index - right.index;
    })
    .map(({ label, pages }) => ({ label: pages.length > 1 ? label : null, pages }));
}

/** Sections listed under Related in a section's sidebar, in the order `.navigation.yml` declares them. */
export function getDocsRelatedSections(sections: DocsSection[], section: DocsSection) {
  return section.related
    .map(id => sections.find(candidate => candidate.id === id))
    .filter((candidate): candidate is DocsSection => Boolean(candidate) && candidate?.id !== section.id);
}

/** Categories whose section Overview renders as a product landing page without the sidebar. */
export const docsLandingCategories: readonly DocsCategory[] = ["Data", "Compute", "Access", "Delivery", "Files", "Agents"];
const docsLandingCategorySet = new Set<string>(docsLandingCategories);

/** Sections whose Overview stays a regular docs page even though their category is a product category. */
const docsPageOverviewSections = new Set(["ui"]);

/** True for `/docs` and for the Overview of every product section. These pages have a hero and no sidebar. */
export function isDocsLandingPath(sections: DocsSection[], path: string) {
  const normalizedPath = normalizeDocsPath(path);
  if (normalizedPath === "/docs") return true;

  const section = getDocsSectionForPath(sections, normalizedPath);
  if (!section || normalizedPath !== normalizeDocsPath(section.path)) return false;

  return !docsPageOverviewSections.has(section.id)
    && section.category !== null
    && docsLandingCategorySet.has(section.category);
}

/** Pages of a product section other than its Overview, in sidebar order. The landing page lists them as cards. */
export function getDocsSectionSubpages(section: DocsSection) {
  return section.pages.filter(page => page.navigation !== false && page.id !== "index");
}

/** Platform topics stay reachable from Get started and the catalog, without product rail entries. */
export function getDocsRailCatalog(sections: DocsSection[]): DocsCatalogGroup[] {
  return getDocsCatalog(sections).filter(group => group.category !== "Platform");
}

export function getDocsSectionKind(section: DocsSection): string {
  if (section.id === docsRootSectionId) return "Get started";
  if (section.id === "ui") return "UI components";
  if (primitiveCategories.has(section.category || "")) return "Server Primitive";
  return section.category || "Platform";
}
