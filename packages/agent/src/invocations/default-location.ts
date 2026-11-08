/** Path of the default Agent Invocation journal file, relative to the ViteHub project root. */
export const defaultAgentInvocationsPath = ".vitehub/data/agent-invocations.sqlite"

/** Runtime env var that moves the default journal to another file or libSQL endpoint. */
export const defaultAgentInvocationsUrlEnv = "VITEHUB_AGENT_INVOCATIONS_DATABASE_URL"

/** Runtime env var with the auth token of a remote libSQL endpoint. */
export const defaultAgentInvocationsAuthTokenEnv = "VITEHUB_AGENT_INVOCATIONS_DATABASE_AUTH_TOKEN"
