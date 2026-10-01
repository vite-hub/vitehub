import { rawMarkdownUrl } from "./llms-links";

export const docsSiteUrl = "https://vitehub.dev";
export const docsMcpServerName = "vitehub";
export const docsMcpUrl = `${docsSiteUrl}/mcp`;

export type PageActionLinks = {
  /** Raw Markdown path on the current origin. Local and preview hosts serve it too. */
  markdownPath: string;
  /** Canonical raw Markdown URL that external chat tools can fetch. */
  markdownUrl: string;
  prompt: string;
  chatGptUrl: string;
  claudeUrl: string;
};

export function pageChatPrompt(markdownUrl: string) {
  return `Read ${markdownUrl} from the ViteHub documentation. Use it as context to answer my questions and to help me apply it in my project.`;
}

export function pageActionLinks(routePath: string): PageActionLinks | null {
  const markdownUrl = rawMarkdownUrl(routePath, docsSiteUrl);
  if (!markdownUrl.startsWith(`${docsSiteUrl}/raw/`)) return null;

  const prompt = pageChatPrompt(markdownUrl);
  return {
    markdownPath: markdownUrl.slice(docsSiteUrl.length),
    markdownUrl,
    prompt,
    chatGptUrl: `https://chatgpt.com/?hints=search&q=${encodeURIComponent(prompt)}`,
    claudeUrl: `https://claude.ai/new?q=${encodeURIComponent(prompt)}`,
  };
}

/** Cursor MCP install deeplink. The format matches the @nuxtjs/mcp-toolkit deeplink route. */
export function cursorMcpInstallUrl(name = docsMcpServerName, url = docsMcpUrl) {
  const config = btoa(JSON.stringify({ type: "http", url }));
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(name)}&config=${encodeURIComponent(config)}`;
}

/** VS Code MCP install deeplink. The format matches the @nuxtjs/mcp-toolkit deeplink route. */
export function vscodeMcpInstallUrl(name = docsMcpServerName, url = docsMcpUrl) {
  return `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name, type: "http", url }))}`;
}
