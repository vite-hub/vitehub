import { defineDiagnostics } from "nostics"

import { formatUnknownAgentMessage } from "./registry-error.ts"

// Throw-only diagnostics. The CLI and model adapters choose how to report them.
export const agentDiagnostics = defineDiagnostics({
  docsBase: () => "https://vitehub.dev/docs/reference/errors-diagnostics#agent-diagnostics",
  codes: {
    AGENT_NOT_FOUND: {
      why: ({ name, available }: { name: string, available: string[] }) => formatUnknownAgentMessage(name, available, { prefix: true }),
      fix: "Use a discovered Agent name. Check the Agent Definition and the ViteHub Agent plugin configuration.",
    },
    AGENT_EXPORT_INVALID: {
      why: ({ name }: { name: string }) => `[vitehub] Agent "${name}" did not export a valid default agent.`,
      fix: "Export the result of defineAgent() as the default export of the Agent Definition.",
    },
    AGENT_DEFINITION_INVALID: {
      why: "[vitehub] Invalid agent definition.",
      fix: "Pass an Agent Definition created with defineAgent().",
    },
    AGENT_CAPABILITY_DEFINITION_INVALID: {
      why: "[vitehub] defineCapability() requires a capability definition.",
      fix: "Pass an object with a non-empty id to defineCapability().",
    },
    AGENT_CAPABILITY_ID_REQUIRED: {
      why: "[vitehub] Capability definitions require a non-empty string id.",
      fix: "Set the Capability id to a string that starts with a letter.",
    },
    AGENT_CAPABILITY_ID_INVALID: {
      why: ({ id }: { id: string }) => `[vitehub] Capability id "${id}" must be a stable identifier.`,
      fix: "Start the id with a letter. Use only letters, numbers, hyphens, underscores, and dots.",
    },
    AGENT_TRIGGER_NAME_REQUIRED: {
      why: ({ capability }: { capability: string }) => `[vitehub] Capability "${capability}" trigger names must be non-empty strings.`,
      fix: "Set each trigger name to a non-empty string that starts with a letter.",
    },
    AGENT_TRIGGER_NAME_INVALID: {
      why: ({ capability, name }: { capability: string, name: string }) => `[vitehub] Capability "${capability}" trigger "${name}" must be a stable local identifier.`,
      fix: "Start the trigger name with a letter. Use only letters, numbers, hyphens, and underscores.",
    },
    AGENT_CAPABILITY_MODE_INVALID: {
      why: ({ label }: { label: string }) => `[vitehub] ${label} mode must be "read" or "write".`,
      fix: 'Set mode to "read" or "write", or omit it to use "read".',
    },
    AGENT_CAPABILITIES_INVALID: {
      why: "[vitehub] defineAgent({ capabilities }) must be an ordered array.",
      fix: "Pass an array of Capabilities in execution order.",
    },
    AGENT_EXTENSION_NOT_COMPILED: {
      why: "[vitehub] Eve extensions must be compiled by the ViteHub Vite plugin.",
      fix: "Load the Agent Definition through a Vite host with the ViteHub Agent plugin installed.",
    },
    AGENT_CAPABILITY_DUPLICATE: {
      why: ({ id }: { id: string }) => `[vitehub] Duplicate capability id "${id}" in one agent.`,
      fix: "Remove the duplicate Capability or give each Capability a unique id.",
    },
    AGENT_CAPABILITY_DYNAMIC_UNSUPPORTED: {
      why: ({ id, unsupported }: { id: string, unsupported: string[] }) => `[vitehub] Invocation-resolved Capability "${id}" cannot contribute ${unsupported.join(", ")}. Attach definition-time behavior in a static capabilities array.`,
      fix: "Move triggers, workspaceSources, and chat access to a static capabilities array.",
    },
    AGENT_TOOL_POLICY_RETRYABLE: {
      why: ({ name }: { name: string }) => `[vitehub:agent] Tool "${name}" failed with a retryable policy decision.`,
      fix: "Retry the tool when its policy permits execution. Do not bypass the policy.",
    },
  },
})
