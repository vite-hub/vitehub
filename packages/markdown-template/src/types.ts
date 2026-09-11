export interface RenderMarkdownTemplateOptions {
  data?: Record<string, unknown>
}

export type RenderMarkdownFileOptions = Pick<RenderMarkdownTemplateOptions, "data" | "maxImportDepth">

export interface RenderMarkdownTemplateInternalOptions extends RenderMarkdownTemplateOptions {
  validateConditionPath?: (path: string) => boolean
}
