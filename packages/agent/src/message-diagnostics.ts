import { defineDiagnostics } from "nostics"
import { agentDiagnosticOptions, dynamicAgentError } from "./agent-diagnostic-options.ts"

// Keep message helpers independent of provider diagnostics and schema initialization.
export const messageDiagnostics = defineDiagnostics({
  ...agentDiagnosticOptions,
  codes: {
    AGENT_R0646: dynamicAgentError,
    AGENT_R0647: dynamicAgentError,
    AGENT_R0648: dynamicAgentError,
    AGENT_R0649: dynamicAgentError,
    AGENT_R0650: dynamicAgentError,
    AGENT_R0651: dynamicAgentError,
    AGENT_R0652: dynamicAgentError,
    AGENT_R0653: dynamicAgentError,
    AGENT_R0654: dynamicAgentError,
    AGENT_R0655: dynamicAgentError,
    AGENT_R0656: dynamicAgentError,
    AGENT_R0657: dynamicAgentError,
    AGENT_R0658: dynamicAgentError,
    AGENT_R0659: dynamicAgentError,
    AGENT_R0660: dynamicAgentError,
    AGENT_R0661: dynamicAgentError,
    AGENT_R0662: dynamicAgentError,
    AGENT_R0663: dynamicAgentError,
    AGENT_R0664: dynamicAgentError,
    AGENT_R0665: dynamicAgentError,
    AGENT_R0666: dynamicAgentError,
    AGENT_R0667: dynamicAgentError,
    AGENT_R0668: dynamicAgentError,
  },
})
