import { docsManifest, normalizeDocsPath } from "~~/modules/vitehub-docs/runtime/utils/docs";
import { docsRootSectionId, getDocsSectionForPath } from "~~/modules/vitehub-docs/runtime/utils/docs-navigation";

// The site areas have no header on docs pages. Get started lists them, so they open inside that section.
export const docsSiteAreas = [
  { label: "All docs", to: "/docs", icon: "i-ph-squares-four-light" },
  { label: "Tutorials", to: "/tutorials", icon: "i-ph-graduation-cap-light" },
  { label: "Projects", to: "/projects", icon: "i-ph-folder-simple-light" },
  { label: "Templates", to: "/templates", icon: "i-ph-layout-light" },
];

export function isDocsSiteArea(path: string) {
  const normalizedPath = normalizeDocsPath(path);
  return docsSiteAreas.some(area => area.to !== "/docs" && normalizedPath === area.to);
}

/** The docs section of the current route. A site area resolves to Get started. */
export function useDocsSection() {
  const route = useRoute();
  return computed(() => {
    const section = getDocsSectionForPath(docsManifest.sections, route.path);
    if (section || !isDocsSiteArea(route.path)) return section;
    return docsManifest.sections.find(candidate => candidate.id === docsRootSectionId) ?? null;
  });
}
