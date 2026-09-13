import { markdownTemplateErrorDiagnostics } from "../error-diagnostics.ts"
export const markdownTemplateFileSuffix = ".template.md"
export const markdownTemplateModuleQuery = "markdown-template"
export const markdownTemplateRuntimeSpecifier = "@vite-hub/markdown-template"

export function parseMarkdownTemplateRequest(id: string): { path: string } | undefined {
  const queryIndex = id.indexOf("?")
  const path = id.split(/[?#]/, 1)[0]!
  if (queryIndex === -1) return path.endsWith(markdownTemplateFileSuffix) ? { path } : undefined
  const query = id.slice(queryIndex + 1).split("#", 1)[0]!
  if (!new URLSearchParams(query).has(markdownTemplateModuleQuery)) return
  return { path }
}

export function markdownTemplateMaterializationPath(templatePath: string): string {
  if (!templatePath.startsWith("./") || !templatePath.endsWith(markdownTemplateFileSuffix) || templatePath.includes("\\")) {
    throw markdownTemplateErrorDiagnostics.MARKDOWN_TEMPLATE_B0001({ message: `[vitehub] Markdown materialization requires a relative ${markdownTemplateFileSuffix} path, received ${JSON.stringify(templatePath)}.` })
  }
  const segments = templatePath.slice(2).split("/")
  if (segments.some(segment => !segment || segment === "." || segment === "..")) {
    throw markdownTemplateErrorDiagnostics.MARKDOWN_TEMPLATE_B0002({ message: `[vitehub] Markdown materialization paths cannot escape or contain ambiguous segments, received ${JSON.stringify(templatePath)}.` })
  }
  return templatePath.slice(2, -markdownTemplateFileSuffix.length) + ".md"
}

export function renderMarkdownTemplateModule(template: string, runtimeSpecifier: string = markdownTemplateRuntimeSpecifier): string {
  return [
    `import { renderMarkdownTemplate as vitehubRenderMarkdownTemplate } from ${JSON.stringify(runtimeSpecifier)}`,
    `const vitehubMarkdownTemplate = ${JSON.stringify(template)}`,
    "export default function render(data = {}) {",
    "  return vitehubRenderMarkdownTemplate(vitehubMarkdownTemplate, { data })",
    "}",
    "",
  ].join("\n")
}

export function renderMarkdownTemplateTypes(): string {
  return [
    `declare module "*${markdownTemplateFileSuffix}" {`,
    "  const render: (data?: Record<string, unknown>) => Promise<string>",
    "  export default render",
    "}",
    "",
  ].join("\n")
}
