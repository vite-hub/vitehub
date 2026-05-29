import { defineAgent } from "../../../src/index.ts"

export default defineAgent({
  instructions: async ({ fs }) => await fs.readFile("AGENTS.md"),
  model: {} as never,
  workspace: {},
})
