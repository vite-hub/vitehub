import { defineDiagnostics } from "nostics"
import { agentDocsBase, dynamicAgentError } from "./agent-diagnostic-options.ts"

// The browser client of Agent Invocations raises only these codes, so a page that lists invocations does not load the
// whole Agent catalog. It names the docs base instead of spreading the shared options: a bundle
// keeps a spread even when it drops the catalog.
export const invocationDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: agentDocsBase,
  codes: {
    AGENT_R0609: {
      ...dynamicAgentError,
      fix: "Set useAgentInvocations({ baseURL }) to the Agent Invocations route of a ViteHub app that uses the same vite-hub version as the page, and reload the page after a deploy.",
    },
    AGENT_R0610: {
      ...dynamicAgentError,
      fix: "Set useAgentInvocations({ baseURL }) to the Agent Invocations route of a ViteHub app that uses the same vite-hub version as the page, and reload the page after a deploy.",
    },
    AGENT_R0611: {
      ...dynamicAgentError,
      fix: "Set useAgentInvocations({ baseURL }) to the Agent Invocations route of a ViteHub app that uses the same vite-hub version as the page, and reload the page after a deploy.",
    },
    AGENT_R0612: {
      ...dynamicAgentError,
      fix: "Set useAgentInvocations({ baseURL }) to the Agent Invocations route of a ViteHub app that uses the same vite-hub version as the page, and reload the page after a deploy.",
    },
    AGENT_R0613: {
      ...dynamicAgentError,
      fix: "Set useAgentInvocations({ baseURL }) to the Agent Invocations route of a ViteHub app that uses the same vite-hub version as the page, and reload the page after a deploy.",
    },
    AGENT_R0614: {
      ...dynamicAgentError,
      fix: "Set useAgentInvocations({ baseURL }) to the Agent Invocations route of a ViteHub app that uses the same vite-hub version as the page, and reload the page after a deploy.",
    },
    AGENT_R0615: {
      ...dynamicAgentError,
      fix: "Set useAgentInvocations({ baseURL }) to the Agent Invocations route of a ViteHub app that uses the same vite-hub version as the page, and reload the page after a deploy.",
    },
    AGENT_R0616: {
      ...dynamicAgentError,
      fix: "Set useAgentInvocations({ baseURL }) to the Agent Invocations route of a ViteHub app that uses the same vite-hub version as the page, and reload the page after a deploy.",
    },
    AGENT_R0617: {
      ...dynamicAgentError,
      fix: "Load the older Agent Invocations again. The request stopped before it finished.",
    },
  },
})
