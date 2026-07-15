declare module "*?markdown-template" {
  const render: (data?: Record<string, unknown>) => Promise<string>
  export default render
}
