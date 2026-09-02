import {
  createConsoleInvocations,
  createConsoleFixtureInvocations,
  getConsoleInvocations,
  installConsoleFixtureInvocations,
  installConsoleInvocations,
} from "./runtime/server/invocations.ts"
import { encodeAgentRouteParam } from "./runtime/console-route.ts"
import {
  getConsoleAgents,
  installConsoleAgentDefinitions,
  installConsoleAgents,
} from "./runtime/server/agents.ts"
import { getConsoleProjectName, getConsoleSections, installConsoleProjectName, installConsoleSections } from "./runtime/server/sections.ts"
import { getConsoleKV, installConsoleKV } from "./runtime/server/kv.ts"
import { getConsoleBlob, installConsoleBlob } from "./runtime/server/blob.ts"
import { getConsoleDefinitions, installConsoleDefinitions } from "./runtime/server/definitions.ts"

import type { AgentInvocations } from "@vite-hub/agent"
import type { RuntimeHostContext } from "@vite-hub/runtime"

declare const __VITEHUB_APP_BASE_URL__: string

export interface ConsoleInvocationLink {
  agentName: string
  id: string
}

export interface ConsoleRuntime {
  invocations: AgentInvocations
  invocationUrl: (invocation: ConsoleInvocationLink) => string
}

function consoleBaseURL(): string {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The injected host base is optional in standalone package consumers, so the runtime boundary must detect its presence.
  const configured = typeof __VITEHUB_APP_BASE_URL__ === "undefined" ? "/" : __VITEHUB_APP_BASE_URL__
  const segments = configured.split("/").filter(Boolean)
  return segments.length ? `/${segments.join("/")}` : ""
}

export const console = {
  resolve(context: RuntimeHostContext<unknown>): ConsoleRuntime {
    const request = context.request
    return {
      invocations: getConsoleInvocations(),
      invocationUrl(invocation) {
        if (!request) throw new TypeError("[vitehub] Console invocation URLs require a request context.")
        const agent = encodeURIComponent(encodeAgentRouteParam(invocation.agentName))
        const id = encodeURIComponent(invocation.id)
        return new URL(`${consoleBaseURL()}/_vitehub/agents/${agent}/invocations/${id}`, request.url).href
      },
    }
  },
}

export {
  createConsoleInvocations,
  createConsoleFixtureInvocations,
  getConsoleBlob,
  getConsoleAgents,
  getConsoleDefinitions,
  getConsoleInvocations,
  getConsoleKV,
  getConsoleSections,
  getConsoleProjectName,
  installConsoleAgentDefinitions,
  installConsoleAgents,
  installConsoleFixtureInvocations,
  installConsoleDefinitions,
  installConsoleInvocations,
  installConsoleBlob,
  installConsoleKV,
  installConsoleProjectName,
  installConsoleSections,
}
