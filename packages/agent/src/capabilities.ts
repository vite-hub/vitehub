import {
  defineCapability,
  normalizeMode,
} from "./capability-runtime.ts"

import type {
  AgentCapabilityContext,
  AgentCapabilityDefinition,
  AgentCapabilityMode,
  AgentToolDefinition,
  AgentToolSet,
  MaybePromise,
} from "./types.ts"

function primitiveHandle(context: AgentCapabilityContext, name: string): unknown {
  const handle = context.capabilities?.[name] as { value?: unknown } | unknown
  return typeof handle === "object" && handle !== null && "value" in handle
    ? (handle as { value?: unknown }).value
    : handle
}

function requirePrimitive(context: AgentCapabilityContext, name: string): unknown {
  const handle = primitiveHandle(context, name)
  if (!handle) throw new Error(`[vitehub] Capability "${name}" requires the ${name} primitive to be configured.`)
  return handle
}

function defineInternalTool<TInput = unknown, TOutput = unknown>(
  tool: AgentToolDefinition<TInput, TOutput>,
): AgentToolDefinition<TInput, TOutput> {
  if (!tool || typeof tool !== "object") {
    throw new TypeError("[vitehub] tool definitions must be objects.")
  }
  if (!tool.name || typeof tool.name !== "string") {
    throw new TypeError("[vitehub] tool definitions require a tool name.")
  }
  return tool
}

function validateSandboxCommands(commands: unknown): string[] {
  if (!Array.isArray(commands) || !commands.length) {
    throw new TypeError("[vitehub] sandbox({ commands }) requires at least one executable name.")
  }
  for (const command of commands) {
    if (typeof command !== "string" || !/^[A-Za-z0-9_.-]+$/.test(command)) {
      throw new TypeError("[vitehub] sandbox({ commands }) accepts executable names only, not shell command strings.")
    }
  }
  return commands
}

export function bash(options: { mode?: AgentCapabilityMode } = {}): AgentCapabilityDefinition {
  const mode = normalizeMode(options.mode, "Bash")
  return defineCapability({
    id: "bash",
    mode,
    requires: [{ primitive: "workspace", workspace: { mode, required: true } }],
    tools: ({ workspace }) => (mode === "write" && "write" in workspace.tools
      ? (workspace.tools as unknown as { write: () => AgentToolSet }).write()
      : workspace.tools.inspect()) as AgentToolSet,
  })
}

export function sandbox(options: { commands: string[] }): AgentCapabilityDefinition {
  const commands = validateSandboxCommands(options?.commands)
  return defineCapability({
    id: "sandbox",
    metadata: { commands },
    requires: [{ primitive: "workspace", workspace: { required: true } }, { primitive: "sandbox" }],
    tools: (context) => {
      const handle = requirePrimitive(context as never, "sandbox") as {
        exec?: (command: string, args?: string[], options?: unknown) => MaybePromise<unknown>
      }
      return {
        sandbox_exec: defineInternalTool({
          description: `Run one allowed executable in an isolated sandbox. Allowed commands: ${commands.join(", ")}.`,
          name: "sandbox_exec",
          async execute(input) {
            const value = input as { args?: string[], command?: string, cwd?: string, env?: Record<string, string>, timeout?: number }
            if (!value || typeof value.command !== "string") throw new TypeError("[vitehub] sandbox_exec requires a command.")
            if (!commands.includes(value.command)) throw new Error(`[vitehub] Sandbox command "${value.command}" is not allowed.`)
            if (!handle.exec) throw new Error("[vitehub] Sandbox primitive does not expose exec().")
            return await handle.exec(value.command, value.args || [], { cwd: value.cwd, env: value.env, timeout: value.timeout })
          },
        }),
      }
    },
  })
}

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

export {
  blob,
  db,
  kv,
} from "./capabilities/storage/index.ts"
export {
  memory,
  workspaceJsonlMemoryStore,
} from "./memory.ts"
export {
  mcp,
} from "./mcp/capability.ts"
export {
  normalizeAgentUsage,
  staticModelPricing,
  usageTelemetry,
  vercelAiGatewayPricing,
} from "./capabilities/usage-telemetry.ts"

export type {
  BlobCapabilityOptions,
  DBCapabilityOptions,
  KVCapabilityOptions,
  StorageToolPolicy,
} from "./capabilities/storage/index.ts"
export type {
  MemoryAppendRequest,
  MemoryCapabilityInstructionsOption,
  MemoryCapabilityOptions,
  MemoryDeleteRequest,
  MemoryExportRequest,
  MemoryKind,
  MemoryProvenance,
  MemoryReadRequest,
  MemoryRecord,
  MemoryScope,
  MemorySearchRequest,
  MemorySearchResult,
  MemoryStoreAdapter,
  MemoryStoreFactory,
  MemoryStoreOptions,
  WorkspaceJsonlMemoryStoreOptions,
} from "./memory.ts"
export type {
  McpCapabilityOptions,
  McpClient,
  McpClientConfig,
  McpServerConfig,
} from "./mcp/types.ts"
export type {
  AgentUsagePricing,
  AgentUsagePricingContext,
  StaticModelPrice,
  UsageTelemetryOptions,
  VercelAiGatewayPricingOptions,
} from "./capabilities/usage-telemetry.ts"
