import { defineWorkflow, type WorkflowExecutionContext } from "vite-hub/workflow"

type RoundtripPayload = { marker: string }
type RoundtripResult = { marker: string }

async function durableRoundtrip({ payload }: WorkflowExecutionContext<RoundtripPayload>): Promise<RoundtripResult> {
  "use workflow"

  return { marker: payload.marker }
}

export default defineWorkflow<RoundtripPayload, RoundtripResult>(
  async ({ payload }) => ({ marker: payload.marker }),
  { native: durableRoundtrip },
)
