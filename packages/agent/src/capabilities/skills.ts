import { defineCapability } from "../capability-runtime.ts"

import type { AgentCapabilityDefinition } from "../types.ts"

export function skills(options: { path?: string } = {}): AgentCapabilityDefinition {
  const path = options.path || "skills"
  const skillPath = path.replace(/\/+$/, "").endsWith("/SKILL.md")
    ? path.replace(/\/+$/, "")
    : `${path.replace(/\/+$/, "")}/SKILL.md`
  return defineCapability({
    id: "skills",
    metadata: { path: path.replace(/\/+$/, ""), skillPath },
    requires: [{ primitive: "workspace", workspace: { mode: "read", paths: [skillPath], required: true } }],
  })
}
