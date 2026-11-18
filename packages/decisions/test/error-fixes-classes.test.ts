import { fileURLToPath } from "node:url"

import { expect, it } from "vitest"

import { createDecisionsCliNamespace } from "../src/cli.ts"
import { decisionsDiagnostics } from "../src/diagnostics.ts"

const app = fileURLToPath(new URL("./fixtures/cli/app", import.meta.url))

it.each(["DECISIONS_CLI_ARGUMENTS_INVALID", "DECISIONS_CLI_CHOICES_NOT_FOUND"] as const)("gives %s a fix and its own docs page", (code) => {
  const error = decisionsDiagnostics[code]({ problem: "p" })
  expect(error.fix).toMatch(/\S/)
  expect(error.docs).toBe(`https://vitehub.dev/docs/decisions/diagnostics/${code.toLowerCase()}`)
})

it("prints the fix of a file that has no defineChoices() export", async () => {
  let stderr = ""
  const command = createDecisionsCliNamespace().features.find(item => item.name === "run")!
  const code = await command.run(["server/utils/missing.ts", "text"], {
    cwd: app,
    env: {},
    rootDir: app,
    spawn: async () => ({ exitCode: 0 }),
    stderr: { write: (chunk) => { stderr += String(chunk) } },
    stdout: { write: () => true },
  })
  expect(code).toBe(1)
  expect(stderr).toContain("server/utils/missing.ts is not a file.")
  expect(stderr).toContain("Fix: Run `vitehub decisions list`")
})
