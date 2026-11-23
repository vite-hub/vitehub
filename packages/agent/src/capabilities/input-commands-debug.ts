import { resolveDefaultAgentInvocations } from "../invocations/app.ts"

import type { AgentInvocations } from "../invocations.ts"
import type { InputCommand } from "./input-commands.ts"

async function previousInvocation(journal: AgentInvocations, id: string): Promise<{ agentName: string, id: string } | undefined> {
  const current = await journal.getSummary(id)
  if (!current?.agentName) return

  const { agentName, channelId, threadId } = current
  let cursor: string | undefined = current.cursor
  do {
    const page = await journal.list({ agentName, cursor, limit: threadId ? 100 : 1 })
    const previous = page.invocations.find(record => !threadId || (record.threadId === threadId && record.channelId === channelId))
    if (previous) return { agentName, id: previous.id }
    cursor = page.cursor
  } while (cursor)
}

/** The `/debug` command of `inputCommands({ debug: true })`. */
export const debugInputCommand: InputCommand = {
  description: "Link the previous invocation in the ViteHub Console.",
  async call({ context }) {
    const { console: consoleRuntime } = context
    if (!consoleRuntime) return await context.reply("The ViteHub Console is not enabled for this Agent.")
    const id = context.invocation.id
    if (!id) return await context.reply("This invocation is not recorded in the ViteHub Console.")
    const journal = resolveDefaultAgentInvocations()
    if (!journal) return await context.reply("Invocation history is not available on this journal.")
    const previous = await previousInvocation(journal, id)
    if (!previous) return await context.reply("No previous invocation was found in the ViteHub Console.")
    return await context.reply(consoleRuntime.invocationUrl(previous))
  },
}
