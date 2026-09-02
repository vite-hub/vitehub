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

function consoleAppBaseURL(): string {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Vite replaces this build-time constant, while direct source imports leave it undeclared.
  const baseURL = typeof __VITEHUB_APP_BASE_URL__ === "undefined" ? "/" : __VITEHUB_APP_BASE_URL__
  return baseURL === "/" ? "" : `/${baseURL.replace(/^\/+|\/+$/g, "")}`
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
        return new URL(`${consoleAppBaseURL()}/_vitehub/agents/${agent}/invocations/${id}`, request.url).href
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
