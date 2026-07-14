import { defineCapability, globalSkillsSymbol, workspaceMaterializationPathsSymbol } from "../capability-runtime.ts"

import type {
  AgentCapabilityDefinition,
  AgentCapabilityMode,
  AgentToolSet,
} from "../types.ts"
import type { WorkspaceSourceInput } from "@vite-hub/workspace"

export interface SkillsCapabilityOptions {
  path?: string
  scope?: "global" | "workspace"
  shellExecution?: AgentCapabilityMode
  source?: WorkspaceSourceInput
  sourceKey?: string
}

const skillFilename = "SKILL.md"

function normalizeShellExecution(value: unknown): AgentCapabilityMode | undefined {
  if (value === undefined) return undefined
  if (value === "read" || value === "write") return value
  throw new TypeError("[vitehub] skills({ shellExecution }) must be \"read\" or \"write\".")
}

function normalizeSkillScope(value: unknown): "global" | "workspace" {
  if (value === undefined || value === "workspace") return "workspace"
  if (value === "global") return value
  throw new TypeError("[vitehub] skills({ scope }) must be \"workspace\" or \"global\".")
}

function normalizeSkillPath(path: string): string {
  return path.replace(/\/+$/, "")
}

function skillDirectory(skillPath: string): string {
  return skillPath.endsWith(`/${skillFilename}`)
    ? skillPath.slice(0, -1 * (`/${skillFilename}`).length)
    : skillPath === skillFilename ? "" : skillPath
}

function skillSourceKey(path: string): string {
  const suffix = (path || "root")
    .replace(/^skills\//, "")
    .replace(/[^A-Za-z0-9_.-]+/g, ".")
    .replace(/^\.+|\.+$/g, "") || "root"
  return `skill.${suffix}`
}

function rebaseMountedFileSource(source: WorkspaceSourceInput, mountPath: string): WorkspaceSourceInput {
  const normalizedMount = normalizeSkillPath(mountPath)
  if (!normalizedMount) return source
  if (typeof source === "string") {
    const workspacePath = workspacePathInsideMount(source, normalizedMount)
    return workspacePath ? { path: source, workspacePath } : source
  }
  if (!isPlainFileSource(source) || typeof source.workspacePath === "string") return source
  const workspacePath = workspacePathInsideMount(source.path, normalizedMount)
  return workspacePath ? { ...source, workspacePath } as WorkspaceSourceInput : source
}

function isPlainFileSource(source: WorkspaceSourceInput): source is { path: string, workspacePath?: string } {
  if (!source || typeof source !== "object") return false
  if (!("path" in source) || typeof source.path !== "string") return false
  return !("repo" in source)
    && !("root" in source)
    && !("include" in source)
    && !("url" in source)
    && !("source" in source)
    && !("server" in source)
    && !("getKeys" in source)
}

function workspacePathInsideMount(path: string, mountPath: string) {
  const normalized = normalizeSkillPath(path)
  return normalized.startsWith(`${mountPath}/`) ? normalized.slice(mountPath.length + 1) : undefined
}

function sourceBinding(source: WorkspaceSourceInput, mountPath: string): WorkspaceSourceInput {
  return {
    source: rebaseMountedFileSource(source, mountPath),
    mount: mountPath,
  }
}

function workspaceShellTools(
  mode: AgentCapabilityMode,
  workspace: { tools: { inspect: () => AgentToolSet, write?: () => AgentToolSet } } | undefined,
): AgentToolSet {
  if (!workspace) throw new Error("[vitehub] skills({ shellExecution }) requires an explicit workspace.")
  return (mode === "write" && workspace.tools.write
    ? workspace.tools.write()
    : workspace.tools.inspect()) as AgentToolSet
}

export function skills(options: SkillsCapabilityOptions = {}): AgentCapabilityDefinition {
  const normalizedPath = normalizeSkillPath(options.path || "skills")
  const scope = normalizeSkillScope(options.scope)
  if (scope === "global" && !options.source) {
    throw new TypeError("[vitehub] skills({ scope: \"global\" }) requires source.")
  }
  if (scope === "global" && options.shellExecution !== undefined) {
    throw new TypeError("[vitehub] skills({ scope: \"global\" }) does not support shellExecution.")
  }
  const shellExecution = normalizeShellExecution(options.shellExecution)
  const workspaceRequirementMode = shellExecution ?? "read"
  const skillPath = normalizedPath === skillFilename || normalizedPath.endsWith("/SKILL.md")
    ? normalizedPath
    : `${normalizedPath}/SKILL.md`
  const directoryPath = skillDirectory(skillPath)
  const harnessWorkspacePath = directoryPath || skillPath
  const sourceKey = options.sourceKey || skillSourceKey(directoryPath)
  const workspaceSources = options.source
    ? {
        [sourceKey]: sourceBinding(options.source, directoryPath),
      }
    : undefined

  const capability = defineCapability({
    id: scope === "global" ? `skills.${sourceKey}` : "skills",
    metadata: {
      path: normalizedPath,
      scope,
      skillPath,
      ...(shellExecution ? { shellExecution } : {}),
      ...(workspaceSources ? { sourceKey: Object.keys(workspaceSources)[0] } : {}),
    },
    ...(scope === "workspace"
      ? { requires: [{ primitive: "workspace" as const, workspace: { mode: workspaceRequirementMode, paths: [skillPath], required: true } }] }
      : {}),
    ...(scope === "workspace" && workspaceSources ? { workspaceSources } : {}),
    ...(scope === "global"
      ? {
          prepare: (context) => {
            if (context.driver?.kind !== "harness") {
              throw new Error("[vitehub] skills({ scope: \"global\" }) requires a Harness Agent Driver.")
            }
          },
        }
      : {}),
    ...(shellExecution
      ? {
          tools: context => context.driver?.kind === "harness" ? undefined : workspaceShellTools(shellExecution, context.workspace as never),
        }
      : {}),
  })

  if (scope === "global") {
    const path = directoryPath.replace(/^skills(?:\/|$)/, "")
    return Object.assign(capability, {
      [globalSkillsSymbol]: {
        path,
        source: sourceBinding(options.source!, path),
        sourceKey,
      },
    })
  }

  return Object.assign(capability, {
    [workspaceMaterializationPathsSymbol]: [harnessWorkspacePath],
  })
}
