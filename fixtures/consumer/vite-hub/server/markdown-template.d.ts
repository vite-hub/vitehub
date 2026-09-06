declare module "*.template.md" {
  const render: (data?: Record<string, unknown>) => Promise<string>
  export default render
}
