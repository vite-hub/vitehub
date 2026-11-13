import type { AgentInvocationJournal } from "../invocations.ts"
import type { AgentInput, AgentRuntimeConfig, AgentRuntimeContext } from "../types.ts"

type ReserveAgentChannelItem = <TRuntimeConfig extends AgentRuntimeConfig>(
  agent: AgentInput<AgentRuntimeContext<TRuntimeConfig>>,
  context: AgentRuntimeContext<TRuntimeConfig>,
) => Promise<AgentInvocationJournal<TRuntimeConfig> | undefined>

let reserve: ReserveAgentChannelItem | undefined

/** The root entry installs the reservation when it loads. It uses the Workflow dispatch helpers that only the root has. */
export function installAgentChannelItemReservation(value: ReserveAgentChannelItem): void {
  reserve = value
}

/** Claims the Invocation of one Channel item before a replay runs it. */
export const reserveAgentChannelItem: ReserveAgentChannelItem = async (agent, context) => {
  // Internal invariant: the Agent root installs the reservation callback before Channel replay can run.
  if (!reserve) throw new Error("[vitehub] The @vite-hub/agent root entry must load before a Channel replay.")
  return await reserve(agent, context)
}
