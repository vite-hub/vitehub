import { parseDocsLane, type DocsLane } from "../../docs-lanes";
import { normalizeDocsPath, type DocsPage, type DocsSection } from "./docs";

export const docsLaneOptions = [
  {
    id: "agents" as const,
    label: "Agents",
    icon: "i-ph-robot-light",
  },
  {
    id: "server-primitives" as const,
    label: "Server Primitives",
    icon: "i-ph-cube-light",
  },
];

type DocsLaneResolution = {
  path: string;
  page: DocsPage | null;
  queryLane?: unknown;
  persistedLane?: unknown;
};

function laneFromPath(path: string): DocsLane | null {
  const normalizedPath = normalizeDocsPath(path);

  if (normalizedPath === "/docs/agents" || normalizedPath.startsWith("/docs/agents/")) {
    return "agents";
  }

  if (normalizedPath === "/docs/capabilities" || normalizedPath.startsWith("/docs/capabilities/")) {
    return "agents";
  }

  if (normalizedPath === "/docs/server-primitives" || normalizedPath.startsWith("/docs/server-primitives/")) {
    return "server-primitives";
  }

  return null;
}

export function resolveDocsLane({ path, page, queryLane, persistedLane }: DocsLaneResolution): DocsLane {
  return laneFromPath(path)
    || (page?.lanes.length === 1 ? page.lanes[0] : null)
    || parseDocsLane(queryLane)
    || parseDocsLane(persistedLane)
    || "agents";
}

export function getDocsSectionsForLane(sections: DocsSection[], lane: DocsLane) {
  return sections
    .filter(section => section.lanes.includes(lane))
    .map(section => ({
      ...section,
      pages: section.pages.filter(page => page.lanes.includes(lane)),
    }))
    .filter(section => section.pages.length > 0);
}

export function getDocsPageTarget(page: DocsPage, lane: DocsLane) {
  return {
    path: page.path,
    query: page.lanes.length > 1 ? { lane } : {},
  };
}
