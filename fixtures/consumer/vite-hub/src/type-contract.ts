import { vitehub } from "vite-hub"
import { defineAgent } from "vite-hub/agent"
import { env } from "vite-hub/env"
import { defineWorkflow } from "vite-hub/workflow"
import { defineWorkspace } from "vite-hub/workspace"

export const contract = {
  agent: defineAgent({
    runtime: false,
    driver: { run: () => ({ text: "typed" }) },
  }),
  env: env({ default: "typed" }),
  plugins: vitehub(),
  workflow: defineWorkflow(async ({ payload }: { payload: { marker: string } }) => payload.marker),
  workspace: defineWorkspace({ store: { provider: "memory" } }),
}
