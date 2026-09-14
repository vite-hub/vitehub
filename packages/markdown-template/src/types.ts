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
  /** Additional Comark plugins applied while parsing this document. */
  plugins?: NonNullable<Parameters<typeof parseMarkdown>[1]>["plugins"]
  maxImportDepth?: number
  resolveImport?: ResolveMarkdownTemplateImport
  sourceId?: string
}

export type RenderMarkdownFileOptions = Pick<RenderMarkdownTemplateOptions, "data" | "maxImportDepth" | "plugins">

export interface RenderMarkdownTemplateInternalOptions extends RenderMarkdownTemplateOptions {
  validateConditionPath?: (path: string) => boolean
}
import type { parseMarkdown } from "comark"
