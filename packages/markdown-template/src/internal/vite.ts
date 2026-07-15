export const markdownTemplateQuery = "markdown-template"
export const markdownTemplateRuntimeSpecifier = "@vite-hub/markdown-template"

export function parseMarkdownTemplateRequest(id: string): { path: string } | undefined {
  const queryIndex = id.indexOf("?")
  if (queryIndex === -1) return
  const query = id.slice(queryIndex + 1).split("#", 1)[0]!
  if (!new URLSearchParams(query).has(markdownTemplateQuery)) return
  return { path: id.slice(0, queryIndex) }
}

export interface BundledMarkdownTemplate {
  id: string
  template: string
}

export function renderMarkdownTemplateModule(template: string, sourceId?: string, imports: Record<string, BundledMarkdownTemplate> = {}): string {
  return [
    `import { renderMarkdownTemplate as vitehubRenderMarkdownTemplate } from ${JSON.stringify(markdownTemplateRuntimeSpecifier)}`,
    `const vitehubMarkdownTemplate = ${JSON.stringify(template)}`,
    `const vitehubMarkdownTemplateSourceId = ${JSON.stringify(sourceId)}`,
    `const vitehubMarkdownTemplateImports = ${JSON.stringify(imports)}`,
    "export default function render(data = {}) {",
    "  return vitehubRenderMarkdownTemplate(vitehubMarkdownTemplate, {",
    "    data,",
    "    sourceId: vitehubMarkdownTemplateSourceId,",
    "    resolveImport: (specifier, importer) => vitehubMarkdownTemplateImports[`${importer}\\0${specifier}`],",
    "  })",
    "}",
    "",
  ].join("\n")
}

export async function bundleMarkdownTemplateImports(
  sourceId: string,
  load: (specifier: string, importer: string) => Promise<BundledMarkdownTemplate | undefined>,
): Promise<Record<string, BundledMarkdownTemplate>> {
  const imports: Record<string, BundledMarkdownTemplate> = {}
  const visited = new Set([sourceId])

  async function visit(template: string, importer: string): Promise<void> {
    for (const match of template.matchAll(/@(\.\.?\/[^\s<>{}[\]]+)/g)) {
      const specifier = match[1]!
      const key = `${importer}\0${specifier}`
      if (imports[key]) continue
      const resolved = await load(specifier, importer)
      if (!resolved) continue
      imports[key] = resolved
      if (visited.has(resolved.id)) continue
      visited.add(resolved.id)
      await visit(resolved.template, resolved.id)
    }
  }

  const root = await load(".", sourceId)
  if (root) await visit(root.template, sourceId)
  return imports
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
