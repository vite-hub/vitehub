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
