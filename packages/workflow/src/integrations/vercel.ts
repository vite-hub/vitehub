export function getVercelWorkflowName(name: string): string {
  return `workflow--${Buffer.from(name).toString("hex")}`
}
