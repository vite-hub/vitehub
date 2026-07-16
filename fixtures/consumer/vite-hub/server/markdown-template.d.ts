declare module "*.template.md" {
  const render: (data?: Record<string, unknown>) => Promise<string>
  export default render
}

declare module "#vitehub/templates" {
  export type TemplateName = "echo"
  export function renderTemplate(name: TemplateName, data?: Record<string, unknown>): Promise<string>
}
