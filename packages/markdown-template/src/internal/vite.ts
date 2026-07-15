export const markdownTemplateQuery = "markdown-template"

export function parseMarkdownTemplateRequest(id: string): { path: string } | undefined {
  const queryIndex = id.indexOf("?")
  if (queryIndex === -1) return
  const query = id.slice(queryIndex + 1).split("#", 1)[0]!
  if (!new URLSearchParams(query).has(markdownTemplateQuery)) return
  return { path: id.slice(0, queryIndex) }
}

export function renderMarkdownTemplateModule(template: string, runtimeImport: string): string {
  return [
    `import { renderMarkdownTemplate as vitehubRenderMarkdownTemplate } from ${JSON.stringify(runtimeImport)}`,
    `const vitehubMarkdownTemplate = ${JSON.stringify(template)}`,
    "export default function render(data = {}) {",
    "  return vitehubRenderMarkdownTemplate(vitehubMarkdownTemplate, { data })",
    "}",
    "",
  ].join("\n")
}

export function renderMarkdownTemplateTypes(): string {
  return [
    `declare module "*?${markdownTemplateQuery}" {`,
    "  const render: (data?: Record<string, unknown>) => Promise<string>",
    "  export default render",
    "}",
    "",
  ].join("\n")
}
