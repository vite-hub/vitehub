export interface RenderMarkdownTemplateOptions {
  data?: Record<string, unknown>
}

export interface RenderMarkdownTemplateInternalOptions extends RenderMarkdownTemplateOptions {
  validateFragmentPath?: (path: string) => boolean
  validateConditionPath?: (path: string) => boolean
}
