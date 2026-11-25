import * as v from "valibot"

import { consoleState } from "../../console/internal.ts"
import { consoleOperationRequestBytes, defineConsoleOperation, legacyEvent, optionalCount, optionalText, record, text } from "../../console/runtime/server/operations.ts"

import type { AnyOperation } from "@vite-hub/internal/operations"
import type { ConsoleAgentRealtimeLoader } from "../../console/internal.ts"

const agentsInvoke = defineConsoleOperation({
  cli: { command: "invoke", namespace: "agent", positional: ["agent"] },
  description: "Start an Agent Invocation with a prompt.",
  input: v.strictObject({
    agent: v.pipe(text, v.minLength(1)),
    agentRoute: v.optional(v.literal("encoded")),
    attachments: v.optional(v.array(v.object({ id: text, name: text }))),
    files: v.optional(v.array(v.object({ filename: optionalText, url: text }))),
    invokerProfileId: optionalText,
    messages: v.optional(v.array(record)),
    prompt: text,
  }),
  kind: "write",
  maxRequestBytes: consoleOperationRequestBytes["agents.invoke"],
  name: "agents.invoke",
  run: async ({ agent, agentRoute, ...body }, context) => (await import("./agent-invocations.post.ts")).default(legacyEvent(`agents/${agent}/invocations`, "POST", { agent, body, query: { agentRoute } }, context)),
  section: "agents",
})

const agentsList = defineConsoleOperation({
  cli: { command: "list", namespace: "agent" },
  description: "List the Agents of the app.",
  input: v.strictObject({}),
  kind: "read",
  name: "agents.list",
  run: async () => (await import("./agents.get.ts")).listConsoleAgents(),
  section: "agents",
})

const channelsReplay = defineConsoleOperation({
  cli: { command: "replay", namespace: "channels" },
  description: "Replay one page of a Channel's history through its trigger, or describe its history query with describe: true.",
  input: v.strictObject({
    agent: v.pipe(text, v.minLength(1)),
    channel: v.pipe(text, v.minLength(1)),
    cursor: optionalText,
    describe: v.optional(v.boolean()),
    dryRun: v.optional(v.boolean()),
    force: v.optional(v.boolean()),
    label: v.optional(v.pipe(text, v.check(label => label.trim() !== "", "Use a label with text."), v.maxLength(512))),
    limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
    query: v.optional(v.record(v.string(), v.union([text, v.array(text)]))),
  }),
  kind: "write",
  mcp: false,
  name: "channels.replay",
  readOnlyWhen: input => input.describe === true,
  run: async (input, context) => (await import("./channel-replay.ts")).replayConsoleChannel(input, context),
  section: "agents",
})

const invocationsCancel = defineConsoleOperation({
  cli: false,
  description: "Ask a running Agent Invocation to stop.",
  input: v.strictObject({ id: v.pipe(text, v.minLength(1)) }),
  kind: "write",
  name: "invocations.cancel",
  run: async ({ id }, context) => (await import("./invocation.get.ts")).default(legacyEvent("invocations", "POST", { body: { action: "cancel" }, id }, context)),
  section: "agents",
})

const invocationsUndo = defineConsoleOperation({
  cli: false,
  description: "Ask the person's open page to put back one change an Agent made there. The page restores it only while the field still shows the Agent's value.",
  input: v.strictObject({ change: v.pipe(text, v.minLength(1)), id: v.pipe(text, v.minLength(1)) }),
  kind: "write",
  name: "invocations.undo",
  run: async (input, context) => (await import("./invocation-page-undo.ts")).undoConsolePageChange(input, context),
  section: "agents",
})

const invocationsCapabilities = defineConsoleOperation({
  cli: false,
  description: "List the capabilities of an Agent Invocation setup.",
  input: v.strictObject({ agent: optionalText }),
  kind: "read",
  name: "invocations.capabilities",
  run: async input => (await import("./invocation-capabilities.get.ts")).listConsoleInvocationCapabilities(input),
  section: "agents",
})

const invocationsDelete = defineConsoleOperation({
  cli: false,
  description: "Delete one finished Agent Invocation.",
  input: v.strictObject({ id: v.pipe(text, v.minLength(1)) }),
  kind: "destructive",
  name: "invocations.delete",
  run: async ({ id }, context) => (await import("./invocation.get.ts")).default(legacyEvent("invocations", "POST", { body: { action: "delete" }, id }, context)),
  section: "agents",
})

const invocationsGet = defineConsoleOperation({
  cli: false,
  description: "Read one Agent Invocation with its observations.",
  input: v.strictObject({ id: v.pipe(text, v.minLength(1)), observationCount: optionalCount, observationCursor: optionalText }),
  kind: "read",
  name: "invocations.get",
  run: async ({ id, ...query }, context) => (await import("./invocation.get.ts")).default(legacyEvent("invocations", "GET", { id, query }, context)),
  section: "agents",
})

const invocationsList = defineConsoleOperation({
  cli: false,
  description: "List Agent Invocations, newest first.",
  input: v.strictObject({ agent: optionalText, capability: optionalText, cursor: optionalText, id: v.optional(v.array(text)), limit: optionalCount, triggeredBy: optionalText }),
  kind: "read",
  name: "invocations.list",
  run: async input => (await import("./invocations.get.ts")).listConsoleInvocations(input),
  section: "agents",
})

const invocationsWorkspace = defineConsoleOperation({
  cli: false,
  description: "Read the Workspace files and history of one Agent Invocation.",
  input: v.strictObject({ cursor: optionalText, history: v.optional(v.boolean()), id: v.pipe(text, v.minLength(1)), path: optionalText, ref: optionalText, revision: optionalText }),
  kind: "read",
  name: "invocations.workspace",
  run: async ({ id, history, ...query }, context) => (await import("./invocation-workspace.get.ts")).default(legacyEvent("invocation-workspace", "GET", { id, query: { ...query, history: history ? "1" : undefined } }, context)),
  section: "agents",
})

const searchQuery = defineConsoleOperation({
  cli: { namespace: "search", command: "query", positional: ["search"] },
  description: "Search the Agent Invocations of the Console.",
  input: v.strictObject({ cursor: optionalText, limit: optionalCount, search: optionalText }),
  kind: "read",
  name: "search.query",
  run: async input => (await import("./search.ts")).searchConsoleInvocations(input),
  section: "agents",
})

const skillsInspect = defineConsoleOperation({
  description: "Inspect the bundled Skill files of an Agent, or read one exact bundled text file.",
  input: v.strictObject({ agent: optionalText, path: optionalText }),
  kind: "read",
  name: "skills.inspect",
  run: async input => (await import("./skills.get.ts")).inspectConsoleSkills(input),
  section: "skills",
})

const statusGet = defineConsoleOperation({
  cli: false,
  description: "Read the status of an Agent: its setup and what it can do.",
  input: v.strictObject({ agent: optionalText }),
  kind: "read",
  name: "status.get",
  run: async (input, context) => (await import("./status.get.ts")).readConsoleStatus(legacyEvent("status", "GET", { query: input }, context)),
  section: "agents",
})

const invocationsUsage = defineConsoleOperation({
  cli: false,
  description: "Add up token use and cost evidence of Agent Invocations in the journal at request time. Same input and answer as usage.get.",
  input: v.strictObject({ agent: optionalText, cursor: optionalText, search: optionalText, status: optionalText, window: optionalText }),
  kind: "read",
  name: "invocations.usage",
  run: async (input, context) => (await import("./usage.get.ts")).readConsoleJournalUsageRoute(legacyEvent("usage", "GET", { query: input }, context)),
  section: "usage",
})

const usageGet = defineConsoleOperation({
  cli: { command: "usage", namespace: "agent" },
  description: "Read token use and cost evidence of Agent Invocations.",
  input: v.strictObject({ agent: optionalText, cursor: optionalText, search: optionalText, status: optionalText, window: optionalText }),
  kind: "read",
  name: "usage.get",
  run: async (input, context) => (await import("./usage.get.ts")).readConsoleUsage(legacyEvent("usage", "GET", { query: input }, context)),
  section: "usage",
})

/** The Console operations of the Agents, Skills, Usage, and Channels sections. The Console registers them only when the app has Agents. */
export const agentConsoleOperations: readonly AnyOperation[] = [
  agentsInvoke,
  agentsList,
  channelsReplay,
  invocationsCancel,
  invocationsCapabilities,
  invocationsDelete,
  invocationsGet,
  invocationsList,
  invocationsUndo,
  invocationsUsage,
  invocationsWorkspace,
  searchQuery,
  skillsInspect,
  statusGet,
  usageGet,
]

/** Lets the Console ask an open page to undo a change. The generated Console app module installs it only when the app has Realtime. */
export function installConsoleAgentRealtime(load: ConsoleAgentRealtimeLoader): void {
  consoleState().agentRealtime = load
}
