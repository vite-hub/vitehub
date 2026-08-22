const markdownMediaType = "text/markdown";

interface AcceptEntry {
  mediaType: string;
  quality: number;
}

function quality(parameter: string | undefined): number {
  if (!parameter) return 1;
  const value = Number(parameter);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0;
}

function parseAccept(acceptHeader: string): AcceptEntry[] {
  return acceptHeader.split(",").map((entry) => {
    const [mediaType, ...parameters] = entry.trim().toLowerCase().split(";").map(value => value.trim());
    const qualityParameter = parameters.find(parameter => parameter.startsWith("q="));
    return {
      mediaType: mediaType || "",
      quality: quality(qualityParameter?.slice(2)),
    };
  });
}

export function acceptsAgentFriendlyError(acceptHeader: string | undefined): boolean {
  if (!acceptHeader) return true;
  const entries = parseAccept(acceptHeader);
  const explicitMarkdown = entries.filter(entry => entry.mediaType === markdownMediaType);
  if (explicitMarkdown.length > 0) {
    return explicitMarkdown.some(entry => entry.quality > 0);
  }

  const accepts = (mediaType: string) => entries.some(entry => entry.mediaType === mediaType && entry.quality > 0);
  return accepts("*/*") && !accepts("text/html") && !accepts("application/json");
}

export function withVary(current: string | undefined, value: string): string {
  const values = (current || "")
    .split(",")
    .map(entry => entry.trim())
    .filter(Boolean);

  if (!values.some(entry => entry.toLowerCase() === value.toLowerCase())) {
    values.push(value);
  }

  return values.join(", ");
}

export function notFoundMarkdown(pathname: string): string {
  const safePath = pathname.replaceAll("`", "\\`");
  return `# ViteHub page not found\n\nNo published ViteHub page exists at \`${safePath}\`.\n\n- [Documentation index](https://vitehub.dev/docs)\n- [Agent-readable index](https://vitehub.dev/llms.txt)\n- [Sitemap](https://vitehub.dev/sitemap.xml)\n`;
}
