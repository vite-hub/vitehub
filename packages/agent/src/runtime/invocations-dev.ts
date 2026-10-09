import agentRegistry from "#vitehub/agent/registry"
import { assertViteHubDevRequestGrant, validateViteHubNitroDevRequest } from "@vite-hub/internal/dev-endpoint"
import { isViteHubSecretEqual } from "@vite-hub/internal/secret"
import { redactInspectionText } from "@vite-hub/internal/inspect"
import { readWorkspaceDevToken, workspaceDevTokenHeader } from "@vite-hub/workspace/server"

import * as v from "valibot"

import { getAgentFromRegistry } from "../index.ts"
import { agentInvocationsDevGuard, agentInvocationsDevTokenServerHeader } from "../invocations-dev.ts"
import { isAgentInvocations } from "../invocations.ts"

import type { ViteHubDevRequestGrant } from "@vite-hub/internal/dev-endpoint"
import type { AgentInvocationsDevRequestBody } from "../invocations-dev.ts"
import type { AgentInvocationCancelResult, AgentInvocations } from "../invocations.ts"

function failure(message: string, status: number): Response {
  return Response.json({ error: { message: redactInspectionText(message) } }, { status })
}

const cancelRequestSchema = v.object({
  id: v.pipe(v.string(), v.trim(), v.nonEmpty()),
  operation: v.literal("cancel"),
})

async function readBody(request: Request): Promise<AgentInvocationsDevRequestBody | undefined> {
  const value: unknown = await request.json().catch(() => undefined)
  const parsed = v.safeParse(cancelRequestSchema, value)
  return parsed.success ? parsed.output : undefined
}

/**
 * Collects the Invocation journals of the Agent Definitions in the application registry. The registry is the same
 * module graph that runs the application's Agents, so the journals and the in-process abort handles are the same
 * objects that the running Invocations use.
 */
async function registeredInvocationJournals(): Promise<AgentInvocations[]> {
  const journals = new Set<AgentInvocations>()
  for (const name of Object.keys(agentRegistry)) {
    try {
      const journal: unknown = (await getAgentFromRegistry(name)).invocations
      if (isAgentInvocations(journal)) journals.add(journal)
    }
    catch {
      // An Agent Definition that cannot load has no Invocation to cancel.
    }
  }
  return [...journals]
}

class InvocationJournalAmbiguityError extends Error {}

async function cancelInJournals(request: Request, grant: ViteHubDevRequestGrant, journals: readonly AgentInvocations[], id: string): Promise<AgentInvocationCancelResult> {
  assertViteHubDevRequestGrant(grant, request)
  const matches: AgentInvocations[] = []
  let failure: unknown
  for (const journal of journals) {
    try {
      if (await journal.getSummary(id)) matches.push(journal)
    }
    catch (error) { failure ??= error }
  }
  if (matches.length > 1) {
    throw new InvocationJournalAmbiguityError("The ID matches multiple Agent invocation journals. Cancel through the intended Agent's invocations.cancel(id).")
  }
  if (failure) throw failure
  if (matches[0]) return await matches[0].cancel(id)
  return { id, outcome: "not-found" }
}

/**
 * Handles `vitehub agent invocations cancel` inside the Nitro dev runtime.
 *
 * The Vite endpoint forwards the request here, so the cancel reaches the application's own journals and abort
 * registry. The handler exists only in `vite dev`. The request must carry the Workspace dev token of `serverId`.
 * Without a `serverId`, every request is rejected.
 */
export async function handleAgentInvocationsDevRequest(request: Request, options: { rootDir?: string, serverId?: string } = {}): Promise<Response> {
  const { grant, rejection } = await validateViteHubNitroDevRequest(request, {
    ...agentInvocationsDevGuard,
    authorize: async (request) => {
      const serverId = request.headers.get(agentInvocationsDevTokenServerHeader)
      const authorized = Boolean(options.serverId) && serverId === options.serverId
        && isViteHubSecretEqual(request.headers.get(workspaceDevTokenHeader), await readWorkspaceDevToken(options.rootDir ?? process.cwd(), { serverId }))
      return authorized ? undefined : new Response("Forbidden Agent Invocations Dev token.", { status: 403 })
    },
  })
  if (!grant) return rejection
  const body = await readBody(request)
  if (!body) return failure("The Agent Invocations Dev request body is invalid.", 400)
  try {
    const journals = await registeredInvocationJournals()
    if (!journals.length) return failure("No Agent invocation journal is configured.", 404)
    return Response.json(await cancelInJournals(request, grant, journals, body.id))
  }
  catch (error) {
    return failure(`Agent Invocation cancel failed: ${error instanceof Error ? error.message : String(error)}`, error instanceof InvocationJournalAmbiguityError ? 409 : 500)
  }
}
