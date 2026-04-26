export function getCloudflareWorkflowBindingName(name: string): string {
  return `WORKFLOW_${Buffer.from(name).toString("hex").toUpperCase()}`
}

export function getCloudflareWorkflowName(name: string): string {
  return `workflow--${Buffer.from(name).toString("hex")}`
}

export function getCloudflareWorkflowClassName(name: string): string {
  const suffix = name
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .map(segment => `${segment.charAt(0).toUpperCase()}${segment.slice(1)}`)
    .join("")
    || "Default"

  return `ViteHub${suffix}Workflow`
}
