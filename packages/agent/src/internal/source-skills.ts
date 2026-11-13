import { normalizeWorkspaceSourceMetadata } from "@vite-hub/workspace/source-metadata"
import { isRuntimeRecord } from "./runtime-type.ts"
import type { WorkspaceSource, WorkspaceSourceInput } from "@vite-hub/workspace"

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
 * The added Sources fetch only the skill roots and each own only their Skill directory,
 * so a Provider Agent finds them without the rest of the Source.
 */
export function withSourceSkills(sources: Record<string, WorkspaceSourceInput>): Record<string, WorkspaceSourceInput> {
  let result = sources
  for (const [key, input] of Object.entries(sources)) {
    const skillsKey = `${sourceSkillsKeyPrefix}${key}`
    if (key.startsWith("__vitehub") || sourceSkillRoots.every(root => Object.hasOwn(sources, `${skillsKey}:${root}`)) || skillsDisabled(input)) continue
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
    for (const root of sourceSkillRoots) {
      result[`${skillsKey}:${root}`] = {
        source: skillDirectorySource(source, root),
        mount: [metadata.mountPath, root].filter(Boolean).join("/"),
        materialize: "startup",
      }
    }
  }
  return result
}

/** Rebase subset keys so each generated mount owns only one Skill directory. */
function skillDirectorySource(source: WorkspaceSource, root: string): WorkspaceSource {
  const prefix = `${root}/`
  return {
    name: source.name,
    fingerprint: { source: source.fingerprint, root },
    prepare: source.prepare ? ctx => source.prepare!(ctx) : undefined,
    resolveRevision: source.resolveRevision ? ctx => source.resolveRevision!(ctx) : undefined,
    async getKeys(ctx) {
      return (await source.getKeys(ctx)).filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length))
    },
    async getItem(key, ctx) {
      const item = await source.getItem(`${prefix}${key}`, ctx)
      return { ...item, key, path: item.path?.startsWith(prefix) ? item.path.slice(prefix.length) : key }
    },
    getMeta: source.getMeta ? (key, ctx) => source.getMeta!(`${prefix}${key}`, ctx) : undefined,
  }
}
