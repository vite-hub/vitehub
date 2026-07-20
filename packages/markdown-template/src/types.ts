export interface MarkdownTemplateImport {
  id: string
  template: string
}

export type ResolveMarkdownTemplateImport = (
  specifier: string,
  importer: string,
) => MarkdownTemplateImport | undefined | Promise<MarkdownTemplateImport | undefined>

export interface ResolveMarkdownTemplateImportsOptions {
  maxImportDepth?: number
  resolveBareImport?: ResolveMarkdownTemplateImport
  resolveImport?: ResolveMarkdownTemplateImport
  sourceId?: string
}

export interface RenderMarkdownTemplateOptions {
  data?: Record<string, unknown>
  maxImportDepth?: number
  resolveImport?: ResolveMarkdownTemplateImport
  sourceId?: string
}

export interface RenderMarkdownTemplateInternalOptions extends RenderMarkdownTemplateOptions {
  validateConditionPath?: (path: string) => boolean
}
