import { defineCapability } from "../capability-runtime.ts"

import type {
  AgentAdapterInstructionsValue,
  AgentCapabilityDefinition,
  AgentCapabilityMode,
  AgentCapabilityRuntimeContext,
  AgentRuntimeConfig,
  AgentToolSet,
} from "../types.ts"
import type { WorkspaceName, WorkspaceSourceInput } from "@vite-hub/workspace"

export interface SkillsCapabilityOptions {
  instructions?: string | false
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

function sourceBinding(source: WorkspaceSourceInput, mountPath: string): WorkspaceSourceInput {
  return {
    source: rebaseMountedFileSource(source, mountPath),
    mount: mountPath,
  }
}

function readFrontmatterValue(frontmatter: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = new RegExp(`^${escaped}:\\s*(.+?)\\s*$`, "m").exec(frontmatter)
  const value = match?.[1]?.trim()
  if (!value) return
  return value.replace(/^['"]|['"]$/g, "").trim() || undefined
}

function parseSkillMetadata(content: string): { description?: string, name?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)
  if (!match) return {}
  return {
    description: readFrontmatterValue(match[1] || "", "description"),
    name: readFrontmatterValue(match[1] || "", "name"),
  }
}

async function readSkillMetadata(
  context: AgentCapabilityRuntimeContext<AgentRuntimeConfig, WorkspaceName>,
  skillPath: string,
): Promise<{ description?: string, name?: string }> {
  try {
    const content = await context.fs?.readFile(skillPath as never)
    return typeof content === "string" ? parseSkillMetadata(content) : {}
  }
  catch {
    return {}
  }
}

function renderSkillInstructions(options: {
  directoryPath: string
  metadata: { description?: string, name?: string }
  shellExecution?: AgentCapabilityMode
  skillPath: string
}): AgentAdapterInstructionsValue {
  return [
    `Skill${options.metadata.name ? ` "${options.metadata.name}"` : ""} is mounted at \`${options.directoryPath || "."}\`.`,
    options.metadata.description ? `Description: ${options.metadata.description}` : "",
    `Read \`${options.skillPath}\` before using this skill.`,
    options.shellExecution
      ? `Use the Workspace Shell tools for shell commands described by this skill. They can inspect the workspace${options.shellExecution === "write" ? " and write changes back to it" : ""}.`
      : "",
  ].filter(Boolean).join("\n")
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
  const path = options.path || "skills"
  const normalizedPath = normalizeSkillPath(path)
  const shellExecution = normalizeShellExecution(options.shellExecution)
  const workspaceRequirementMode = shellExecution ?? "read"
  const skillPath = normalizedPath === skillFilename || normalizedPath.endsWith("/SKILL.md")
    ? normalizedPath
    : `${normalizedPath}/SKILL.md`
  const directoryPath = skillDirectory(skillPath)
  const workspaceSources = options.source
    ? {
        [options.sourceKey || skillSourceKey(directoryPath)]: sourceBinding(options.source, directoryPath),
      }
    : undefined

  return defineCapability({
    id: "skills",
    instructions: options.instructions === undefined
      ? async (context: AgentCapabilityRuntimeContext<AgentRuntimeConfig, WorkspaceName>) => renderSkillInstructions({
          directoryPath,
          metadata: await readSkillMetadata(context, skillPath),
          shellExecution,
          skillPath,
        })
      : options.instructions,
    metadata: {
      path: normalizedPath,
      skillPath,
      ...(shellExecution ? { shellExecution } : {}),
      ...(workspaceSources ? { sourceKey: Object.keys(workspaceSources)[0] } : {}),
    },
    requires: [{ primitive: "workspace", workspace: { mode: workspaceRequirementMode, paths: [skillPath], required: true } }],
    ...(workspaceSources ? { workspaceSources } : {}),
    ...(shellExecution
      ? {
          tools: context => workspaceShellTools(shellExecution, context.workspace as never),
        }
      : {}),
  })
}
