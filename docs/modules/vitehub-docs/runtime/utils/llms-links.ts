type LlmsLink = {
  href?: string;
};

type LlmsOptions = {
  domain?: string;
  sections?: Array<{ links?: LlmsLink[] }>;
};

export function rawMarkdownUrl(href: string, domain: string) {
  const site = new URL(domain);
  const url = new URL(href, site);
  if (url.origin !== site.origin || (url.pathname !== "/docs" && !url.pathname.startsWith("/docs/"))) {
    return href;
  }

  const pathname = url.pathname === "/docs/" ? "/docs" : url.pathname.replace(/\/+$/, "");
  url.pathname = `/raw${pathname}.md`;
  return url.toString();
}

export function rewriteLlmsDocsLinks(options: LlmsOptions) {
  if (!options.domain) return;

  for (const section of options.sections || []) {
    for (const link of section.links || []) {
      if (link.href) link.href = rawMarkdownUrl(link.href, options.domain);
    }
  }
}
