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

export interface BundledMarkdownTemplate {
  id: string
  template: string
}

export function markdownTemplateMaterializationPath(templatePath: string): string {
  if (!templatePath.startsWith("./") || !templatePath.endsWith(markdownTemplateFileSuffix) || templatePath.includes("\\")) {
    throw new TypeError(`[vitehub] Markdown materialization requires a relative ${markdownTemplateFileSuffix} path, received ${JSON.stringify(templatePath)}.`)
  }
  const segments = templatePath.slice(2).split("/")
  if (segments.some(segment => !segment || segment === "." || segment === "..")) {
    throw new TypeError(`[vitehub] Markdown materialization paths cannot escape or contain ambiguous segments, received ${JSON.stringify(templatePath)}.`)
  }
  return templatePath.slice(2, -markdownTemplateFileSuffix.length) + ".md"
}

function stripMarkdownCode(template: string): string {
  let fence: { marker: string, length: number, listIndented: boolean } | undefined
  let inList = false
  let previousLineBlank = true
  return template.split("\n").map((line) => {
    const content = line.replace(/^(?: {0,3}> ?)+/, "")
    if (!fence) {
      const listIndented = inList && /^ {4}(?:`{3,}|~{3,})/.test(content)
      const opening = (listIndented ? content.slice(4) : content).match(/^ {0,3}(`{3,}|~{3,})/)
      if (!opening) {
        if (/^ {0,3}(?:[-+*]|\d+[.)])\s+/.test(content)) inList = true
        else if (content.trim() && !/^ {2,}/.test(content)) inList = false
        const indentedCode = (!inList && previousLineBlank && /^(?: {4}|\t)/.test(content))
          || (inList && previousLineBlank && /^(?: {8}| {4}\t|\t{2})/.test(content))
        previousLineBlank = content.trim() === ""
        return indentedCode ? "" : line
      }
      fence = { marker: opening[1]![0]!, length: opening[1]!.length, listIndented }
      previousLineBlank = false
      return ""
    }
    const closing = (fence.listIndented ? content.replace(/^ {4}/, "") : content).match(/^ {0,3}(`+|~+)\s*$/)?.[1]
    if (closing?.[0] === fence.marker && closing.length >= fence.length) fence = undefined
    previousLineBlank = false
    return ""
  }).join("\n")
}

export function extractMarkdownTemplateImportSpecifiers(template: string): string[] {
  const visible = stripMarkdownCode(template)
    .replace(/(`+)[\s\S]*?\1/g, "")
    .replace(/(!?\[[^\]]*\])\([^)]*\)/g, "$1")
    .replace(/^ {0,3}\[[^\]]+\]:\s*\S+/gm, "")
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
    `declare module "*${markdownTemplateFileSuffix}" {`,
    "  const render: (data?: Record<string, unknown>) => Promise<string>",
    "  export default render",
    "}",
    "",
  ].join("\n")
}
