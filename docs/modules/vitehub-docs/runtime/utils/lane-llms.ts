import { docsLanes, parseDocsLane, type DocsLane } from "../../docs-lanes";

const siteOrigin = "https://vitehub.dev";

export const docsLaneTitles: Record<DocsLane, string> = {
  "agents": "Agents",
  "server-primitives": "Server Primitives",
};

type LaneLlmsPage = {
  description: string | null;
  lanes: readonly DocsLane[];
  navigation: boolean;
  path: string;
  sourceTitle: string | null;
  title: string;
};

type LaneLlmsManifest = {
  sections: Array<{ lanes: readonly DocsLane[], pages: LaneLlmsPage[], title: string }>;
};

export function laneLlmsPath(lane: DocsLane) {
  return `/llms/${lane}.txt`;
}

export function laneLlmsRoutes() {
  return docsLanes.map(laneLlmsPath);
}

/** Resolves the `:lane` segment of `/llms/:lane`, for example `agents.txt`. */
export function laneFromLlmsSegment(segment: string | undefined) {
  const match = segment?.match(/^([a-z-]+)\.txt$/);
  return match ? parseDocsLane(match[1]) : null;
}

/**
 * Builds an llms.txt index with only the pages in one docs lane navigation.
 * Links point to raw Markdown, like the links in `/llms.txt`.
 */
export function createLaneLlmsText(manifest: LaneLlmsManifest, lane: DocsLane) {
  const laneTitle = docsLaneTitles[lane];
  const lines = [
    `# ViteHub ${laneTitle}`,
    "",
    `> ViteHub documentation pages in the ${laneTitle} lane. Each link opens one raw Markdown page. The complete index is ${siteOrigin}/llms.txt.`,
  ];

  for (const section of manifest.sections) {
    if (!section.lanes.includes(lane)) continue;
    const pages = section.pages.filter(page => page.navigation && page.lanes.includes(lane));
    if (pages.length === 0) continue;

    lines.push("", `## ${section.title}`, "");
    for (const page of pages) {
      const link = `- [${page.sourceTitle || page.title}](${siteOrigin}/raw${page.path}.md)`;
      lines.push(page.description ? `${link}: ${page.description}` : link);
    }
  }

  return `${lines.join("\n")}\n`;
}
