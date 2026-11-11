import { getAgentInvocationsDatabase } from "../invocations/drizzle.ts"

import type { AgentInvocationsDatabase } from "../invocations/journal-database.ts"
import type { InputCommand } from "./input-commands.ts"

/** Finds the latest earlier Invocation of the same Agent, and of the same Channel thread when the current one has a thread. */
async function previousInvocation(invocations: AgentInvocationsDatabase, id: string): Promise<{ agentName: string, id: string } | undefined> {
  // Only the default journal reaches here, so an Agent app with another journal does not need drizzle-orm.
  const { and, desc, eq, lt, or, sql } = await import("drizzle-orm")
  const db = invocations.db
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

/** The `/debug` command of `inputCommands({ debug: true })`. */
export const debugInputCommand: InputCommand = {
  description: "Link the previous invocation in the ViteHub Console.",
  async call({ context }) {
    // The Console Runtime Capability is absent when the application does not enable the Console.
    const { console: consoleRuntime } = context
    if (!consoleRuntime) return await context.reply("The ViteHub Console is not enabled for this Agent.")
    const id = context.invocation.id
    if (!id) return await context.reply("This invocation is not recorded in the ViteHub Console.")
    const database = await getAgentInvocationsDatabase()
    // Another journal store, or a Worker without D1 or a remote libSQL URL, has no history query.
    if (!database) return await context.reply("Invocation history is not available on this journal.")
    const previous = await previousInvocation(database, id)
    if (!previous) return await context.reply("No previous invocation was found in the ViteHub Console.")
    return await context.reply(consoleRuntime.invocationUrl(previous))
  },
}
