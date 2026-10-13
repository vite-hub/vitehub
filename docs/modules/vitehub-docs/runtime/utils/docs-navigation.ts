import { normalizeDocsPath, type DocsPage, type DocsSection } from "./docs";

/** Catalog rows on `/docs` and groups in the docs rail, in display order. */
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

/** Related tasks share a group, so each heading contains useful choices. */
const primitiveSidebarGroupOrder: Array<string | null> = [
  null,
  "Learn",
  "Build",
  "Deploy and operate",
];

const primitiveLaneGroups = new Map(Object.entries({
  Tutorial: "Learn",
  Concepts: "Learn",
  Guides: "Build",
  Reference: "Build",
  Deploy: "Deploy and operate",
  Operate: "Deploy and operate",
}));

/** Platform topics are reached from Get started and the catalog, instead of adding rail entries. */
export function getDocsRailCatalog(sections: DocsSection[]) {
  return getDocsCatalog(sections).filter(group => group.category !== "Platform");
}

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

/** Short label shown beside a product in the catalog. Keep the package name as the primary title. */
export function getDocsSectionKind(section: DocsSection) {
  if (section.id === "agents") return "Agent runtime";
  if (section.id === "ui") return "UI components";
  if (primitiveCategories.has(section.category || "")) return "Server Primitive";
  if (section.category === "Start") return "Getting started";
  if (section.category === "Platform") return "Platform";
  return section.category || "Documentation";
}

export function getUncategorizedDocsSections(sections: DocsSection[]) {
  return sections.filter(section => !isDocsCategory(section.category));
}

/** The section that owns a docs path. `/docs` and unknown paths have no section, so no page panel opens. */
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

/** The user task lane for a page in a Server Primitive section. Explicit frontmatter wins. */
function primitivePageLane(section: DocsSection, page: DocsPage) {
  if (page.group?.trim()) return page.group.trim();
  if (!primitiveCategories.has(section.category || "")) return null;
  if (page.kind?.trim()) return page.kind.trim();

  switch (page.id) {
    case "get-started": return "Tutorial";
    case "configure": return "Guides";
    case "server-api": return "Reference";
    case "agent-capability": return "Guides";
    case "hosts": return "Deploy";
    case "limits-and-errors": return "Operate";
    case "index": return null;
    default: return "Guides";
  }
}

/** Sidebar rows for one section: navigable pages in order, grouped by `navigation.group`. */
export function getDocsSidebarGroups(section: DocsSection): DocsSidebarGroup[] {
  const groups = new Map<string | null, DocsPage[]>();

  for (const page of section.pages) {
    if (page.navigation === false) continue;
    const lane = primitivePageLane(section, page);
    const label = primitiveCategories.has(section.category || "") && lane
      ? primitiveLaneGroups.get(lane) || lane
      : lane;
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

/** Categories whose section Overview renders as a product landing page without a table of contents. */
export const docsLandingCategories: readonly DocsCategory[] = ["Data", "Compute", "Access", "Delivery", "Files", "Agents"];
const docsLandingCategorySet = new Set<string>(docsLandingCategories);

/** Sections whose Overview stays a regular docs page even though their category is a product category. */
const docsPageOverviewSections = new Set(["ui"]);

/** True for `/docs` and for the Overview of every product section. These pages have a hero and no table of contents. */
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
