import { defineCapability } from "../capability-runtime.ts"

import type {
  AgentCapabilityDefinition,
  AgentCapabilityMode,
  AgentToolSet,
} from "../types.ts"
import type { WorkspaceSession, WorkspaceSessionOptions } from "@vite-hub/workspace"

export interface SkillsCapabilityOptions {
  maxOutputLength?: number
  path?: string
  shellExecution?: AgentCapabilityMode
  timeout?: number
}

interface SkillShellInput {
  command?: string
  cwd?: string
  timeout?: number
}

type SkillShellWorkspace = {
  startSession: (options?: WorkspaceSessionOptions) => Promise<WorkspaceSession>
}

const defaultMaxOutputLength = 30_000

function normalizeShellExecution(value: unknown): AgentCapabilityMode | undefined {
  if (value === undefined) return undefined
  if (value === "read" || value === "write") return value
  throw new TypeError("[vitehub] skills({ shellExecution }) must be \"read\" or \"write\".")
}

function isSkillShellWorkspace(workspace: unknown): workspace is SkillShellWorkspace {
  return typeof workspace === "object"
    && workspace !== null
    && typeof (workspace as { startSession?: unknown }).startSession === "function"
}

function limitOutput(value: string, maxLength: number) {
  if (value.length <= maxLength) return { output: value, truncated: false }
  return {
    output: `${value.slice(0, maxLength)}\n[vitehub] Output truncated after ${maxLength} characters.`,
    truncated: true,
  }
}

function skillShellInputSchema() {
  return {
    additionalProperties: false,
    properties: {
      command: { description: "Shell command from the mounted skill instructions.", type: "string" },
      cwd: { description: "Workspace-relative directory. Defaults to the workspace root.", type: "string" },
      timeout: { description: "Optional timeout in milliseconds for this command.", type: "number" },
    },
    required: ["command"],
    type: "object",
  }
}

function skillShellTools(
  mode: AgentCapabilityMode,
  options: Required<Pick<SkillsCapabilityOptions, "maxOutputLength">> & Pick<SkillsCapabilityOptions, "timeout">,
  getSession: () => Promise<WorkspaceSession>,
): AgentToolSet {
  return {
    skill_shell: {
      description: [
        "Run one shell command from the mounted skill instructions in the active Workspace Session.",
        mode === "write"
          ? "Successful commands are committed back to the workspace."
          : "Workspace changes are discarded in read mode.",
      ].join(" "),
      async execute(input: unknown) {
        const value = input as SkillShellInput
        const command = value?.command?.trim()
        if (!command) throw new Error("[vitehub] skill_shell requires a non-empty command.")
        const session = await getSession()
        try {
          const result = await session.exec("bash", ["-lc", command], {
            cwd: value.cwd,
            timeout: value.timeout ?? options.timeout,
          })
          if (mode === "write" && result.exitCode === 0) await session.commit({ message: "skill shell" })
          const stdout = limitOutput(result.stdout, options.maxOutputLength)
          const stderr = limitOutput(result.stderr, options.maxOutputLength)
          return {
            args: result.args,
            command,
            cwd: value.cwd || "",
            exitCode: result.exitCode,
            outputTruncated: stdout.truncated || stderr.truncated,
            stderr: stderr.output,
            stdout: stdout.output,
          }
        }
        finally {
          await session.close()
        }
      },
      inputSchema: skillShellInputSchema(),
      name: "skill_shell",
    },
  }
}

export function skills(options: SkillsCapabilityOptions = {}): AgentCapabilityDefinition {
  const path = options.path || "skills"
  const normalizedPath = path.replace(/\/+$/, "")
  const shellExecution = normalizeShellExecution(options.shellExecution)
  const maxOutputLength = options.maxOutputLength ?? defaultMaxOutputLength
  const skillPath = normalizedPath.endsWith("/SKILL.md")
    ? normalizedPath
    : `${normalizedPath}/SKILL.md`

  function getSessionResolver(context: { workspace?: unknown }): () => Promise<WorkspaceSession> {
    return async () => {
      const workspace = context.workspace
      if (!isSkillShellWorkspace(workspace)) {
        throw new Error("[vitehub] skills({ shellExecution }) requires an executable workspace session.")
      }
      return await workspace.startSession({ paths: [normalizedPath] })
    }
  }

  return defineCapability({
    id: "skills",
    metadata: { path: normalizedPath, skillPath, ...(shellExecution ? { shellExecution } : {}) },
    requires: [{ primitive: "workspace", workspace: { mode: shellExecution === "write" ? "write" : "read", paths: [skillPath], required: true } }],
    ...(shellExecution
      ? {
          tools: context => skillShellTools(shellExecution, {
            maxOutputLength,
            timeout: options.timeout,
          }, getSessionResolver(context)),
        }
      : {}),
  })
}
