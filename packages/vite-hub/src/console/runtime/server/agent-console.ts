import { resolvePublicUrl, type RuntimeHostContext } from "@vite-hub/runtime"
import { consoleInvocationUrl } from "@vite-hub/runtime/internal/console"

import { viteHubErrorDiagnostics } from "../../../error-diagnostics.ts"
import { encodeAgentRouteParam } from "../console-route.ts"

export interface ConsoleInvocationLink {
  agentName: string
  id: string
}

/** The Console Runtime Capability. Read the Agent Invocation journal with `getAgentInvocations()` from `vite-hub/agent`. */
export interface ConsoleRuntime {
  invocationUrl: (invocation: ConsoleInvocationLink | Record<string, unknown>) => string
}

/** Resolves the Console Runtime Capability of an Agent: the Console URL of an Agent Invocation. */
export const agentConsole = {
  resolve(context: RuntimeHostContext<unknown>): ConsoleRuntime {
    return {
      invocationUrl(invocation) {
        if (typeof invocation.agentName !== "string" || typeof invocation.id !== "string") {
          throw viteHubErrorDiagnostics.VITE_HUB_R0074({ message: "[vitehub] Console invocation URLs require an invocation with agentName and id." })
        }
        encodeAgentRouteParam(invocation.agentName)
        const origin = resolvePublicUrl({ agentName: invocation.agentName, request: context.request })
        if (!origin) throw viteHubErrorDiagnostics.VITE_HUB_R0073({ message: "[vitehub] Console invocation URLs require a request context or a `vitehub({ publicUrl })` origin. With several configured origins, the request host must be one of them." })
        return consoleInvocationUrl(origin, invocation.agentName, invocation.id)
      },
    }
  },
}
