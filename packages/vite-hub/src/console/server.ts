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
import { consoleInvocationUrl, resolvePublicUrl, type RuntimeHostContext } from "@vite-hub/runtime"
import { viteHubErrorDiagnostics } from "../error-diagnostics.ts"

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
        // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Invocation links accept records from external database adapters, so validate both required identities at this boundary.
        if (typeof invocation.agentName !== "string" || typeof invocation.id !== "string") {
          throw viteHubErrorDiagnostics.VITE_HUB_R0074({ message: "[vitehub] Console invocation URLs require an invocation with agentName and id." })
        }
        encodeAgentRouteParam(invocation.agentName) // Reject names the Console cannot route.
        const origin = resolvePublicUrl({ agentName: invocation.agentName, request: context.request })
        if (!origin) throw viteHubErrorDiagnostics.VITE_HUB_R0073({ message: "[vitehub] Console invocation URLs require `vitehub({ publicUrl })` or a request context." })
        return consoleInvocationUrl(origin, invocation.agentName, invocation.id)
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
