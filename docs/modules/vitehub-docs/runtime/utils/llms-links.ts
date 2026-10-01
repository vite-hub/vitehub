import { docsLanes } from "../../docs-lanes";
import { docsLaneTitles, laneLlmsPath } from "./lane-llms";

type LlmsLink = {
  description?: string;
  href?: string;
  title?: string;
};

type LlmsOptions = {
  domain?: string;
  sections?: Array<{ description?: string, links?: LlmsLink[], title?: string }>;
};

export function rawMarkdownUrl(href: string, domain: string) {
  const site = new URL(domain);
  const url = new URL(href, site);
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  const sourceBacked = pathname === "/docs"
    || pathname.startsWith("/docs/")
    || pathname.startsWith("/blog/")
    || ["/about", "/contact", "/privacy"].includes(pathname);
  if (url.origin !== site.origin || !sourceBacked) {
    return href;
  }

  url.pathname = `/raw${pathname}.md`;
  return url.toString();
}

export function rewriteLlmsRawLinks(options: LlmsOptions) {
  if (!options.domain) return;

  for (const section of options.sections || []) {
    for (const link of section.links || []) {
      if (link.href) link.href = rawMarkdownUrl(link.href, options.domain);
    }
  }
}

export const laneLlmsSectionTitle = "ViteHub lane indexes";

export function addLaneLlmsLinks(options: LlmsOptions) {
  if (!options.domain) return;
  options.sections ||= [];
  if (options.sections.some(section => section.title === laneLlmsSectionTitle)) return;

  const site = new URL(options.domain);
  options.sections.push({
    title: laneLlmsSectionTitle,
    description: "Use one lane index when the application uses only Agents or only Server Primitives. Each index lists the pages in the sidebar of that lane.",
    links: docsLanes.map(lane => ({
      title: `ViteHub ${docsLaneTitles[lane]} index`,
      href: new URL(laneLlmsPath(lane), site).toString(),
    })),
  });
}
