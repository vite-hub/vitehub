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

export function extractMarkdownTemplateImportSpecifiers(template: string): string[] {
  const visible = template
    .replace(/^( {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\2\s*$/gm, "")
    .replace(/^(?: {4}|\t).*$/gm, "")
    .replace(/`+[^`\n]*`+/g, "")
    .replace(/<[^>]*>/g, "")
  const specifiers = new Set<string>()
  for (const match of visible.matchAll(/@(\.\.?\/[^\s<>{}[\]]+)/g)) {
    const token = match[1]!
    const trailing = token.match(/[.,;:!?)]*$/)?.[0] || ""
    specifiers.add(token.slice(0, token.length - trailing.length))
  }
  return [...specifiers]
}

export function renderMarkdownTemplateModule(template: string, sourceId?: string, imports: Record<string, BundledMarkdownTemplate> = {}, runtimeSpecifier: string = markdownTemplateRuntimeSpecifier): string {
  return [
    `import { renderMarkdownTemplate as vitehubRenderMarkdownTemplate } from ${JSON.stringify(runtimeSpecifier)}`,
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
    for (const specifier of extractMarkdownTemplateImportSpecifiers(template)) {
      const key = `${importer}\0${specifier}`
      if (imports[key]) continue
      const resolved = await load(specifier, importer)
      if (!resolved) throw new Error(`[vitehub] Could not resolve Markdown template import ${JSON.stringify(specifier)} from ${JSON.stringify(importer)}.`)
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
