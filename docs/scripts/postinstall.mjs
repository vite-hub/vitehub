// Builds the workspace packages the docs import and generates the .nuxt types.
// CI jobs that never touch the docs set VITEHUB_SKIP_DOCS_PREPARE=1: in those
// jobs this hook took about 47 of the 90 seconds of dependency setup.
// Outside CI a failed step does not fail `pnpm install`: the dependencies are
// installed, and the contributor reruns the step after fixing the package.
import { spawnSync } from "node:child_process"

const steps = [
  ["vp", ["run", "--cache", "--filter", "@vite-hub/agent...", "--filter", "@vite-hub/ui...", "--filter", "@vite-hub/docs...", "--filter", "vite-hub...", "build"]],
  ["nuxi", ["prepare"]],
]

if (process.env.VITEHUB_SKIP_DOCS_PREPARE === "1") {
  console.log("Skipping the docs build and nuxi prepare (VITEHUB_SKIP_DOCS_PREPARE=1).")
}
else {
  for (const [command, args] of steps) {
    const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32" })
    if (result.status === 0) continue
    if (process.env.CI) {
      if (result.error) throw result.error
      process.exit(result.status ?? 1)
    }
    // The later steps need the earlier ones, so stop at the first failure.
    const reason = result.error ? result.error.message : `exit code ${result.status ?? result.signal}`
    console.warn([
      "",
      `[vitehub] The docs postinstall step \`${command} ${args.join(" ")}\` failed (${reason}).`,
      "The dependencies are installed. The docs site and its tests need this step.",
      "Fix the failing package, then run it again: corepack pnpm --dir docs run postinstall",
      "",
    ].join("\n"))
    break
  }
}
