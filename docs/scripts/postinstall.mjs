// Builds the workspace packages the docs import and generates the .nuxt types.
// CI jobs that never touch the docs set VITEHUB_SKIP_DOCS_PREPARE=1: in those
// jobs this hook took about 47 of the 90 seconds of dependency setup.
import { spawnSync } from "node:child_process"

const steps = [
  ["vp", ["run", "--cache", "--filter", "@vite-hub/agent...", "--filter", "@vite-hub/ui...", "--filter", "@vite-hub/docs...", "build"]],
  ["nuxi", ["prepare"]],
]

if (process.env.VITEHUB_SKIP_DOCS_PREPARE === "1") {
  console.log("Skipping the docs build and nuxi prepare (VITEHUB_SKIP_DOCS_PREPARE=1).")
}
else {
  for (const [command, args] of steps) {
    const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32" })
    if (result.error) throw result.error
    if (result.status !== 0) process.exit(result.status ?? 1)
  }
}
