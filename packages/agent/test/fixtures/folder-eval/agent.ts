import { defineAgent } from "../../../src/index.ts"

export default defineAgent({
  driver: { run: () => ({ text: "folder agent" }) },
})
