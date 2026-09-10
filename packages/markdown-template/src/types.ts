export interface RenderMarkdownTemplateOptions {
  data?: Record<string, unknown>
}

export interface RenderMarkdownTemplateInternalOptions extends RenderMarkdownTemplateOptions {
  validateConditionPath?: (path: string) => boolean
}
