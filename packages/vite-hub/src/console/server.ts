import {
  createConsoleInvocations,
  createConsoleFixtureInvocations,
  getConsoleInvocations,
  getConsoleInvocationsDatabase,
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
import { getConsoleDatabase, installConsoleDatabase } from "./runtime/server/database.ts"

import type { ConsoleInvocationsDatabase } from "./runtime/server/invocations.ts"
import type { RuntimeHostContext } from "@vite-hub/runtime"

declare const __VITEHUB_APP_BASE_URL__: string

function consoleBaseURL(): string {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- The injected host base is optional in standalone package consumers, so the runtime boundary must detect its presence.
  const configured = typeof __VITEHUB_APP_BASE_URL__ === "undefined" ? "/" : __VITEHUB_APP_BASE_URL__
  const segments = configured.split("/").filter(Boolean)
  return segments.length ? `/${segments.join("/")}` : ""
}

export interface ConsoleInvocationLink {
  agentName: string
  id: string
}

export interface ConsoleRuntime {
  invocations: ConsoleInvocationsDatabase
  invocationUrl: (invocation: ConsoleInvocationLink | Record<string, unknown>) => string
}

export const console = {
  resolve(context: RuntimeHostContext<unknown>): ConsoleRuntime {
    return {
      invocations: getConsoleInvocationsDatabase(),
      invocationUrl(invocation) {
        const request = context.request
        if (!request) throw new TypeError("[vitehub] Console invocation URLs require a request context.")
        // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Invocation links accept records from external database adapters, so validate both required identities at this boundary.
        if (typeof invocation.agentName !== "string" || typeof invocation.id !== "string") {
          throw new TypeError("[vitehub] Console invocation URLs require an invocation with agentName and id.")
        }
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
  getConsoleDatabase,
  getConsoleInvocations,
  getConsoleInvocationsDatabase,
  getConsoleKV,
  getConsoleSections,
  getConsoleProjectName,
  installConsoleAgentDefinitions,
  installConsoleAgents,
  installConsoleFixtureInvocations,
  installConsoleDefinitions,
  installConsoleDatabase,
  installConsoleInvocations,
  installConsoleBlob,
  installConsoleKV,
  installConsoleProjectName,
  installConsoleSections,
}
