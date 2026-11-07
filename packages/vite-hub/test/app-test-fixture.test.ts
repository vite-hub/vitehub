import { execFile } from "node:child_process"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { expect, it } from "vitest"

const fixture = fileURLToPath(new URL("../fixtures/app-test", import.meta.url))
const vitest = join(dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "vitest.mjs")

// The fixture is an app as a developer writes it: Vitest reads its vite.config.ts with vitehub(), and its test
// calls a real route that uses KV, Database, Email, Queue, Workflow, Schedule, and Server Env through `vite-hub/test`, with no mocks.
it("runs an app's route test against the vite-hub/test backends", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [vitest, "run", "--reporter=verbose"], {
    cwd: fixture,
    // The child is its own Vitest run, so it gets none of this run's VITEST_* variables.
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("VITEST"))), CI: "1", NO_COLOR: "1" },
  })
  expect(stdout).toContain("signup saves the user, counts it, sends the welcome email, queues the follow-up, and starts the onboarding")
  expect(stdout).toContain("Tests  3 passed (3)")
}, 120_000)
