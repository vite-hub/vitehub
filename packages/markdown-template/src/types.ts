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
  /** Additional Comark plugins applied while parsing this document. */
  plugins?: NonNullable<Parameters<typeof parseMarkdown>[1]>["plugins"]
}

export type RenderMarkdownFileOptions = Pick<RenderMarkdownTemplateOptions, "data" | "plugins">

export interface RenderMarkdownTemplateInternalOptions extends RenderMarkdownTemplateOptions {
  validateConditionPath?: (path: string) => boolean
}
import type { parseMarkdown } from "comark"
