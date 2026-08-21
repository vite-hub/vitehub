import { defineCapability, workspaceMaterializationPathsSymbol } from "../capability-runtime.ts"

import type {
  AgentCapabilityDefinition,
  AgentCapabilityMode,
  AgentToolSet,
} from "../types.ts"
import type { WorkspaceSourceInput } from "@vite-hub/workspace"

export interface SkillsCapabilityOptions {
  path?: string
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

function sourceBinding(source: WorkspaceSourceInput, mountPath: string, sourceMountPath = mountPath): WorkspaceSourceInput {
  return {
    source: rebaseMountedFileSource(source, sourceMountPath),
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
  const shellExecution = normalizeShellExecution(options.shellExecution)
  const workspaceRequirementMode = shellExecution ?? "read"
  const skillPath = normalizedPath === skillFilename || normalizedPath.endsWith("/SKILL.md")
    ? normalizedPath
    : `${normalizedPath}/SKILL.md`
  const directoryPath = skillDirectory(skillPath)
  const providerWorkspacePath = directoryPath || skillPath
  const sourceKey = options.sourceKey || skillSourceKey(directoryPath)
  const workspaceSources = options.source
    ? {
        [sourceKey]: sourceBinding(options.source, directoryPath),
      }
    : undefined

  const capability = defineCapability({
    id: "skills",
    metadata: {
      path: normalizedPath,
      skillPath,
      ...(shellExecution ? { shellExecution } : {}),
      ...(workspaceSources ? { sourceKey: Object.keys(workspaceSources)[0] } : {}),
    },
    requires: [{ primitive: "workspace" as const, workspace: { mode: workspaceRequirementMode, paths: [skillPath], required: true } }],
    ...(workspaceSources ? { workspaceSources } : {}),
    ...(shellExecution
      ? {
          tools: context => context.driver?.kind === "provider" ? undefined : workspaceShellTools(shellExecution, context.workspace as never),
        }
      : {}),
  })

  return Object.assign(capability, {
    [workspaceMaterializationPathsSymbol]: [providerWorkspacePath],
  })
}
