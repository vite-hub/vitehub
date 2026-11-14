// Markdown negotiation without the Content runtime. The generated Markdown middleware imports this entry, so the server
// starts without the Markdown renderer and loads server/content.ts on the first request that asks for Markdown.
export { acceptsMarkdown, defineContentMarkdownHandler, renderContentMarkdownNotFound } from "./markdown-negotiation.ts"
export type { ContentMarkdownErrorLink, ContentMarkdownHandlerOptions, ContentMarkdownRuntime, ContentMiddleware } from "./markdown-negotiation.ts"
