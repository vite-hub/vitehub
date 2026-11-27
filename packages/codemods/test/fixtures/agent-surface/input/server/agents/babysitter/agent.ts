import { defineAgent } from "vite-hub/agent"
import { babysitter } from "vite-hub/presets/babysitter"

export default defineAgent({
  preset: "babysitter",
  presets: { babysitter },
  workspace: {},
  options: { merge: false },
})
