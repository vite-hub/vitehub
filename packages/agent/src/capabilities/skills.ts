import { defineCapability } from "../capability-runtime.ts"

import type {
  AgentCapabilityDefinition,
  AgentCapabilityMode,
} from "../types.ts"

export interface SkillsCapabilityOptions {
  path?: string
  shellExecution?: AgentCapabilityMode
}

function normalizeShellExecution(value: unknown): AgentCapabilityMode | undefined {
  if (value === undefined) return undefined
  if (value === "read" || value === "write") return value
  throw new TypeError("[vitehub] skills({ shellExecution }) must be \"read\" or \"write\".")
}

export function skills(options: SkillsCapabilityOptions = {}): AgentCapabilityDefinition {
  const path = options.path || "skills"
  const normalizedPath = path.replace(/\/+$/, "")
  const shellExecution = normalizeShellExecution(options.shellExecution)
  const skillPath = normalizedPath.endsWith("/SKILL.md")
    ? normalizedPath
    : `${normalizedPath}/SKILL.md`
  return defineCapability({
    id: "skills",
    metadata: { path: normalizedPath, skillPath, ...(shellExecution ? { shellExecution } : {}) },
    requires: [{ primitive: "workspace", workspace: { mode: shellExecution === "write" ? "write" : "read", paths: [skillPath], required: true } }],
  })
}
