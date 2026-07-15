export interface MarkdownTemplateImport {
  id: string
  template: string
}

export type ResolveMarkdownTemplateImport = (
  specifier: string,
  importer: string,
) => MarkdownTemplateImport | undefined | Promise<MarkdownTemplateImport | undefined>

export interface RenderMarkdownTemplateOptions {
  data?: Record<string, unknown>
  maxImportDepth?: number
  resolveImport?: ResolveMarkdownTemplateImport
  sourceId?: string
}
