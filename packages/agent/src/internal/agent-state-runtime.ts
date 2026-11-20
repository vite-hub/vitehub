import { agentDiagnostics } from "../agent-diagnostics.ts"
import { isWorkersRuntime } from "./workers-runtime.ts"

let warnedLocalDefault = false

/**
 * Whether the generated libSQL Agent State can open `url` in this runtime. workerd, the runtime of Cloudflare Workers
 * and of Nitro's `miniflare` dev runner, cannot open files, and the libSQL Web client rejects `file:` URLs. For the
 * local default file of `vite dev`, the app then runs without durable State, as the default journal runs in memory. A
 * `file:` URL that the app set throws `AGENT_STATE_FILE_URL_UNSUPPORTED`.
 */
export function opensLibsqlAgentState(url: string | undefined, options: { configured: boolean }): boolean {
  if (!url || !/^file:/i.test(url) || !isWorkersRuntime()) return true
  if (options.configured) throw agentDiagnostics.AGENT_STATE_FILE_URL_UNSUPPORTED({ url })
  if (!warnedLocalDefault) {
    warnedLocalDefault = true
    console.warn("[vitehub] Agent State is not kept on this dev runner: workerd cannot open the local SQLite file. Channel conversations stay in memory, and queued Channel tasks and triggers are off. Set agent.providers.state.url to a libSQL server URL, or run `vite dev` on a Node dev runner.")
  }
  return false
}
