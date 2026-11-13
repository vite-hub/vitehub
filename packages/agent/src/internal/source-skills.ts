import { normalizeWorkspaceSourceMetadata } from "@vite-hub/workspace/source-metadata"
import { isRuntimeRecord } from "./runtime-type.ts"
import type { WorkspaceSourceInput } from "@vite-hub/workspace"

/** The skill roots that a Source can hold, relative to the Source. */
const sourceSkillRoots = [".agents/skills", ".codex/skills", ".claude/skills"] as const

const sourceSkillsKeyPrefix = "__vitehubSourceSkills:"

/** True when a Source binding sets `skills: false`, at any binding level. */
function skillsDisabled(source: unknown): boolean {
  if (!isRuntimeRecord(source)) return false
  if (Object.hasOwn(source, "skills") && source.skills === false) return true
  return Object.hasOwn(source, "source") && skillsDisabled(source.source)
}

/**
 * The mount paths of the Sources whose Skills a Provider Agent reads, in declaration order.
 * Root-mounted Sources are left out, because their Skills are already at the Workspace root.
 */
export function sourceSkillMounts(sources: Record<string, WorkspaceSourceInput> | undefined): string[] {
  const mounts: string[] = []
  for (const [key, input] of Object.entries(sources ?? {})) {
    if (key.startsWith("__vitehub") || skillsDisabled(input)) continue
    let mountPath: string
    try {
      const metadata = normalizeWorkspaceSourceMetadata(key, input)
      if (metadata.requestOnly) continue
      mountPath = metadata.mountPath
    }
    catch {
      continue
    }
    if (mountPath && !mounts.includes(mountPath)) mounts.push(mountPath)
  }
  return mounts
}

/**
 * Adds a startup Source for the Skill folders of each Source with `materialize: "none"`.
 * The added Source fetches only the skill roots and mounts them at the same path,
 * so a Provider Agent finds them without the rest of the Source.
 */
export function withSourceSkills(sources: Record<string, WorkspaceSourceInput>): Record<string, WorkspaceSourceInput> {
  let result = sources
  for (const [key, input] of Object.entries(sources)) {
    const skillsKey = `${sourceSkillsKeyPrefix}${key}`
    if (key.startsWith("__vitehub") || Object.hasOwn(sources, skillsKey) || skillsDisabled(input)) continue
    let metadata
    try {
      metadata = normalizeWorkspaceSourceMetadata(key, input)
    }
    catch {
      continue
    }
    if (metadata.materialize !== "none" || metadata.requestOnly || !metadata.source.subset) continue
    const source = metadata.source.subset(sourceSkillRoots.map(root => `${root}/**`))
    if (result === sources) result = { ...sources }
    result[skillsKey] = { source, mount: metadata.mountPath, materialize: "startup" }
  }
  return result
}
