/** Vite Development Server route that `vitehub agent invocations cancel` calls. */
export const agentInvocationsDevRoute = "/__vitehub/agent/invocations/dev"
/** ViteHub-owned path of the Nitro dev route. Catch-all handlers above it, such as the Console page at `/_vitehub/**`, do not conflict. */
export const agentInvocationsDevRuntimeNamespace = "/_vitehub/agent"
/** Nitro route that the dev endpoint forwards Invocation operations to. The route exists only in `vite dev`. */
export const agentInvocationsDevRuntimeRoute = `${agentInvocationsDevRuntimeNamespace}/invocations/dev`
export const agentInvocationsDevHeader = "x-vitehub-agent-invocations-dev"
export const agentInvocationsDevHeaderValue = "1"
export const agentInvocationsDevTokenServerHeader = "x-vitehub-agent-invocations-dev-server"

/** Guard that the Vite endpoint and the Nitro handler check on each request. */
export const agentInvocationsDevGuard: { header: string, headerValue: string, label: string } = {
  header: agentInvocationsDevHeader,
  headerValue: agentInvocationsDevHeaderValue,
  label: "Agent Invocations Dev",
}

/** Error code of the `501` response when the host does not run Nitro in the Vite process. */
export const agentInvocationsDevRuntimeUnavailableCode = "AGENT_INVOCATIONS_DEV_RUNTIME_UNAVAILABLE"
/** Message of the `501` response when the host does not run Nitro in the Vite process. */
export const agentInvocationsDevRuntimeUnavailableMessage = "This Vite Development Server does not run Nitro in process, so it cannot reach the Agent runtime. `vitehub agent invocations cancel` needs a Vite + Nitro host. Nuxt and plain Vite are not supported."

/** Body of a `POST` to the Agent Invocations dev endpoint. */
export interface AgentInvocationsDevRequestBody {
  id: string
  operation: "cancel"
}
