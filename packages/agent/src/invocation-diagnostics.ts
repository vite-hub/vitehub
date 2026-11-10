import { defineDiagnostics } from "nostics"
import { agentDocsBase, dynamicAgentError } from "./agent-diagnostic-options.ts"

// The browser client of Agent Invocations raises only these codes, so a page that lists invocations does not load the
// whole Agent catalog. It names the docs base instead of spreading the shared options: a bundle
// keeps a spread even when it drops the catalog.
export const invocationDiagnostics = /*#__PURE__*/ defineDiagnostics({
  docsBase: agentDocsBase,
  codes: {
    AGENT_R0609: dynamicAgentError,
    AGENT_R0610: dynamicAgentError,
    AGENT_R0611: dynamicAgentError,
    AGENT_R0612: dynamicAgentError,
    AGENT_R0613: dynamicAgentError,
    AGENT_R0614: dynamicAgentError,
    AGENT_R0615: dynamicAgentError,
    AGENT_R0616: dynamicAgentError,
    AGENT_R0617: dynamicAgentError,
  },
})
