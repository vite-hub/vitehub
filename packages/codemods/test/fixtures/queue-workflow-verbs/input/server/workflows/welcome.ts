import { createWorkflow } from "vite-hub/workflow"

const welcome = createWorkflow<{ email: string }>("welcome", async ({ payload }) => payload.email)

export const reminder = createWorkflow<{ email: string }>("reminder")

export async function startWelcome(email: string) {
  const run = await welcome.run({ email })
  await welcome.defer({ email })
  const deferred = await welcome.defer({ email }, { id: email })
  return [run, deferred, await createWorkflow("inline", async () => "ok").run()]
}
