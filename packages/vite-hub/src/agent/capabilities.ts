export * from "@vite-hub/agent/capabilities"

import { and, desc, eq, lt, or, sql } from "drizzle-orm"
import { inputCommands as baseInputCommands } from "@vite-hub/agent/capabilities"

import { viteHubErrorDiagnostics } from "../error-diagnostics.ts"

import type { AgentCapabilityDefinition } from "@vite-hub/agent"
import type {
  InputCommand,
  InputCommandResult,
  InputCommandRunInput,
  InputCommandsOptions,
} from "@vite-hub/agent/capabilities"
import type { ConsoleInvocationLink, ConsoleRuntime } from "../console/server.ts"
import type { ConsoleInvocationsDatabase } from "../console/runtime/server/invocations.ts"
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core"

export type ConsoleInputCommand = Omit<InputCommand, "call"> & {
  call?: (input: Omit<InputCommandRunInput, "command" | "context"> & {
    command: ConsoleInputCommand
    context: InputCommandRunInput["context"] & { console: ConsoleRuntime }
  }) => InputCommandResult | Promise<InputCommandResult>
}

export interface ConsoleInputCommandsOptions extends Omit<InputCommandsOptions, "commands"> {
  /** Required unless `debug` is `true`. */
  commands?: Record<string, ConsoleInputCommand>
  /**
   * Add `/debug`. It replies with the Console URL of the previous Invocation of the same Agent,
   * in the same chat thread when the Invocation has one. A `debug` entry in `commands` replaces it.
   */
  debug?: boolean
}

/** Finds the latest earlier Invocation of the same Agent, and of the same Channel thread when the current one has a thread. */
async function previousConsoleInvocation(invocations: ConsoleInvocationsDatabase, id: string): Promise<ConsoleInvocationLink | undefined> {
  // Both journal drivers are async SQLite databases with the same columns.
  const db: BaseSQLiteDatabase<"async", unknown, ConsoleInvocationsDatabase["schema"]> = invocations.db
  const table = invocations.schema.invocations
  const [current] = await db
    .select({ agentName: table.agentName, sequence: table.sequence, summary: table.summary })
    .from(table)
    .where(eq(table.id, id))
    .limit(1)
  const agentName = current?.agentName || current?.summary?.agentName
  if (!current || !agentName) return

  const threadId = current.summary?.threadId
  const channelId = current.summary?.channelId
  const filters = [
    or(
      eq(table.agentName, agentName),
      sql`json_extract(${table.summary}, '$.agentName') = ${agentName}`,
    ),
    lt(table.sequence, current.sequence),
  ]
  if (threadId) {
    filters.push(sql`json_extract(${table.summary}, '$.threadId') = ${threadId}`)
    filters.push(channelId
      ? sql`json_extract(${table.summary}, '$.channelId') = ${channelId}`
      : sql`json_extract(${table.summary}, '$.channelId') IS NULL`)
  }
  const [previous] = await db
    .select({
      agentName: sql<string>`coalesce(nullif(${table.agentName}, ''), json_extract(${table.summary}, '$.agentName'))`,
      id: table.id,
    })
    .from(table)
    .where(and(...filters))
    .orderBy(desc(table.sequence))
    .limit(1)
  return previous
}

const debugInputCommand: ConsoleInputCommand = {
  description: "Link the previous invocation in the ViteHub Console.",
  async call({ context }) {
    // The Console Runtime Capability is absent when the application does not enable the Console.
    const { console: consoleRuntime }: { console?: ConsoleRuntime } = context
    if (!consoleRuntime) return await context.reply("The ViteHub Console is not enabled for this Agent.")
    const id = context.invocation.id
    if (!id) return await context.reply("This invocation is not recorded in the ViteHub Console.")
    const previous = await previousConsoleInvocation(consoleRuntime.invocations, id)
    if (!previous) return await context.reply("No previous invocation was found in the ViteHub Console.")
    return await context.reply(consoleRuntime.invocationUrl(previous))
  },
}

export function inputCommands(options: ConsoleInputCommandsOptions): AgentCapabilityDefinition {
  const debug: unknown = options?.debug
  if (debug !== undefined && debug !== true && debug !== false) {
    throw viteHubErrorDiagnostics.VITE_HUB_R0133({ message: "[vitehub] inputCommands({ debug }) must be true or false." })
  }
  const commands: unknown = options?.commands
  // Leave an invalid command map unchanged so that the base Capability reports it.
  const mergeable = commands === undefined || (!Array.isArray(commands) && Object(commands) === commands)
  // SAFETY: This wrapper only narrows the Console command context supplied by the generated Console Runtime Capability.
  return baseInputCommands((debug && mergeable
    ? { ...options, commands: { debug: debugInputCommand, ...options.commands } }
    : options) as InputCommandsOptions)
}
