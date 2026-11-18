/** Path of the default Agent Invocation journal file, relative to the ViteHub project root. */
export const defaultAgentInvocationsPath = ".vitehub/data/agent-invocations.sqlite"

/** Runtime env var that moves the default journal to another file or libSQL endpoint. */
export const defaultAgentInvocationsUrlEnv = "VITEHUB_AGENT_INVOCATIONS_DATABASE_URL"

/** Runtime env var with the auth token of a remote libSQL endpoint. */
export const defaultAgentInvocationsAuthTokenEnv = "VITEHUB_AGENT_INVOCATIONS_DATABASE_AUTH_TOKEN"

/**
 * `agent-invocations.sqlite` in the directory of a `file:` Agent State URL, where the default journal goes when it has
 * no URL of its own. `VITEHUB_AGENT_STATE_URL` replaces `stateUrl`, as it does for State. Undefined without `stateUrl`
 * and for remote or in-memory State. `cwd` marks a relative path, which resolves from the working directory as State does.
 */
export function agentJournalBesideState(stateUrl: string | undefined, env: Readonly<Record<string, string | undefined>>): { cwd?: true, url: string } | undefined {
  if (!stateUrl) return
  const state = env.VITEHUB_AGENT_STATE_URL?.trim() || stateUrl
  const path = /^file:([^?#]*)/i.exec(state)?.[1]
  if (!path || path === ":memory:" || /[?&]mode=memory(?:&|$)/.test(state)) return
  const url = `file:${path.slice(0, path.lastIndexOf("/") + 1)}agent-invocations.sqlite`
  return /^file:\//i.test(url) ? { url } : { cwd: true, url }
}
