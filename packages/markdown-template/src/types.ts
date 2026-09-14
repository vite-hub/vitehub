export interface RenderMarkdownTemplateOptions {
  data?: Record<string, unknown>
}

export type RenderMarkdownFileOptions = Pick<RenderMarkdownTemplateOptions, "data">

export interface RenderMarkdownTemplateInternalOptions extends RenderMarkdownTemplateOptions {
  validateFragmentPath?: (path: string) => boolean
  validateConditionPath?: (path: string) => boolean
}
