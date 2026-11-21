import { defineWorkflow, type WorkflowProviderContext } from "vite-hub/workflow"

type RoundtripPayload = { marker: string }
type RoundtripResult = { marker: string }

async function durableRoundtrip({ payload }: WorkflowProviderContext<RoundtripPayload>): Promise<RoundtripResult> {
  "use workflow"

  return { marker: payload.marker }
}

export default defineWorkflow<RoundtripPayload>({
  handler: async ({ payload }): Promise<RoundtripResult> => ({ marker: payload.marker }),
  native: durableRoundtrip,
})
